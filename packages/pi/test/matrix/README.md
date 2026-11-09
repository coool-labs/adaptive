# Packed Pi host matrix

`npm run verify -- --pkg pi` builds and packs the package, then runs this matrix
through the `e2e:tui` gate. `check` and the normal unit suite never install hosts or
contact npm. For a focused run after building:

```sh
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" npm run e2e:tui --workspace packages/pi
```

`pi-host-matrix.json` requires Pi 1.5.0 and freshly resolved npm `latest`, each over
the SDK, actual JSON CLI, and Termwright PTY. An unavailable registry or unsupported
latest version fails the gate; it does not substitute an older cached version.
Version-pinned hosts are cached under `~/.cache/adaptive-pi-matrix` (the existing
1.5.0 spike installation is also reusable).

Every host installs the actual `npm pack` archive via `pi install npm:...` against
an ephemeral loopback registry. Registry requests and installed manifests prove
that optional peers did not install another host. Each child has an isolated HOME,
agent directory and npm cache, without inherited provider credentials. The faux
provider uses Pi's native implementation; no paid providers are called.

Evidence lives in `test-artifacts/pi-matrix/evidence.json`, with per-host SDK/JSON
logs, install evidence and terminal text captures alongside it. `testedUpTo` is
emitted only after both requested hosts pass all three surfaces, including when
minimum and latest resolve to the same version. A new run first invalidates the
previous claim. Evidence includes the packed archive integrity; it is not a claim
about a later rebuild. Runtime gates never edit source files or shipped version
metadata. Do not edit package sources while a full verify is reading them.

Current journeys cover virtual selection and defaults (`defaultProvider:
"adaptive"`, `defaultModel: "auto"`), global extension discovery in a child with
`--model adaptive/quick`, sticky tool continuation, compaction's real `direct`
request with active context and quick-tier dispatch, 503/429 redirect, quota
restart, auth rejection without retry, real picker selection, Ctrl+P cycling and
physical takeover. A fresh child avoids the preferred standard model after another
process records its 429, proving shared health across real processes. Host-only
fixture probes exercise widget/status rendering at
40/80 columns and the available Ctrl+Alt+A binding; these do **not** count as
Adaptive's unfinished M6 UX.

The production command/onboarding/status/shortcut journeys must be added when M6
lands. Packed all-down/parking/restart journeys must be finalized against M4.
Traceability remains a separate mandatory gate and reports missing requirements;
passing this matrix does not make unfinished milestones release-ready. Paid,
opt-in error capture is deliberately excluded, not treated as a bypass for the
deterministic error-corpus gate.
