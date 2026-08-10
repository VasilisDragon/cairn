package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class RawIronFuelAdmissionIntegrationSourceTest {
    private static final Path CLIENT_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "McbotFabricClient.java"
    );

    @Test
    void rawIronOpensTheFurnaceBeforeTrustingCarriedInputOrFuel() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String validation = method(source, "private String validateSmeltRecipeInputs(", "private int smeltBaselineInput(");

        assertTrue(validation.contains("recipe == FurnaceSmeltRecipe.CHARCOAL"));
        assertFalse(validation.contains("recipe == FurnaceSmeltRecipe.RAW_IRON"));
        assertFalse(validation.contains("smeltFuelCount(inventory)"));
        assertTrue(source.contains("if (inputSlotStack.isEmpty() && inventory.rawIron.itemCount() < 1)"));
        assertTrue(source.contains("FurnaceSmeltPlanner.desiredRawIronBatchSize(\n                    inputSlotStack.getCount()"));
    }

    @Test
    void rawFuelAdmissionPrecedesEveryNewInputClick() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String executor = method(source, "private ControlDecision resolveSmeltCharcoalControl(", "private ControlDecision completeSmeltCharcoal(");
        int preflight = executor.indexOf("beginRawIronFuelPreflight(");
        int inputSelection = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.SELECT_INPUT)");
        int inputClick = executor.indexOf("\"place_input_batch\"");

        assertTrue(preflight >= 0);
        assertTrue(inputSelection > preflight);
        assertTrue(inputClick > inputSelection);
        assertTrue(executor.contains("recipe == FurnaceSmeltRecipe.RAW_IRON && run.fuelAdmissionVerified"));
        assertTrue(executor.contains("markRawIronFuelAdmissionPrepared(run, furnaceHandler, inventory, nowMs)"));
    }

    @Test
    void verifiedRawInputPathNeverRechecksTheBurningFuelSlot() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String executor = method(source, "private ControlDecision resolveSmeltCharcoalControl(", "private ControlDecision completeSmeltCharcoal(");
        int returnInput = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.RETURN_INPUT_REMAINDER)");
        int selectFuel = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.SELECT_FUEL)", returnInput);
        String returnInputBlock = executor.substring(returnInput, selectFuel);

        assertTrue(returnInputBlock.contains("recipe == FurnaceSmeltRecipe.RAW_IRON && run.fuelAdmissionVerified"));
        assertTrue(returnInputBlock.contains("transitionSmeltCharcoalStage(run, SmeltControlPlanner.Stage.WAIT_OUTPUT"));
        assertFalse(returnInputBlock.substring(0, returnInputBlock.indexOf("} else {")).contains("loadedFuelCoversBatch"));
    }

    @Test
    void neutralUnavailableIsHandledBeforeGenericR5Success() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        int neutral = source.indexOf("\"smelt_raw_iron_complete:fuel_preflight_unavailable\".equals(reason)");
        int generic = source.indexOf("reason.startsWith(\"smelt_raw_iron_complete:\")", neutral);

        assertTrue(neutral >= 0);
        assertTrue(generic > neutral);
        assertTrue(source.contains("\"fuel_preflight_unavailable\"\n        );"));
    }

    @Test
    void disappearingFuelSourceReturnsNeutralBeforeAnyFuelPick() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String executor = method(source, "private ControlDecision resolveSmeltCharcoalControl(", "private ControlDecision completeSmeltCharcoal(");
        int pickStage = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.PICK_FUEL_STACK)");
        int placeStage = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.PLACE_FUEL)", pickStage);
        String pickBlock = executor.substring(pickStage, placeStage);
        int disposition = pickBlock.indexOf("RawIronFuelAdmissionPlanner.decideFuelSource(");
        int neutralCompletion = pickBlock.indexOf("completeRawIronFuelPreflightUnavailable(");
        int click = pickBlock.indexOf("\"pick_fuel_stack\"");

        assertTrue(disposition >= 0);
        assertTrue(neutralCompletion > disposition);
        assertTrue(click > neutralCompletion);
        assertTrue(pickBlock.substring(disposition, click).contains("return completeRawIronFuelPreflightUnavailable("));
        assertFalse(pickBlock.contains("place_input_batch"));
    }

    @Test
    void disappearingInputAfterFuelVerificationUsesTheNormalFailureChannel() throws IOException {
        String source = Files.readString(CLIENT_SOURCE);
        String executor = method(source, "private ControlDecision resolveSmeltCharcoalControl(", "private ControlDecision completeSmeltCharcoal(");
        int selectStage = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.SELECT_INPUT)");
        int pickStage = executor.indexOf("if (run.stage == SmeltControlPlanner.Stage.PICK_INPUT_STACK)", selectStage);
        String selectBlock = executor.substring(selectStage, pickStage);

        assertTrue(selectBlock.contains("RawIronFuelAdmissionPlanner.decideInputSource(run.fuelAdmissionVerified"));
        assertTrue(selectBlock.contains("RuntimeSourceDecision.NORMAL_FAILURE"));
        assertTrue(selectBlock.contains("return failSmeltCharcoal("));
        assertFalse(selectBlock.contains("completeRawIronFuelPreflightUnavailable("));
        assertFalse(selectBlock.contains("place_input_batch"));
    }

    private static String method(String source, String startToken, String endToken) {
        int start = source.indexOf(startToken);
        int end = source.indexOf(endToken, start + startToken.length());
        assertTrue(start >= 0, "missing start token " + startToken);
        assertTrue(end > start, "missing end token " + endToken);
        return source.substring(start, end);
    }
}
