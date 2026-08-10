package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** Guards the combat/hunt half of MQ-3's single interaction-writer contract. */
class EntityAttackInteractionSourceTest {
    private static final Path SOURCE_ROOT = Path.of(
        "src",
        "main",
        "java",
        "com",
        "mcbot",
        "fabricclient"
    );

    @Test
    void combatEmitsPostGazeGatedPulseAndOnlyAppliedReceiptAdvancesCadence()
        throws IOException {
        String source = source("CombatController.java");

        assertTrue(source.contains("InteractionDemand.attackEntity("));
        assertTrue(source.contains("FabricInteractionAuthority.Payload.entity("));
        assertTrue(source.contains("new FabricInteractionAuthority.EntityGate("));
        assertTrue(source.contains("MELEE_REACH,"));
        assertTrue(source.contains("ATTACK_ALIGN_DEG,"));
        assertTrue(source.contains("lastAttackMs + ATTACK_INTERVAL_MS,"));
        assertTrue(source.contains("void acknowledgeInteraction(InteractionAppliedReceipt receipt)"));
        assertTrue(source.contains("!receipt.applied()"));
        assertTrue(source.contains("!pending.requestId().equals(receipt.requestId())"));
        assertTrue(source.contains("lastAttackMs = receipt.timestampMs();"));
        assertTrue(source.contains("attackRequestSequence++;"));

        assertFalse(source.contains("interactionManager.attackEntity"));
        assertFalse(source.contains("swingHand("));
        assertFalse(source.contains("commitPendingAttack"));
    }

    @Test
    void huntEmitsPostGazeGatedPulseAndCountsOnlyAppliedMatchingReceipt()
        throws IOException {
        String source = source("HuntSheepExecutor.java");

        assertTrue(source.contains("InteractionDemand.attackEntity("));
        assertTrue(source.contains("FabricInteractionAuthority.Payload.entity("));
        assertTrue(source.contains("new FabricInteractionAuthority.EntityGate("));
        assertTrue(source.contains("HUNT_MELEE_REACH,"));
        assertTrue(source.contains("HUNT_ATTACK_ALIGN_DEG,"));
        assertTrue(source.contains("run.lastAttackMs + HUNT_ATTACK_INTERVAL_MS,"));
        assertTrue(source.contains("void acknowledgeInteraction(InteractionAppliedReceipt receipt)"));
        assertTrue(source.contains("!receipt.applied()"));
        assertTrue(source.contains("!pending.requestId().equals(receipt.requestId())"));
        assertTrue(source.contains("run.lastAttackMs = receipt.timestampMs();"));
        assertTrue(source.contains("run.attackRequestSequence++;"));
        assertTrue(source.contains("run.attacks++;"));

        assertFalse(source.contains("interactionManager.attackEntity"));
        assertFalse(source.contains("swingHand("));
        assertFalse(source.contains("commitPendingAttack"));
    }

    private static String source(String name) throws IOException {
        return Files.readString(SOURCE_ROOT.resolve(name));
    }
}
