package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Pins the executor authority and lifecycle seams around the pure safe-fall planner/controller.
 * These ordering guarantees are difficult to exercise without a live Minecraft client, so the
 * behavioral transition details remain in the pure tests while this class checks the production
 * wiring.
 */
class DescentSafeFallIntegrationSourceTest {
    private static final Path EXECUTOR_SOURCE = Path.of(
        "src", "main", "java", "com", "mcbot", "fabricclient", "DescentExecutor.java"
    );

    @Test
    void activeSafeFallOwnsAirborneTicksBeforeGenericGroundWait() throws IOException {
        String source = Files.readString(EXECUTOR_SOURCE);
        String resolve = method(source, "public ControlDecision resolve(");
        String active = method(source, "private ControlDecision resolveActiveSafeFallControl(");

        int activeDispatch = resolve.indexOf("if (run.safeFallController.active())");
        int handoffDispatch = resolve.indexOf("if (run.safeFallHandoffPending)", activeDispatch);
        int workspaceAdmission = resolve.indexOf("boolean workspacePolicyApplies", activeDispatch);
        int groundWait = resolve.indexOf(
            "if (preflightDecision.action() == DescentControlPlanner.Action.WAIT_ON_GROUND)",
            activeDispatch
        );

        assertTrue(activeDispatch >= 0, "active safe fall must have an unconditional dispatch");
        assertTrue(handoffDispatch > activeDispatch, "fall rejection handoff must follow active ownership");
        assertTrue(workspaceAdmission > handoffDispatch,
            "landing commitment must finish before terminal-depth workspace admission");
        assertTrue(groundWait > handoffDispatch, "active fall and its handoff must precede generic airborne stop");
        assertTrue(active.contains("run.safeFallController.tick("));
        assertFalse(active.contains("&& player.isOnGround()"), "airborne fall ticks cannot be ground-gated");
        assertFalse(source.contains("The airborne phase is handled by WAIT_ON_GROUND"));

        String apply = method(source, "private ControlDecision applySafeFallDecision(");
        String normalizedApply = apply.replaceAll("\\s+", " ");
        assertTrue(apply.contains("DescentSafeFallController.Action.HOLD_AIRBORNE"));
        assertTrue(apply.contains("&& !decision.columnCaptured()"));
        assertTrue(apply.contains("DescentSafeFallController.LAUNCH_FORWARD_SCALE"),
            "committed safe-fall launch must use its bounded forward throttle");
        assertTrue(normalizedApply.contains(
            "new InputState( true, false, false, false, false, false, "
                + "DescentSafeFallController.LAUNCH_FORWARD_SCALE, 0.0F )"
        ), "safe-fall launch must remain forward-only without back, strafe, jump, or sneak");
        assertFalse(apply.contains("player.setVelocity("),
            "safe-fall capture must not mutate player velocity");
    }

    @Test
    void clearanceAuthorityIsFrozenLeafOnlyAndRequiresVerifiedAir() throws IOException {
        String source = Files.readString(EXECUTOR_SOURCE);
        String clearance = method(source, "private ControlDecision resolveSafeFallClearance(");
        String normalized = clearance.replaceAll("\\s+", " ");

        int frozenCell = clearance.indexOf("VoxelCell clearanceCell = decision.clearanceCell()");
        int leafGate = clearance.indexOf("state.isIn(BlockTags.LEAVES)");
        int exactRaycastGate = clearance.indexOf("safeFallRaycastHitsBlock(");
        int breaker = clearance.indexOf("shell.blockBreakController().tick(");
        int actedBlockGate = clearance.indexOf("result.actedBlock() != null", breaker);
        int terminalBreakGate = clearance.indexOf(
            "result.status() != BlockBreakController.Status.BROKEN",
            actedBlockGate
        );
        int resample = clearance.indexOf("client.world.getBlockState(target).isAir()", terminalBreakGate);
        int fullRevalidation = clearance.indexOf("safeFallPackageStillValid(", resample);

        assertTrue(frozenCell >= 0);
        assertTrue(leafGate > frozenCell && exactRaycastGate > leafGate && breaker > exactRaycastGate,
            "the frozen cell must still be a leaf before break authority is invoked");
        assertTrue(normalized.contains("nowMs, false, 4_000L, false"),
            "safe-fall clearance must not receive log or terrain occluder authority");
        assertTrue(actedBlockGate > breaker);
        assertTrue(clearance.contains("!target.equals(result.actedBlock())"));
        assertTrue(terminalBreakGate > actedBlockGate && resample > terminalBreakGate,
            "only a terminal break plus world-resampled air may verify clearance");
        assertTrue(fullRevalidation > resample,
            "the complete frozen launch package must be revalidated after each leaf");
        assertFalse(clearance.contains("BlockTags.LOGS"));
        assertFalse(clearance.contains("maybeBeginMineThroughDescent("));
    }

