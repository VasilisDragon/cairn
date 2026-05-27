# Reports

Evidence artifacts from live verifier runs and earlier offline calibration.

## Canonical acceptance set

[`overnight-phase2/iron-tier-reliability.md`](overnight-phase2/iron-tier-reliability.md)
is the canonical close-out matrix for iron-tier autonomous progression.
The five `iron_tier_verified` runs under `overnight-phase2/` are the
headline acceptance set. Per-run reports there carry `status:
iron_tier_verified` and `outcome: success` when the close-out criteria
(itemGoal.met, noBotDeath, pluginTelemetryClosed) hold.

## Earlier phase 1 reports

`overnight-phase1/` holds the earlier from-empty and constrained
iron-tier proofs. These predate the dedicated iron-tier verifier and
may preserve legacy `live_plan_*` status fields even when
`itemGoal.met=true`. They are retained as historical evidence, not
part of the headline acceptance set; the canonical matrix is the
authoritative claim.

## Other reports

Top-level files (advisor calibration, plugin telemetry, fishing/mining
soak captures, death recovery, capture-guard) are infrastructure proofs
from earlier phases. Each is self-contained; the canonical acceptance
claims live in the phase-prefixed subdirectories.
