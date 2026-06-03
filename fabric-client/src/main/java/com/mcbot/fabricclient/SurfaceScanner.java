package com.mcbot.fabricclient;

import java.util.OptionalInt;
import java.util.function.IntPredicate;

/** Pure vertical surface scan order used by live world-backed perception. */
final class SurfaceScanner {
    private SurfaceScanner() {
    }

    static OptionalInt scan(int referenceY, int scanUp, int scanDown, IntPredicate isStandableAtY) {
        int boundedScanUp = Math.max(0, scanUp);
        int boundedScanDown = Math.max(0, scanDown);
        int maxOffset = Math.max(boundedScanUp, boundedScanDown);
        for (int offset = 0; offset <= maxOffset; offset++) {
            if (offset <= boundedScanUp) {
                int y = referenceY + offset;
                if (isStandableAtY.test(y)) {
                    return OptionalInt.of(y);
                }
            }
            if (offset > 0 && offset <= boundedScanDown) {
                int y = referenceY - offset;
                if (isStandableAtY.test(y)) {
                    return OptionalInt.of(y);
                }
            }
        }
        return OptionalInt.empty();
    }
}
