# MCBot Test Harness Plugin

Private Paper test-server plugin for structured live scenario telemetry.

The plugin implements the private `/mcbottest` lifecycle, fixture, snapshot,
assertion, and reset commands used by the live test scripts.

Build:

Use JDK 21, then run `./gradlew.bat clean test build`. Dependency preparation
may use the network; the qualification build is run again with `--offline`.

Scope guard:
- Dev/test server only.
- A player is accepted only on an online-mode server when it has the explicit
  `mcbottest.use` permission and its authenticated UUID appears in
  `allowed-uuids`. Empty or malformed UUID lists deny every player. Player
  names and operator status are never authorization inputs.
- Console and authenticated RCON senders are accepted unless the
  `mcbottest/production-refuse` flag is present. The flag denies all senders.
- No production deployment.
- No HTTP endpoint, dashboard, aggregate metrics, or runtime bot telemetry channel in v0.
- One fixture migration per checkpoint after the plugin is running.
