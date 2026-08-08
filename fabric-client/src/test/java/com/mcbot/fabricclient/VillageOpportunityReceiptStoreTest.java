package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class VillageOpportunityReceiptStoreTest {
    @Test
    void recordsOnlyCommandCorrelatedBoundedFacts() {
        VillageOpportunityReceiptStore store = new VillageOpportunityReceiptStore();
        store.record(receipt(
            "receipt-1", "cmd-1", "container:abc", 7L,
            VillageOpportunityReceiptStore.Result.INSPECTED,
            Map.of("minecraft:iron_ingot", 3, "minecraft:bread", 2), 11L, 500L));

        VillageOpportunityReceiptStore.Receipt receipt = store.forCommand("cmd-1");
        assertEquals("container:abc", receipt.opportunityId());
        assertEquals("inspected", receipt.wireResult());
        assertEquals(3, receipt.knownContainerContents().get("minecraft:iron_ingot"));
        assertEquals(11L, receipt.containerRevision());
    }

    @Test
    void capsReceiptsAndContainerContentsDeterministically() {
        VillageOpportunityReceiptStore store = new VillageOpportunityReceiptStore();
        LinkedHashMap<String, Integer> contents = new LinkedHashMap<>();
        for (int i = 100; i >= 0; i--) {
            contents.put("minecraft:item_" + i, 1);
        }
        for (int i = 0; i < 80; i++) {
            store.record(receipt(
                "receipt-" + i, "cmd-" + i, "container:" + i, i,
                VillageOpportunityReceiptStore.Result.INSPECTED, contents, i, i));
        }

        assertEquals(VillageOpportunityReceiptStore.MAX_RECEIPTS, store.size());
        assertTrue(store.forCommand("cmd-0").commandId().isBlank());
        assertEquals(
            VillageOpportunityReceiptStore.MAX_CONTAINER_ITEMS,
            store.latest().knownContainerContents().size());
    }

    @Test
    void malformedReceiptCannotReplaceLatest() {
        VillageOpportunityReceiptStore store = new VillageOpportunityReceiptStore();
        store.record(receipt(
            "receipt", "cmd", "village:id", 1L,
            VillageOpportunityReceiptStore.Result.ARRIVED, Map.of(), 0L, 1L));
        store.record(receipt(
            "", "", "", 2L, VillageOpportunityReceiptStore.Result.UNSAFE,
            Map.of(), 0L, 2L));
        assertEquals("cmd", store.latest().commandId());
    }

    @Test
    void routeReplanCountIsBoundedToTheSinglePhysicalAllowance() {
        VillageOpportunityReceiptStore.Receipt receipt = receipt(
            "receipt", "cmd", "village:id", 1L,
            VillageOpportunityReceiptStore.Result.ARRIVED, Map.of(), 0L, 1L, 7);

        assertEquals(1, receipt.routeReplanCount());
    }

    private static VillageOpportunityReceiptStore.Receipt receipt(
        String receiptId,
        String commandId,
        String opportunityId,
        long opportunityRevision,
        VillageOpportunityReceiptStore.Result result,
        Map<String, Integer> contents,
        long containerRevision,
        long observedAtMs
    ) {
        return receipt(
            receiptId, commandId, opportunityId, opportunityRevision, result, contents,
            containerRevision, observedAtMs, 0);
    }

    private static VillageOpportunityReceiptStore.Receipt receipt(
        String receiptId,
        String commandId,
        String opportunityId,
        long opportunityRevision,
        VillageOpportunityReceiptStore.Result result,
        Map<String, Integer> contents,
        long containerRevision,
        long observedAtMs,
        int routeReplanCount
    ) {
        return new VillageOpportunityReceiptStore.Receipt(
            receiptId,
            "world",
            "minecraft:overworld",
            "deepseek_mission",
            "detour-1",
            1,
            commandId,
            "village_inspect_container",
            opportunityId,
            opportunityRevision,
            "inspect_container",
            result,
            result.name().toLowerCase(java.util.Locale.ROOT),
            "block:1,2,3",
            contents,
            Map.of(),
            Map.of(),
            containerRevision,
            routeReplanCount,
            observedAtMs
        );
    }
}
