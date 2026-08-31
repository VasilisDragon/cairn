package com.mcbot.fabricclient;

import java.util.Objects;

/**
 * Runtime-owned authorization state for block mutations and block use.
 *
 * <p>The model deliberately does not infer trust from command names, stages, block names, or
 * single-player mode alone. Callers must supply a code-owned target capability and an explicit
 * world observation. The final sink separately supplies an authoritative current-position
 * protection result; unknown protection state and protected targets are never admitted.
 */
final class FabricWorldActionAuthorization {
    enum Capability {
        /** No code-owned claim was attached to the physical action. */
        UNSPECIFIED,
        /** The target is owned by the bot or explicitly configured by the operator. */
        OWNED,
        /** A naturally generated resource or terrain block in a disposable world. */
        NATURAL_RESOURCE,
        /** A naturally generated support, container, workstation, or bed in a disposable world. */
        NATURAL_ANCHOR
    }

    /** Immutable code-owned capability carried directly to the final physical sink. */
    record BlockAuthorization(Capability capability) {
        BlockAuthorization {
            capability = capability == null ? Capability.UNSPECIFIED : capability;
        }

        static BlockAuthorization unspecified() {
            return new BlockAuthorization(Capability.UNSPECIFIED);
        }

        static BlockAuthorization owned() {
            return new BlockAuthorization(Capability.OWNED);
        }

        static BlockAuthorization naturalResource() {
            return new BlockAuthorization(Capability.NATURAL_RESOURCE);
        }

        static BlockAuthorization naturalAnchor() {
            return new BlockAuthorization(Capability.NATURAL_ANCHOR);
        }
    }

    /**
     * Explicit world/session observation supplied by the client lifecycle owner.
     *
     * <p>Natural-world trust requires an exact fresh-world identity match and a world created for
     * this session. A restored development fixture has a separate, explicit capability bound to
     * its own expected identity; that capability never implies fresh-world or record eligibility.
     * Both modes additionally require integrated single-player mode and exactly one connected
     * player. A later observation may reduce trust but never elevate it for the same session.
     */
    record WorldObservation(
        String sessionIdentity,
        String worldIdentity,
        String freshWorldIdentity,
        String developmentFixtureWorldIdentity,
        boolean createdFreshWorld,
        boolean developmentFixtureAuthorized,
        boolean singlePlayer,
        int playerCount
    ) {
        WorldObservation {
            sessionIdentity = normalized(sessionIdentity);
            worldIdentity = normalized(worldIdentity);
            freshWorldIdentity = normalized(freshWorldIdentity);
            developmentFixtureWorldIdentity = normalized(developmentFixtureWorldIdentity);
            if (playerCount < 0) {
                throw new IllegalArgumentException("playerCount must be non-negative");
            }
        }
    }

    record ObservationResult(
        boolean sessionChanged,
        boolean disposableTrustActive,
        boolean disposableTrustRevokedNow,
        boolean physicalCancellationPending,
        boolean fixtureCommandsAllowed
    ) {
    }

    record Decision(boolean allowed, String reason) {
        Decision {
            reason = Objects.requireNonNull(reason, "reason");
        }

        static Decision allow(String reason) {
            return new Decision(true, reason);
        }

        static Decision deny(String reason) {
            return new Decision(false, reason);
        }
    }

    private record EpochState(
        boolean initialized,
        String sessionIdentity,
        String worldIdentity,
        boolean freshDisposableSessionDeclared,
        boolean developmentFixtureSessionDeclared,
        boolean exclusive,
        boolean integratedServerLanOpeningObserved,
        boolean disposableTrustRevoked
    ) {
    }

    private boolean initialized;
    private String sessionIdentity = "";
    private String worldIdentity = "";
    private boolean freshDisposableSessionDeclared;
    private boolean developmentFixtureSessionDeclared;
    private boolean exclusive;
    private boolean integratedServerLanOpeningObserved;
    private boolean disposableTrustRevoked;
    private boolean physicalCancellationPending;
    private boolean nextBlockWriteDenialPending;
    private long authorizationEpoch;

