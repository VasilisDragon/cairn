package com.mcbot.fabricclient;

/** Build resources available to constructive navigation. */
record AgentBuildCapability(int blockBudget) {
    static final int MAX_BLOCK_BUDGET = 16;

    AgentBuildCapability {
        if (blockBudget < 0) {
            throw new IllegalArgumentException("blockBudget must be non-negative");
        }
        if (blockBudget > MAX_BLOCK_BUDGET) {
            throw new IllegalArgumentException("blockBudget exceeds " + MAX_BLOCK_BUDGET);
        }
    }
}
