# MCBot Test Harness Plugin

Private Paper test-server plugin for structured live scenario telemetry.

Status: PART B2 step 19 scaffold only.

This project intentionally contains no `/mcbottest` command implementation yet. Step 20 adds v0 lifecycle, spawn, snapshot, and assertion commands in separate checkpoints.

Build:

```powershell
$env:JAVA_HOME = "D:\Minecraft\Server\runtime\jdk-21.0.11+10"
.\gradlew.bat build
```

Scope guard:
- Dev/test server only.
- No production deployment.
- No HTTP endpoint, dashboard, aggregate metrics, or runtime bot telemetry channel in v0.
- One fixture migration per checkpoint after the plugin is running.

