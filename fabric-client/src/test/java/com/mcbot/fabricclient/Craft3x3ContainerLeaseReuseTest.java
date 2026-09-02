package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

final class Craft3x3ContainerLeaseReuseTest {
    @Test
    void reusePolicyFailsClosedWhenAnyIdentityOrEpochProofIsMissing() {
        assertTrue(FabricInteractionAuthority.reusableContainerAccessAllowed(
            true, true, true, true, true));
        for (int missing = 0; missing < 5; missing++) {
            boolean[] proof = {true, true, true, true, true};
            proof[missing] = false;
            assertFalse(FabricInteractionAuthority.reusableContainerAccessAllowed(
                proof[0], proof[1], proof[2], proof[3], proof[4]));
        }
    }

    @Test
    void adjacentCraftCommandReusesOnlyTheAuthorityOwnedBoundLease() throws IOException {
        String authority = Files.readString(sourcePath("FabricInteractionAuthority.java"));
        String client = Files.readString(sourcePath("McbotFabricClient.java"));
        String reuse = section(
            authority,
            "ReusableContainerAccess reusableContainerAccess(",
            "static boolean reusableContainerAccessAllowed("
        );
        String craft = section(
            client,
            "private ControlDecision resolveCraft3x3Control(",
            "private ControlDecision completeCraft3x3("
        );

        assertTrue(reuse.indexOf("synchronizeAuthoritativePlayerCount(client)")
            < reuse.indexOf("lease.authorizationEpoch()"));
        assertTrue(reuse.contains("authorizationWorld == client.world"));
        assertTrue(reuse.contains("worldAndPlayerIdentityMatches("));
        assertTrue(reuse.contains("player.currentScreenHandler == handler"));
        assertTrue(reuse.contains("handlerMatchesContainerKind(handler, lease.kind())"));
        assertTrue(reuse.contains("boundContainerIdentityMatches("));
        assertFalse(reuse.contains("clickSlot("));

        assertTrue(craft.contains("interactionAuthority.reusableContainerAccess("));
        assertTrue(craft.contains("activeCraft3x3.containerAccessRequestId = reusableAccess.requestId()"));
        assertTrue(craft.contains("activeCraft3x3.verifiedTableOpenTarget = reusableAccess.target()"));
        assertTrue(craft.contains("craft_close_unproven_table_screen"));
        assertTrue(craft.contains("run.containerAccessRequestId"));
    }

    private static Path sourcePath(String fileName) {
        return Path.of("src", "main", "java", "com", "mcbot", "fabricclient", fileName);
    }

    private static String section(String source, String startToken, String endToken) {
        int start = source.indexOf(startToken);
        int end = source.indexOf(endToken, start);
        assertTrue(start >= 0, "missing start token: " + startToken);
        assertTrue(end > start, "missing end token: " + endToken);
        return source.substring(start, end);
    }
}