    synchronized ObservationResult observe(WorldObservation observation) {
        Objects.requireNonNull(observation, "observation");
        EpochState before = epochState();
        boolean newSession = !initialized
            || !sessionIdentity.equals(observation.sessionIdentity());
        boolean worldChangedWithinSession = initialized
            && !newSession
            && !worldIdentity.equals(observation.worldIdentity());
        boolean sessionChanged = newSession || worldChangedWithinSession;
        boolean revokedNow = false;
        if (newSession) {
            // A session/world revision can change during a dimension or loading
            // transition while the same client process remains alive.  A
            // multiplayer observation is sticky for that whole process: only
            // explicit lifecycle cleanup may reset it.
            boolean preserveRevocation = integratedServerLanOpeningObserved
                || (initialized && disposableTrustRevoked);
            boolean preservePhysicalCancellation = physicalCancellationPending;
            boolean preserveNextBlockWriteDenial = nextBlockWriteDenialPending;
            initialized = true;
            sessionIdentity = observation.sessionIdentity();
            worldIdentity = observation.worldIdentity();
            disposableTrustRevoked = preserveRevocation;
            physicalCancellationPending = preservePhysicalCancellation;
            nextBlockWriteDenialPending = preserveNextBlockWriteDenial;
            freshDisposableSessionDeclared = !preserveRevocation
                && freshDisposableDeclaration(observation);
            developmentFixtureSessionDeclared = !preserveRevocation
                && developmentFixtureDeclaration(observation);
        } else if (worldChangedWithinSession) {
            boolean hadTrustDeclaration = hasTrustDeclaration();
            worldIdentity = observation.worldIdentity();
            freshDisposableSessionDeclared = false;
            developmentFixtureSessionDeclared = false;
            if (hadTrustDeclaration) {
                revokedNow = revokeDisposableTrust();
            }
        } else if (hasTrustDeclaration() && !stillDeclaresSameAuthorizedWorld(observation)) {
            freshDisposableSessionDeclared = false;
            developmentFixtureSessionDeclared = false;
            revokedNow = revokeDisposableTrust();
        }

        exclusive = observation.singlePlayer() && observation.playerCount() == 1;
        if (observation.playerCount() > 1 && hasTrustDeclaration()) {
            revokedNow |= revokeDisposableTrust();
        }
        advanceEpochIfChanged(before);

        boolean active = disposableTrustActive();
        return new ObservationResult(
            sessionChanged,
            active,
            revokedNow,
            physicalCancellationPending,
            developmentFixtureCommandsAllowed()
        );
    }

    synchronized ObservationResult observeUnavailableWorld() {
        EpochState before = epochState();
        boolean revokedNow = false;
        if (hasTrustDeclaration()) {
            revokedNow = revokeDisposableTrust();
        }
        freshDisposableSessionDeclared = false;
        developmentFixtureSessionDeclared = false;
        exclusive = false;
        advanceEpochIfChanged(before);
        return new ObservationResult(
            false,
            false,
            revokedNow,
            physicalCancellationPending,
            false
        );
    }

    synchronized Decision preview(
        BlockAuthorization authorization,
        FabricTargetProtection.ProtectionState protectionState
    ) {
        return decide(authorization, protectionState, false);
    }

    synchronized Decision authorize(
        BlockAuthorization authorization,
        FabricTargetProtection.ProtectionState protectionState
    ) {
        return decide(authorization, protectionState, true);
    }

    /**
     * Consume an authorization only if no trust-relevant state changed since the caller's snapshot.
     * The current decision is evaluated first so do-not-touch and sticky revocation keep their
     * specific denial reasons and the one-shot post-revocation denial is consumed normally.
     */
    synchronized Decision authorizeAtEpoch(
        BlockAuthorization authorization,
        FabricTargetProtection.ProtectionState protectionState,
        long expectedEpoch
    ) {
        Decision current = decide(authorization, protectionState, true);
        if (current.allowed() && expectedEpoch != authorizationEpoch) {
            return Decision.deny("world_action_denied:authorization_epoch_changed");
        }
        return current;
    }

    synchronized long authorizationEpoch() {
        return authorizationEpoch;
    }

    synchronized boolean consumePhysicalCancellation() {
        boolean pending = physicalCancellationPending;
        physicalCancellationPending = false;
        return pending;
    }

    synchronized boolean fixtureCommandsAllowed() {
        return developmentFixtureCommandsAllowed();
    }

    /**
     * Re-check the authoritative integrated-server player count at the command sink.
     *
     * <p>A player can join after the client-tick observation but before a queued server command
     * executes. This check closes that interval and feeds the same sticky revocation/cancellation
     * state used by physical interactions.
     */
    synchronized boolean fixtureCommandsAllowedForPlayerCount(int playerCount) {
        observeAuthoritativePlayerCount(playerCount);
        return developmentFixtureCommandsAllowed();
    }

    synchronized boolean observeAuthoritativePlayerCount(int playerCount) {
        EpochState before = epochState();
        if (playerCount != 1) {
            exclusive = false;
        }
        if (playerCount > 1 && hasTrustDeclaration()) {
            revokeDisposableTrust();
        }
        advanceEpochIfChanged(before);
        return playerCount >= 0 && disposableTrustActive();
    }

    /**
     * Fail closed before an integrated server starts accepting LAN connections.
     *
     * <p>The open-to-LAN hook invokes this at the method head, before Minecraft exposes its
     * network listener. The same monitor guards the final client packet-emission sinks, so an
     * action either emits before LAN publication starts or observes the revocation and is denied.
     * The observation is sticky for the client process so a later world observation cannot
     * silently restore disposable-world trust.
     */
    synchronized boolean observeIntegratedServerLanOpening() {
        EpochState before = epochState();
        integratedServerLanOpeningObserved = true;
        boolean revokedNow = revokeDisposableTrust();
        advanceEpochIfChanged(before);
        return revokedNow;
    }

