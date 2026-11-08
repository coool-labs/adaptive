# Pi Adaptive

Under development — not yet published or release-ready.

Four native model-picker entries: `adaptive/auto`, `adaptive/quick`,
`adaptive/standard`, and `adaptive/advanced`. Tier entries select a capability
tier, not an individual provider. Selecting a real model bypasses Adaptive.

The initial integration reads `~/.pi/agent/adaptive/settings.json` (relative to
Pi's agent directory when customized). Settings use the shared `mode`, `tiers`,
and optional `pin` fields. No providers or model memberships are invented.
The default mode is observe. Interactive setup and durable recovery are not yet
implemented; see [the implementation plan](../../docs/plans/pi-plugin.md).

Model-level tool capability is absent from Pi's catalogue. Explicit declarations
live in `adaptive/capabilities.json` beside the settings file:

```json
{
  "models": [{ "providerID": "your-provider", "id": "your-model", "tools": true }]
}
```

Declare support only after verifying that model's tool calls. Missing declarations
remain unknown; `tools: false` explicitly excludes a model from tool-enabled
requests. Declarations do not add providers, tier memberships, or credentials.
Invalid files stop routing with field-specific feedback instead of guessing.
Real Pi SDK tests exercise a complete tool call and its same-model continuation.
Interactive capability setup, tier-request tools, and recovery are still pending;
do not use this development package for normal coding sessions yet.

Development checks: `npm run check -- --pkg pi`; runtime SDK and built-entry CLI
checks: `npm run verify -- --pkg pi`. The latter does not yet include all planned
release gates (minimum/latest matrix, production PTY UX, and durable recovery).