    @Test
    void predepartureRejectionStopsThenHandsOffToExistingMineThroughOnce() throws IOException {
        String source = Files.readString(EXECUTOR_SOURCE);
        String admission = method(source, "private ControlDecision maybeBeginSafeFallForOpenAirGap(");
        String reject = method(source, "private ControlDecision rejectSafeFallBeforeDeparture(");
        String handoff = method(source, "private ControlDecision resolvePendingSafeFallHandoff(");
        String resolve = method(source, "public ControlDecision resolve(");

        int candidateGate = admission.indexOf("run.safeFallCandidateEvaluated");
        int evaluation = admission.indexOf("evaluateSafeFallLaunch(", candidateGate);
        int candidateLatch = admission.indexOf("run.safeFallCandidateEvaluated = true", evaluation);
        int acceptedBranch = admission.indexOf("if (evaluation.decision() == null", candidateLatch);
        assertTrue(candidateGate >= 0 && evaluation > candidateGate && candidateLatch > evaluation
            && acceptedBranch > candidateLatch,
            "one candidate evaluation must be consumed even when its frozen package rejects");
        assertTrue(admission.contains("run.safeFallEvaluation = evaluation.decision() == null"));
        assertTrue(admission.contains(": evaluation.decision().evaluation()"),
            "rejected planner geometry must survive until telemetry is emitted");

        int pending = reject.indexOf("run.safeFallHandoffPending = true");
        int clearActive = reject.indexOf("finishActiveSafeFall(run, true, true)", pending);
        int stopped = reject.indexOf("InputState.stop()", clearActive);
        assertTrue(pending >= 0 && clearActive > pending && stopped > clearActive);
        assertFalse(reject.contains("maybeBeginMineThroughDescent("),
            "the rejection tick must stop before attempting the fallback");
        assertFalse(reject.contains("failDescent("));
        assertTrue(reject.contains("DescentSafeFallLaunchPlanner.Evaluation evaluation"));
        assertTrue(reject.contains("evaluation == null ? null : evaluation.origin()"));
        assertTrue(reject.contains("evaluation == null ? null : evaluation.launchFeet()"));
        assertTrue(reject.contains("evaluation == null ? null : evaluation.launchHead()"));
        assertTrue(reject.contains("evaluation == null ? null : evaluation.dropColumn()"));
        assertTrue(reject.contains("evaluation == null ? null : evaluation.landing()"));
        assertTrue(reject.contains("evaluation == null ? 0 : evaluation.fallDepth()"));
        assertTrue(reject.contains("evaluation == null ? 0 : evaluation.expectedDamage()"));

        int clearPending = handoff.indexOf("run.safeFallHandoffPending = false");
        int originValidation = handoff.indexOf("boolean validOrigin", clearPending);
        int invalidOrigin = handoff.indexOf("if (!validOrigin)", originValidation);
        int limit = handoff.indexOf("run.safeFallHandoffCount >= 1", invalidOrigin);
        int increment = handoff.indexOf("run.safeFallHandoffCount++", limit);
        int existingFallback = handoff.indexOf("maybeBeginMineThroughDescent(", increment);
        assertTrue(clearPending >= 0 && originValidation > clearPending && invalidOrigin > originValidation
            && limit > invalidOrigin && increment > limit && existingFallback > increment);
        assertTrue(handoff.contains("if (fallback != null)"));
        assertTrue(handoff.contains("return failDescent("));
        assertFalse(handoff.contains("new DescentRun"));
        assertFalse(handoff.contains("run.startedAtMs ="));
        assertFalse(handoff.contains("run.commandId ="));

        int activeDispatch = resolve.indexOf("if (run.safeFallController.active())");
        int pendingDispatch = resolve.indexOf("if (run.safeFallHandoffPending)", activeDispatch);
        int ordinaryGroundWait = resolve.indexOf(
            "if (preflightDecision.action() == DescentControlPlanner.Action.WAIT_ON_GROUND)",
            pendingDispatch
        );
        assertTrue(activeDispatch >= 0 && pendingDispatch > activeDispatch && ordinaryGroundWait > pendingDispatch);
    }

