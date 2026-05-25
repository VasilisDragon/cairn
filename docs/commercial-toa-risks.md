# Commercial TOA Risk Framing

Status: placeholder for eventual commercial-release review. This is not a launch policy and does not authorize public-server automation.

The intended use is private servers the user owns or is explicitly authorized to automate on, plus single-player worlds opened to LAN. The project must not market itself as a public-server cheating, griefing, item theft, or anti-cheat bypass tool.

Ban or moderation risk can still exist on third-party servers due to server-specific rules, anti-cheat configuration, administrator discretion, the user's prior account reputation, behavior around other players, and later rule changes. Humanization, observation priors, and anti-cheat invariants are best-effort plausibility and safety controls, not a guarantee of undetectability.

Any future billing model should make API usage and metered costs visible to the user. If payment fails, access should stop immediately and no automated work should continue.

Refunds related to third-party bans should not be guaranteed by default. The operator may choose to patch detection or safety issues reported by users, but cannot reverse moderation decisions made by another server.

Gameplay observations and server-specific priors are local-first. Raw observation logs and priors should stay under gitignored `data/` paths, should not be uploaded as raw logs, and must be deletable by the user at any time.

Before any commercial release, this placeholder needs legal review and an explicit terms-of-use document that preserves the private/authorized-server scope.
