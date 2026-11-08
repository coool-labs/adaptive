# Plan

Dependency-ordered. Each step lands with its tests; no step leaves dead scaffolding.

## Step 0 — Toolchain

Package scaffolding: strictest tsconfig, package.json with the four exports, vitest + coverage config, eslint (no-any, no-ts-ignore rules), prettier, MIT LICENSE, npm scripts incl. `verify`/`verify:release` composition points, CI workflow skeleton.

## Step 1 — Pure core foundations (no I/O)

1. `health/classifier` — error classification precedence chain + categories (ADP-008/009/010/011). Needs only data shapes.
2. `health/resource-health` + `circuit-breaker` — hierarchical state machine, draining, single-probe breaker with injected clock (ADP-007/019/021).
3. `health/capacity` — CapacitySensor boundary + reading merge rules (ADP-020).
4. `core/work-unit` — episode state machine over event inputs (ADP-001).
5. `core/tier-policy` — priority ladder, defer, tier adapter (ADP-002/003/004/005).
6. `core/compatibility` — gate over model/provider metadata (ADP-017).
7. `core/scheduler` — composition of the above into Decision unions (ADP-013/015/016/022 + property tests ADP-038).

## Step 2 — State and execution

8. `state/settings` — versioned settings, migration (ADP-036/005).
9. `state/receipts` + `state/parked-work` — bounded persistence (ADP-030/024).
10. `execution/retry` — retry-hook policy (ADP-013/014).
11. `execution/continuation` + `recovery` + `parking` — safe-boundary behavior (ADP-014/016/018/023/024).

## Step 3 — Adapters and wiring

12. `adapters/opencode` — event subscription, inventory, session ops, storage binding, switch tagging (research facts).
13. `adapters/codex-capacity` — passive-header sensor (ADP-020).
14. `rpc` — typed contracts (ADP-036).
15. `index.ts` — plugin setup wiring everything, fail-open wrapper (ADP-031/045).
16. Escalation signal mechanism — smallest typed Adaptive-owned request-for-escalation surface if OpenCode exposes a supported registration path; otherwise document precisely what the public API permits (GOAL allows this) and rely on structured evidence channels.

## Step 4 — Surfaces

17. `tui.tsx` + `ui/flow` — `/adaptive`, tiered editor, status, receipts view (ADP-033).
18. `gui.tsx` + `ui/gui` — SettingsPage, thin adapter (ADP-034/035).

## Step 5 — Test infrastructure

19. Deterministic fake provider fixture (ADP-039).
20. Integration tests across scheduler/health/state/adapter seams.
21. Packed-plugin tests (`@coool/opencode-plugin-test`, packed mode, 2.2.1/current/latest, server/tui/rpc) (ADP-040).
22. Real-host runtime E2E over the scenario list (ADP-041), incl. native `/goal` (ADP-025) and headless (ADP-045).
23. Playwright Web E2E (ADP-042) and Termwright TUI E2E (ADP-043), cross-surface sync (ADP-044).

## Step 6 — Release

24. Traceability gate (ADP-047) + coverage gate wiring (ADP-037).
25. Docs: README, CONTRIBUTING (regression policy ADP-046), CHANGELOG.
26. Packaging: npm pack / publish --dry-run / tarball inspection (ADP-048); CI completion (ADP-049); `verify:release` (ADP-050).
27. UI visual inspection pass against screenshots (GOAL §UI quality acceptance).
28. Final adversarial review; every defect found gets a failing-first regression test (ADP-046), full suite re-run.
29. `docs/PUBLISH_EVIDENCE.md` from real final output.

Key decision recorded up front: escalation-mechanism feasibility (Step 3.16) is a research-verified task — if OpenCode v2.2.5 lacks a supported plugin tool-registration path, the typed escalation surface ships only if the API supports it, with the limitation proven and documented rather than faked.
