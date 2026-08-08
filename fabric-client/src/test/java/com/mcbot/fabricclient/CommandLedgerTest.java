package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class CommandLedgerTest {
    @Test
    void boundedLedgerEvictsOldestIdentityAndRetainsRecentRetransmission() {
        CommandLedger ledger = new CommandLedger(3);
        ledger.markComplete("one", "one_complete");
        ledger.markComplete("two", "two_complete");
        ledger.markFailed("three", "three_failed");
        ledger.markComplete("four", "four_complete");

        assertEquals(3, ledger.size());
        assertFalse(ledger.isFinished("one"));
        assertTrue(ledger.isFinished("two"));
        assertTrue(ledger.isFinished("three"));
        assertEquals("four_complete", ledger.reason("four"));

        ledger.markComplete("two", "two_complete_again");
        assertEquals(3, ledger.size());
        assertEquals("two_complete_again", ledger.reason("two"));
    }

    @Test
    void lifecycleClearDropsAllBoundedState() {
        CommandLedger ledger = new CommandLedger(64);
        for (int index = 0; index < 100; index++) {
            ledger.markComplete("command-" + index, "complete");
        }
        assertEquals(64, ledger.size());
        assertFalse(ledger.isFinished("command-0"));
        assertTrue(ledger.isFinished("command-99"));
        ledger.clear();
        assertEquals(0, ledger.size());
        assertFalse(ledger.isFinished("command-99"));
    }
}