    synchronized boolean disposableTrustRevoked() {
        return disposableTrustRevoked;
    }

    synchronized void clear() {
        initialized = false;
        sessionIdentity = "";
        worldIdentity = "";
        freshDisposableSessionDeclared = false;
        developmentFixtureSessionDeclared = false;
        exclusive = false;
        integratedServerLanOpeningObserved = false;
        disposableTrustRevoked = false;
        physicalCancellationPending = false;
        nextBlockWriteDenialPending = false;
        advanceAuthorizationEpoch();
    }

    private Decision decide(
        BlockAuthorization supplied,
        FabricTargetProtection.ProtectionState protectionState,
        boolean consume
    ) {
        BlockAuthorization authorization = supplied == null
            ? BlockAuthorization.unspecified()
            : supplied;
        if (protectionState == null
            || protectionState == FabricTargetProtection.ProtectionState.UNKNOWN) {
            return Decision.deny("world_action_denied:protection_state_unavailable");
        }
        if (protectionState == FabricTargetProtection.ProtectionState.PROTECTED) {
            return Decision.deny("world_action_denied:do_not_touch");
        }
        if (nextBlockWriteDenialPending) {
            if (consume) {
                nextBlockWriteDenialPending = false;
            }
            return Decision.deny("world_action_denied:disposable_trust_revoked");
        }
        return switch (authorization.capability()) {
            case UNSPECIFIED -> Decision.deny("world_action_denied:missing_capability");
            case OWNED -> Decision.allow("world_action_allowed:owned");
            case NATURAL_RESOURCE, NATURAL_ANCHOR -> disposableTrustActive()
                ? Decision.allow(naturalTargetAllowanceReason())
                : Decision.deny("world_action_denied:natural_target_not_trusted");
        };
    }

    private boolean revokeDisposableTrust() {
        if (disposableTrustRevoked) {
            return false;
        }
        disposableTrustRevoked = true;
        physicalCancellationPending = true;
        nextBlockWriteDenialPending = true;
        return true;
    }

    private EpochState epochState() {
        return new EpochState(
            initialized,
            sessionIdentity,
            worldIdentity,
            freshDisposableSessionDeclared,
            developmentFixtureSessionDeclared,
            exclusive,
            integratedServerLanOpeningObserved,
            disposableTrustRevoked
        );
    }

    private void advanceEpochIfChanged(EpochState before) {
        if (!epochState().equals(before)) {
            advanceAuthorizationEpoch();
        }
    }

    private void advanceAuthorizationEpoch() {
        authorizationEpoch = authorizationEpoch == Long.MAX_VALUE
            ? Long.MIN_VALUE
            : authorizationEpoch + 1L;
    }

    private boolean disposableTrustActive() {
        return initialized
            && hasTrustDeclaration()
            && exclusive
            && !integratedServerLanOpeningObserved
            && !disposableTrustRevoked;
    }

    private boolean developmentFixtureCommandsAllowed() {
        return disposableTrustActive() && developmentFixtureSessionDeclared;
    }

    private boolean hasTrustDeclaration() {
        return freshDisposableSessionDeclared || developmentFixtureSessionDeclared;
    }

    private String naturalTargetAllowanceReason() {
        return developmentFixtureSessionDeclared
            ? "world_action_allowed:development_fixture_single_player"
            : "world_action_allowed:fresh_disposable_single_player";
    }

    private static boolean freshDisposableDeclaration(WorldObservation observation) {
        return !observation.sessionIdentity().isEmpty()
            && !observation.worldIdentity().isEmpty()
            && observation.worldIdentity().equals(observation.freshWorldIdentity())
            && observation.createdFreshWorld()
            && observation.singlePlayer();
    }

    private static boolean developmentFixtureDeclaration(WorldObservation observation) {
        return !observation.sessionIdentity().isEmpty()
            && !observation.worldIdentity().isEmpty()
            && observation.worldIdentity().equals(
                observation.developmentFixtureWorldIdentity()
            )
            && observation.developmentFixtureAuthorized()
            && observation.singlePlayer();
    }

    private boolean stillDeclaresSameAuthorizedWorld(WorldObservation observation) {
        boolean freshStillDeclared = !freshDisposableSessionDeclared
            || freshDisposableDeclaration(observation);
        boolean fixtureStillDeclared = !developmentFixtureSessionDeclared
            || developmentFixtureDeclaration(observation);
        return freshStillDeclared
            && fixtureStillDeclared
            && sessionIdentity.equals(observation.sessionIdentity())
            && worldIdentity.equals(observation.worldIdentity());
    }

    private static String normalized(String value) {
        return value == null ? "" : value.trim();
    }
}
