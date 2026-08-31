package com.mcbot.fabricclient;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FabricWorldActionAuthorizationTest {
    private static final String SESSION = "fixture-session-1";
    private static final String WORLD = "opaque-world-1";
    private static final FabricTargetProtection.ProtectionState UNPROTECTED =
        FabricTargetProtection.ProtectionState.UNPROTECTED;

    @Test
    void unknownWorldIsOwnedOnlyAndMissingCapabilityFailsClosed() {
        FabricWorldActionAuthorization authorization =
            new FabricWorldActionAuthorization();

        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.unspecified(),
            UNPROTECTED).allowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
            UNPROTECTED).allowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
        assertTrue(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());
        assertFalse(authorization.fixtureCommandsAllowed());
    }

    @Test
    void doNotTouchOverridesEveryCapabilityWithoutConsumingAnotherDenial() {
        FabricWorldActionAuthorization authorization = freshExclusiveAuthorization();
        for (FabricWorldActionAuthorization.Capability capability
            : FabricWorldActionAuthorization.Capability.values()) {
            FabricWorldActionAuthorization.Decision protectedDecision = authorization.authorize(
                new FabricWorldActionAuthorization.BlockAuthorization(capability),
                FabricTargetProtection.ProtectionState.PROTECTED
            );
            assertFalse(protectedDecision.allowed());
            assertTrue(protectedDecision.reason().contains("do_not_touch"));
        }
        FabricWorldActionAuthorization.Decision unknownProtection = authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            FabricTargetProtection.ProtectionState.UNKNOWN
        );
        assertFalse(unknownProtection.allowed());
        assertTrue(unknownProtection.reason().contains("protection_state_unavailable"));
        assertTrue(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
            UNPROTECTED).allowed());
    }

    @Test
    void onlyExactFreshExclusiveWorldEnablesNaturalTargetsAndFixtures() {
        FabricWorldActionAuthorization restored = new FabricWorldActionAuthorization();
        restored.observe(observation(SESSION, WORLD, WORLD, false, true, 1));
        assertFalse(restored.fixtureCommandsAllowed());

        FabricWorldActionAuthorization wrongIdentity = new FabricWorldActionAuthorization();
        wrongIdentity.observe(observation(SESSION, WORLD, "different-world", true, true, 1));
        assertFalse(wrongIdentity.fixtureCommandsAllowed());

        FabricWorldActionAuthorization shared = new FabricWorldActionAuthorization();
        shared.observe(observation(SESSION, WORLD, WORLD, true, false, 1));
        assertFalse(shared.fixtureCommandsAllowed());

        FabricWorldActionAuthorization exclusive = freshExclusiveAuthorization();
        assertFalse(exclusive.fixtureCommandsAllowed());
        assertTrue(exclusive.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
            UNPROTECTED).allowed());
        assertTrue(exclusive.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
    }

    @Test
    void anotherPlayerStickyRevokesTrustCancelsAndDeniesNextBlockWrite() {
        FabricWorldActionAuthorization authorization = developmentFixtureAuthorization();
        assertTrue(authorization.fixtureCommandsAllowed());

        FabricWorldActionAuthorization.ObservationResult joined = authorization.observe(
            developmentObservation(SESSION, WORLD, true, true, 2));

        assertTrue(joined.disposableTrustRevokedNow());
        assertTrue(joined.physicalCancellationPending());
        assertFalse(joined.fixtureCommandsAllowed());
        assertTrue(authorization.disposableTrustRevoked());
        assertTrue(authorization.consumePhysicalCancellation());
        assertFalse(authorization.consumePhysicalCancellation());

        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            FabricTargetProtection.ProtectionState.PROTECTED).allowed());
        assertFalse(authorization.preview(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());
        assertTrue(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());

        authorization.observe(developmentObservation(SESSION, WORLD, true, true, 1));
        assertFalse(authorization.fixtureCommandsAllowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
    }

    @Test
    void commandSinkPlayerCountRecheckClosesThePostTickJoinRace() {
        FabricWorldActionAuthorization authorization = developmentFixtureAuthorization();

        assertTrue(authorization.fixtureCommandsAllowedForPlayerCount(1));
        assertFalse(authorization.fixtureCommandsAllowedForPlayerCount(0));
        assertFalse(authorization.fixtureCommandsAllowedForPlayerCount(1));
        authorization.observe(developmentObservation(SESSION, WORLD, true, true, 1));
        assertTrue(authorization.fixtureCommandsAllowedForPlayerCount(1));
        assertFalse(authorization.fixtureCommandsAllowedForPlayerCount(2));
        assertTrue(authorization.disposableTrustRevoked());
        assertTrue(authorization.consumePhysicalCancellation());
        assertFalse(authorization.fixtureCommandsAllowedForPlayerCount(1));
    }

    @Test
    void containerSlotPolicyIsReevaluatedAfterOpenForJoinProtectionAndOwnedFlow() {
        FabricWorldActionAuthorization joinedAfterOpen = freshExclusiveAuthorization();
        assertTrue(joinedAfterOpen.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
        assertFalse(joinedAfterOpen.observeAuthoritativePlayerCount(2));
        assertFalse(joinedAfterOpen.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());

        FabricWorldActionAuthorization protectedAfterOpen = freshExclusiveAuthorization();
        assertTrue(protectedAfterOpen.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
        assertFalse(protectedAfterOpen.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            FabricTargetProtection.ProtectionState.PROTECTED).allowed());

        FabricWorldActionAuthorization ownedOnly = new FabricWorldActionAuthorization();
        assertTrue(ownedOnly.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());
        assertTrue(ownedOnly.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());
    }

    @Test
    void authorizationEpochRejectsJoinAndExclusivityChangesAtTheFinalBoundary() {
        FabricWorldActionAuthorization natural = freshExclusiveAuthorization();
        FabricWorldActionAuthorization.BlockAuthorization naturalAnchor =
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor();
        long naturalEpoch = natural.authorizationEpoch();

        assertTrue(natural.preview(naturalAnchor, UNPROTECTED).allowed());
        assertTrue(natural.authorizeAtEpoch(
            naturalAnchor,
            UNPROTECTED,
            naturalEpoch
        ).allowed());
        natural.observe(observation(SESSION, WORLD, WORLD, true, true, 1));
        assertTrue(natural.authorizationEpoch() == naturalEpoch);

        assertFalse(natural.observeAuthoritativePlayerCount(2));
        assertTrue(natural.authorizationEpoch() != naturalEpoch);
        assertFalse(natural.authorizeAtEpoch(
            naturalAnchor,
            UNPROTECTED,
            naturalEpoch
        ).allowed());

        FabricWorldActionAuthorization owned = new FabricWorldActionAuthorization();
        owned.observe(observation(SESSION, WORLD, WORLD, false, true, 1));
        long ownedEpoch = owned.authorizationEpoch();
        assertTrue(owned.preview(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED
        ).allowed());
        assertFalse(owned.observeAuthoritativePlayerCount(0));
        assertTrue(owned.authorizationEpoch() != ownedEpoch);
        FabricWorldActionAuthorization.Decision staleOwned = owned.authorizeAtEpoch(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED,
            ownedEpoch
        );
        assertFalse(staleOwned.allowed());
        assertTrue(staleOwned.reason().contains("authorization_epoch_changed"));
    }

    @Test
    void lanPublicationInvalidatesEveryPendingNaturalMutationBeforeRemoteAdmission() {
        FabricWorldActionAuthorization.BlockAuthorization[] naturalCapabilities = {
            FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor()
        };
        for (FabricWorldActionAuthorization.BlockAuthorization natural : naturalCapabilities) {
            FabricWorldActionAuthorization authorization = freshExclusiveAuthorization();
            long openEpoch = authorization.authorizationEpoch();
            assertTrue(authorization.preview(natural, UNPROTECTED).allowed());

            assertTrue(authorization.observeIntegratedServerLanOpening());
            assertTrue(authorization.authorizationEpoch() != openEpoch);
            long publishedEpoch = authorization.authorizationEpoch();
            assertFalse(authorization.observeIntegratedServerLanOpening());
            assertTrue(authorization.authorizationEpoch() == publishedEpoch);
            assertFalse(authorization.authorizeAtEpoch(
                natural,
                UNPROTECTED,
                openEpoch
            ).allowed());
            assertFalse(authorization.authorizeAtEpoch(
                natural,
                UNPROTECTED,
                authorization.authorizationEpoch()
            ).allowed());
            assertTrue(authorization.authorizeAtEpoch(
                FabricWorldActionAuthorization.BlockAuthorization.owned(),
                UNPROTECTED,
                authorization.authorizationEpoch()
            ).allowed());
        }
    }

    @Test
    void lanPublicationBeforeFirstWorldObservationCannotBeReclassifiedAsDisposable() {
        FabricWorldActionAuthorization authorization = new FabricWorldActionAuthorization();
        long initialEpoch = authorization.authorizationEpoch();

        assertTrue(authorization.observeIntegratedServerLanOpening());
        assertTrue(authorization.authorizationEpoch() != initialEpoch);
        FabricWorldActionAuthorization.ObservationResult observed = authorization.observe(
            observation(SESSION, WORLD, WORLD, true, true, 1)
        );

        assertFalse(observed.disposableTrustActive());
        assertTrue(authorization.disposableTrustRevoked());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED
        ).allowed());
    }

    @Test
    void sharedOwnedOnlyWorldDoesNotInventDisposableRevocation() {
        FabricWorldActionAuthorization authorization = new FabricWorldActionAuthorization();
        FabricWorldActionAuthorization.ObservationResult observed = authorization.observe(
            observation(SESSION, WORLD, WORLD, false, false, 3));

        assertFalse(observed.disposableTrustRevokedNow());
        assertFalse(observed.physicalCancellationPending());
        assertFalse(authorization.consumePhysicalCancellation());
        assertTrue(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.owned(),
            UNPROTECTED).allowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
    }

    @Test
    void sameClientProcessCannotElevateAfterRevocationUntilLifecycleCleanup() {
        FabricWorldActionAuthorization authorization = freshExclusiveAuthorization();
        authorization.observe(observation(SESSION, WORLD, WORLD, true, true, 2));
        assertTrue(authorization.disposableTrustRevoked());

        FabricWorldActionAuthorization.ObservationResult newSession = authorization.observe(
            observation("fixture-session-2", WORLD, WORLD, true, true, 1));
        assertTrue(newSession.sessionChanged());
        assertFalse(newSession.disposableTrustActive());
        assertFalse(authorization.fixtureCommandsAllowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());

        authorization.clear();
        FabricWorldActionAuthorization.ObservationResult afterLifecycleCleanup = authorization.observe(
            observation("fixture-session-3", WORLD, WORLD, true, true, 1));
        assertTrue(afterLifecycleCleanup.disposableTrustActive());
        assertTrue(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
    }

    @Test
    void sameSessionCannotElevateAnInitiallyUntrustedWorld() {
        FabricWorldActionAuthorization authorization = new FabricWorldActionAuthorization();
        authorization.observe(observation(SESSION, WORLD, WORLD, false, true, 1));
        authorization.observe(observation(SESSION, WORLD, WORLD, true, true, 1));

        assertFalse(authorization.fixtureCommandsAllowed());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
    }

    @Test
    void unavailableWorldRevokesTrustAndCannotBeUsedToResetIt() {
        FabricWorldActionAuthorization authorization = developmentFixtureAuthorization();
        assertTrue(authorization.fixtureCommandsAllowed());

        FabricWorldActionAuthorization.ObservationResult unavailable =
            authorization.observeUnavailableWorld();
        assertTrue(unavailable.disposableTrustRevokedNow());
        assertTrue(unavailable.physicalCancellationPending());
        assertFalse(unavailable.fixtureCommandsAllowed());

        FabricWorldActionAuthorization.ObservationResult reloaded = authorization.observe(
            developmentObservation("fixture-session-after-load", WORLD, true, true, 1));
        assertFalse(reloaded.disposableTrustActive());
        assertFalse(authorization.fixtureCommandsAllowed());
    }

    @Test
    void restoredWorldNeedsExplicitIdentityBoundDevelopmentFixtureCapability() {
        FabricWorldActionAuthorization unarmed = new FabricWorldActionAuthorization();
        unarmed.observe(developmentObservation(SESSION, WORLD, false, true, 1));
        assertFalse(unarmed.fixtureCommandsAllowed());
        assertFalse(unarmed.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());

        FabricWorldActionAuthorization wrongWorld = new FabricWorldActionAuthorization();
        wrongWorld.observe(new FabricWorldActionAuthorization.WorldObservation(
            SESSION,
            WORLD,
            "",
            "different-world",
            false,
            true,
            true,
            1
        ));
        assertFalse(wrongWorld.fixtureCommandsAllowed());

        FabricWorldActionAuthorization armed = developmentFixtureAuthorization();
        assertTrue(armed.fixtureCommandsAllowed());
        assertTrue(armed.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
            UNPROTECTED).allowed());
        assertTrue(armed.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalAnchor(),
            UNPROTECTED).allowed());
    }

    @Test
    void changingWorldIdentityWithoutChangingSessionCannotGrantNewTrust() {
        FabricWorldActionAuthorization authorization = freshExclusiveAuthorization();
        FabricWorldActionAuthorization.ObservationResult changed = authorization.observe(
            observation(SESSION, "opaque-world-2", "opaque-world-2", true, true, 1));

        assertTrue(changed.sessionChanged());
        assertTrue(changed.disposableTrustRevokedNow());
        assertFalse(changed.disposableTrustActive());
        assertFalse(authorization.authorize(
            FabricWorldActionAuthorization.BlockAuthorization.naturalResource(),
            UNPROTECTED).allowed());
    }

    @Test
    void observationRejectsImpossiblePlayerCounts() {
        assertThrows(IllegalArgumentException.class, () ->
            observation(SESSION, WORLD, WORLD, true, true, -1));
    }

    private static FabricWorldActionAuthorization freshExclusiveAuthorization() {
        FabricWorldActionAuthorization authorization =
            new FabricWorldActionAuthorization();
        authorization.observe(observation(SESSION, WORLD, WORLD, true, true, 1));
        return authorization;
    }

    private static FabricWorldActionAuthorization developmentFixtureAuthorization() {
        FabricWorldActionAuthorization authorization =
            new FabricWorldActionAuthorization();
        authorization.observe(developmentObservation(SESSION, WORLD, true, true, 1));
        return authorization;
    }

    private static FabricWorldActionAuthorization.WorldObservation observation(
        String session,
        String world,
        String freshWorld,
        boolean createdFresh,
        boolean singlePlayer,
        int playerCount
    ) {
        return new FabricWorldActionAuthorization.WorldObservation(
            session,
            world,
            freshWorld,
            "",
            createdFresh,
            false,
            singlePlayer,
            playerCount
        );
    }

    private static FabricWorldActionAuthorization.WorldObservation developmentObservation(
        String session,
        String world,
        boolean authorized,
        boolean singlePlayer,
        int playerCount
    ) {
        return new FabricWorldActionAuthorization.WorldObservation(
            session,
            world,
            "",
            world,
            false,
            authorized,
            singlePlayer,
            playerCount
        );
    }
}