    @Test
    void launchOriginDrynessIncludesPlayerFluidContact() throws IOException {
        String source = Files.readString(EXECUTOR_SOURCE);
        String sample = method(source, "private DescentSafeFallLaunchPlanner.Request sampleSafeFallLaunchRequest(");

        assertTrue(sample.contains("boolean originDry = isDryDescentBody(client, player, origin);"));
        assertFalse(sample.contains("boolean originDry = originFeetState.getFluidState().isEmpty()"),
            "block-only fluid checks miss a player whose hitbox is still touching water");
    }

    @Test
    void commandReplacementAndTerminalPathsClearEverySafeFallOwner() throws IOException {
        String source = Files.readString(EXECUTOR_SOURCE);
        String resolve = method(source, "public ControlDecision resolve(");
        String finish = method(source, "private void finishActiveSafeFall(");
        String clear = method(source, "private void clearSafeFallState(");
        String complete = method(source, "private ControlDecision completeDescent(");
        String fail = method(source, "private ControlDecision failDescent(");

        int commandChangeStart = resolve.indexOf("if (activeRun == null || !commandId.equals(activeRun.commandId))");
        String commandChange = balancedBlock(resolve, commandChangeStart);
        int commandClear = commandChange.indexOf("clearSafeFallState(activeRun, true)");
        int replacement = commandChange.indexOf("activeRun = new DescentRun(");
        assertTrue(commandClear >= 0 && replacement > commandClear,
            "old safe-fall state must be released before installing a replacement command");

        assertTrue(finish.contains("run.safeFallController.clear()"));
        assertTrue(finish.contains("run.safeFallPlan = null"));
        assertTrue(finish.contains("run.safeFallEvaluation = null"));
        assertTrue(finish.contains("run.safeFallClearanceStartedCell = null"));
        assertTrue(finish.contains("run.arrivalValidator.reset()"));
        assertTrue(finish.contains("run.safeFallExpectedDamage = 0.0F"));
        assertTrue(finish.contains("shell.blockBreakController().reset()"));

        assertTrue(clear.contains("finishActiveSafeFall(run, resetBreaker, true)"));
        assertTrue(clear.contains("run.safeFallAttempted = false"));
        assertTrue(clear.contains("run.safeFallCandidateEvaluated = false"));
        assertTrue(clear.contains("run.safeFallCandidateSignature = null"));
        assertTrue(clear.contains("run.safeFallHandoffPending = false"));
        assertTrue(clear.contains("run.safeFallHandoffReason = null"));
        assertTrue(clear.contains("run.safeFallRejectionReason = null"));
        assertTrue(clear.contains("run.safeFallHandoffCount = 0"));

        assertTrue(complete.contains("clearSafeFallState(run, true)"));
        assertTrue(fail.contains("clearSafeFallState(run, true)"));
    }

    private static String method(String source, String signature) {
        int start = source.indexOf(signature);
        assertTrue(start >= 0, () -> "missing method: " + signature);
        return balancedBlock(source, start);
    }

    private static String balancedBlock(String source, int start) {
        assertTrue(start >= 0, "missing source block");
        int open = source.indexOf('{', start);
        assertTrue(open >= 0, "missing opening brace");
        int depth = 0;
        for (int i = open; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return source.substring(start, i + 1);
            }
        }
        throw new AssertionError("unterminated source block");
    }
}
