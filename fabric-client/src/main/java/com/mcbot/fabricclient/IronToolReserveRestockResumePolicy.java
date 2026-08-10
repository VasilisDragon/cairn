package com.mcbot.fabricclient;

/**
 * Separates ordinary mining-workspace resumes from tool-reserve restock resumes.
 *
 * <p>A workspace transaction can remain resident across smelting and iron-tool crafting before
 * resuming a mining command.  That ordinary transaction has no reserve-restock context and must
 * not be rejected merely because there is no stone-pick craft to finalize.</p>
 */
final class IronToolReserveRestockResumePolicy {
    enum Outcome {
        ORDINARY_TRANSACTION,
        COMPLETE_RESTOCK,
        REJECT_STALE_CONTEXT
    }

    private IronToolReserveRestockResumePolicy() {
    }

    static Outcome classify(
        String restockCommandId,
        String transactionCommandId,
        String transactionAction,
        String transactionReason
    ) {
        String restock = normalize(restockCommandId);
        if (restock.isEmpty()) {
            return Outcome.ORDINARY_TRANSACTION;
        }
        String transaction = normalize(transactionCommandId);
        return restock.equals(transaction)
            && "craft_stone_pickaxe".equals(normalize(transactionAction))
            && "mission:MINE_IRON".equals(normalize(transactionReason))
            ? Outcome.COMPLETE_RESTOCK
            : Outcome.REJECT_STALE_CONTEXT;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim();
    }
}
