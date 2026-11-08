# Plan: reorganize the repo into a monorepo

Written 2026-11-08. The GitHub repo is now `coool-labs/adaptive`. This plan turns the
single-package repo into one repo with a shared core and two plugins. Nothing the
OpenCode plugin does should change along the way.

## Goals

1. **One shared core, two plugins.** `@coool/opencode-adaptive` (existing) and
   `@coool/pi-adaptive` (new) share the host-free routing, health, state and execution
   code.
2. **One command to release.** When the core changes, both plugins get a release with a
   single command. That command works out which packages changed, bumps the versions,
   writes the changelogs, runs the gates, publishes, tags and pushes.
3. **Easy for agents to test.** The same script names work at the root and inside every
   package. There is one fast inner-loop command. Output is short: a one-line verdict and
   only the end of the log on failure.
4. **No behaviour change for OpenCode users.** Each migration step ends with the full
   `verify:release` passing. The packed tarball is compared with a baseline taken before
   the move.

Out of scope: CI. The repo has none, and ADP-049 retired it. The local release command
stays the only gate.

## Key decisions

| Decision                   | Choice                                                                                                                                                                 | Why                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace tool             | **npm workspaces**                                                                                                                                                     | The repo already uses npm and a root `package-lock.json`. pnpm or turbo would add a second toolchain with no concrete gain at three packages.                                                                                             |
| How plugins get the core   | **Core is a private workspace package, bundled into each plugin's `dist`** with tsdown                                                                                 | Each tarball is self-contained, so packed tests work without publishing anything first. There are two public packages instead of three, and a plugin version fixes its core behaviour exactly. See "Rejected: publishing the core" below. |
| Bundler                    | **tsdown** (rolldown + bundled `.d.ts`) for the server, `tui` and `rpc` entries; the existing vite config stays for the GUI bundle                                     | tsc cannot inline a workspace dependency. tsdown also bundles declarations, so `dist/rpc.d.ts` does not reference the unpublished core.                                                                                                   |
| Dev resolution of the core | Core `exports` point straight at `src/**/index.ts`. The core has no build step and no `dist`.                                                                          | Every consumer (tsc, vitest, vite, tsdown) reads TypeScript, so agents never build the core before testing a plugin, go-to-definition lands in source, and tsdown inlines the same files. No custom export conditions to keep in sync.    |
| Versioning                 | Independent versions: OpenCode continues at 1.x, Pi starts at 0.1.0. The core is unversioned (`0.0.0`, `private: true`).                                               | A core change is released _through_ the plugins.                                                                                                                                                                                          |
| Tags                       | `opencode-adaptive@1.6.0`, `pi-adaptive@0.1.0`. The old `v1.x.y` tags stay and count as `opencode-adaptive` tags.                                                      | They sort per package and are what `git describe --match` needs.                                                                                                                                                                          |
| Requirements               | **One catalogue** (`docs/REQUIREMENTS.md`, ADP ids unchanged), with each requirement tagged `[both]`, `[opencode]` or `[pi]`. New Pi requirements continue at ADP-057. | No renumbering, and shared invariants are stated once. Traceability runs per package with an applicability filter.                                                                                                                        |
| Fake provider              | Moves into a private `packages/testkit` workspace                                                                                                                      | Both plugins' E2E suites need the same loopback provider (ADP-039).                                                                                                                                                                       |

### Rejected: publishing the core

Publishing `@coool/adaptive-core` with exact pins would keep tsc builds, but:

- Packed tests install the plugin tarball into an isolated host, so the pinned core version
  must already be on npm. You would publish the core before you could test the plugin.
- `bundleDependencies` on a symlinked workspace package is unreliable in npm.
- A third public package would carry an implied API promise that we do not want to keep.

If tsdown cannot reproduce the TUI's JSX output (step 4 checks this), fall back to this
option and teach `opencode-plugin-test` (our own package, `Hacklone/opencode-plugin-test`)
to install extra tarballs.

## Target layout

```text
adaptive/                          root: private, workspaces, repo tooling only
  package.json                     "workspaces": ["packages/core", "packages/testkit", "packages/opencode", "packages/pi"]
  tsconfig.base.json               the current strict compilerOptions
  eslint.config.js                 one config; per-package import boundaries
  biome.json, .prettierrc*, .gitignore
  vitest.config.ts                 projects: packages/*/vitest.config.ts (for `npm test` at the root)
  AGENTS.md                        repo-wide rules + command table
  README.md                        what Adaptive is, links to both plugins
  docs/
    PRODUCT.md                     host-neutral product contract (from GOAL/PRODUCT)
    REQUIREMENTS.md                ADP catalogue with [both|opencode|pi] tags
    ARCHITECTURE.md                new in step 6: packages, dependency rules, the core's public surface
    plans/                         this file, pi-plugin.md
    research/                      unchanged
  scripts/
    run.ts                         step runner behind check / verify (see "Agent ergonomics")
    affected.ts                    which packages a diff touches
    release/                       release CLI + pure planning logic (unit-tested)
    traceability.ts                generalized: --pkg, applicability filter (moved back up in step 2)
    pack-check.ts                  generalized: --pkg, per-package manifest of required files (moved back up in step 2)
    doctor.ts                      environment check
    test/                          tests for the scripts (vitest project "tooling")
  packages/
    core/                          @coool/adaptive-core   (private, bundled)
      src/routing/                 was src/core/  (scheduler, tier-policy, compatibility, work-unit types)
      src/health/                  classifier, resource-health, circuit-breaker, capacity
      src/state/                   settings, receipts, parked-work, session-modes, tier-requests, health, capacity
      src/execution/               continuation, escalation, parking, retry (decision types)
      src/flow/                    was src/ui/flow/ (the /adaptive dialog state machine, host copy injected)
      src/status/                  was src/rpc/status.ts (StatusSnapshot builder)
      src/sensors/codex-capacity/  was src/adapters/codex-capacity/ (pure header parsing)
      src/log.ts                   was src/supervisor/log.ts
      test/                        the matching tests, incl. fast-check property tests
      AGENTS.md                    "no host imports" + the public-surface rule
    testkit/                       @coool/adaptive-testkit (private): fake provider fixture + shared test helpers
    opencode/                      @coool/opencode-adaptive (published)
      src/  adapters/opencode, supervisor, rpc (definition + handlers), ui/gui, ui/tui, index.ts, tui.tsx, gui.tsx, rpc.ts
      test/ adapters, supervisor, rpc, integration, runtime-e2e, e2e-web, e2e-gui, e2e-tui, plugin-test, package.test.ts
      tsdown.config.ts, guiconfig.ts, vitest.config.ts (unit), vitest.e2e.config.ts (runtime E2E),
      playwright.config.ts, termwright.config.ts, plugin-test.config.json, pack-manifest.json
      CHANGELOG.md, README.md, LICENSE, AGENTS.md (OpenCode platform facts)
      docs/                        ARCHITECTURE (today's root file), TEST_STRATEGY, PUBLISH_EVIDENCE,
                                   PLAN, TASKS, COMPETITORS (the OpenCode build history)
    pi/                            @coool/pi-adaptive (published), see docs/plans/pi-plugin.md
```

`src/core/` is renamed to `src/routing/` because `packages/core/src/core/` is confusing.
Since every import is rewritten in step 4 anyway, the rename costs nothing extra.

### Core public surface

`packages/core/package.json` `exports` lists only the entries the plugins actually import.
This follows the repo rule against speculative exports:

```json
"exports": {
  "./routing": "./src/routing/index.ts",
  "./health": "./src/health/index.ts",
  "./state": "./src/state/index.ts",
  "./execution": "./src/execution/index.ts",
  "./flow": "./src/flow/index.ts",
  "./status": "./src/status/index.ts",
  "./sensors/codex-capacity": "./src/sensors/codex-capacity/index.ts",
  "./log": "./src/log.ts"
}
```

TypeScript-only targets are safe because the core is never loaded by plain Node: tests
run under vitest, and the published plugins contain the core inlined by tsdown. The core
package has no `build` script. Its `typecheck` script is `tsc --noEmit`.

`allowImportingTsExtensions` is not needed: plugins import `@coool/adaptive-core/routing`
(a package path), and core's own relative imports keep today's `.js` suffixes, which
NodeNext maps to `.ts`.

**Rule (in `packages/core/AGENTS.md`):** a core module that only one plugin uses moves
into that plugin. Shared code is extracted when the second plugin needs it, never in
advance. The OpenCode work-unit _tracker_ (`work-unit/tracker.ts`, `interruption.ts`)
is the first candidate: Pi has its own tracker keyed on `route()` reasons. It moves to
`packages/opencode` once the Pi tracker exists, and the shared `work-unit/types.ts`
stays in core.

### Import boundaries (enforced, not by convention)

These rules go into `eslint.config.js` as `no-restricted-imports` blocks scoped with
`files:` globs:

| Package                | Forbidden imports                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/core/**`     | `@opencode/*`, `@earendil-works/*`, `@opentui/*`, `solid-js`, `typebox`, and any `../` that leaves `packages/core` |
| `packages/opencode/**` | `@earendil-works/*`; deep core paths (`@coool/adaptive-core/src/*`); relative paths into other packages            |
| `packages/pi/**`       | `@opencode/*`, `@opentui/*`, `solid-js`; deep core paths; relative paths into other packages                       |
| `packages/*/src/**`    | `@coool/adaptive-testkit` (test-only)                                                                              |

Within each plugin, the existing rule stays the same: only the host adapter directory
touches the host SDK. It also becomes a lint block (`packages/opencode/src/**` except
`adapters/opencode/**`, `ui/**`, `index.ts`, `tui.tsx`, `gui.tsx`, `rpc.ts`).

## Agent ergonomics

Every package has the same script names. Root scripts fan out to the packages, or only
to the affected ones.

| Command (root)                                    | What it does                                                                                                                                                | When                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `npm test`                                        | vitest over every package's unit project (one process, all projects). Runtime E2E is not included; it runs in `verify`.                                     | anytime                                         |
| `npx vitest run packages/pi/test/router`          | one file or folder, run from the root                                                                                                                       | inner loop                                      |
| `npm run check`                                   | format:check → lint → lint:biome → typecheck → coverage, **only for packages affected by the working tree vs `main`** (a core change selects every package) | before saying "done"                            |
| `npm run check -- --all` / `--pkg pi`             | the same, forced scope                                                                                                                                      |                                                 |
| `npm run verify`                                  | full release gate for the affected packages: check + build + pack:check + packed/E2E suites + traceability                                                  | before a release (the release command calls it) |
| `npm run verify -- --pkg opencode --skip e2e:tui` | partial verify. A skipped step is printed in the verdict, never hidden.                                                                                     |                                                 |
| `npm run doctor`                                  | environment check: Node version, nvm Node 24 for termwright, OpenCode and Pi host caches, `npm whoami`                                                      | when something won't run                        |
| `npm run release:status`                          | which packages changed since their last tag, with commit counts                                                                                             |                                                 |
| `npm run release`                                 | the release flow (below)                                                                                                                                    |                                                 |

Inside a package, `npm test`, `npm run check`, `npm run coverage`, `npm run build` and
the package's own E2E scripts work the same and are scoped to that package.
`npm run test -w @coool/pi-adaptive` also works.

`scripts/run.ts` is the single runner behind `check`, `verify` and `release`. It:

- runs steps in a fixed order and stops at the first failure;
- writes each step's full output to `test-artifacts/run/<pkg>/<step>.log`;
- prints one line per step: `✓ pi lint 2.1s` / `✗ pi coverage — see test-artifacts/run/pi/coverage.log`;
- on failure, prints only the last 40 lines of the failing log (agents see the error, not
  thousands of passing lines);
- ends with a verdict line: `check: FAILED at coverage (pi)` or
  `check: ok (core, opencode, pi; skipped: none)`;
- knows the step-specific environment quirks, such as the Node 24 PATH prefix for
  `e2e:tui` that `verify-release.ts` has today.

`scripts/affected.ts` defines "affected": paths changed in `git diff main...HEAD`, plus
staged, unstaged and untracked files. The mapping is `packages/<x>/**` → x;
`packages/core/**` or `packages/testkit/**` → every plugin; root config
(`tsconfig.base.json`, `eslint.config.js`, `biome.json`, `package-lock.json`,
`scripts/**`) → everything. The logic is pure and covered by tests in `scripts/test/`.

**Vitest layout.** Each package's `vitest.config.ts` defines exactly one project (its unit
suite), so the root `projects: ["packages/*/vitest.config.ts", "scripts/vitest.config.ts"]`
glob stays flat. Today's nested `runtime-e2e` project moves to
`packages/opencode/vitest.e2e.config.ts` behind an `e2e:runtime` script, which `verify`
runs.

**Coverage stays at 100% per package.** Each package's `vitest.config.ts` has
`coverage.include: ["src/**"]` with 100/100/100/100 thresholds. Each package runs its own
coverage, so **core reaches 100% from core tests alone**, and plugin tests cannot quietly
cover core branches. If a core branch is only covered by supervisor tests today, the
extraction adds a core-level test. The gate is never weakened.

**AGENTS.md split.** The root keeps the product invariants, TypeScript conventions,
testing rules and the command table above, placed at the top. Each
`packages/<x>/AGENTS.md` keeps only what is specific to that package:

- **OpenCode:** the platform facts and the termwright Node constraint.
- **Pi:** the Pi API facts and version pins.
- **Core:** the dependency rule and the public-surface rule.

Agents read the nearest file.

## Release tooling

`npm run release` is the one command, and it is interactive by default:

1. **Plan.** Only packages without `"private": true` are considered. For each, find its
   last tag (opencode: `git describe --tags --abbrev=0 --match 'opencode-adaptive@*'
--match 'v*'`; pi: `--match 'pi-adaptive@*'`) and list the commits since then that
   touch that package, the core or the testkit. A package that has never been tagged
   counts every commit since its directory was created. Show:

   ```
   opencode-adaptive  1.5.0 → ?   4 commits (2 in core)
   pi-adaptive        0.1.0 → ?   7 commits (2 in core)
   ```

   A package with no changes is skipped. Core-only changes still select both plugins.

2. **Choose bumps.** Pick patch, minor or major per package. The default is patch and
   the prompt always asks; commit subjects here are `area: description`, so there is no
   reliable signal to infer a bump from. Flags skip the prompts:
   `--opencode minor --pi patch --yes`.
3. **Write version and changelog.** For each package, set `version` in
   `packages/<x>/package.json` and prepend a dated entry to `packages/<x>/CHANGELOG.md`.
   The entry has a hand-written summary (opened in `$EDITOR`, or `--notes file`) and an
   auto-generated **"Shared core"** list with the core commit subjects. The tag link
   footer is updated with `coool-labs/adaptive` URLs. The summary is also saved to
   `test-artifacts/release/notes-<pkg>.md`.
4. **Gate.** `npm run verify -- --pkg <selected>`, run on the bumped versions so
   `pack:check` and the packed tests see exactly what will be published. On failure the
   script restores the files it wrote in step 3 and stops with nothing committed. A
   rerun picks up the saved notes with `--notes`.
5. **Commit and tag.** Commit with the message
   `release: opencode-adaptive@1.6.0 pi-adaptive@0.1.1` and create one annotated tag per
   package.
6. **Publish.** Run `npm publish --workspace packages/<x>` in order. `stdio` is inherited,
   so npm's OTP prompt works.
7. **Push.** `git push --follow-tags`.

Other modes:

- `--dry-run` prints the plan and the changelog text, runs `npm publish --dry-run`, and
  writes nothing.
- `--resume` is for when one publish failed after the commit: it checks
  `npm view <name>@<version>` per package and publishes only what is missing.

The pure planning logic (tag lookup → commit sets → bump plan → changelog text) lives in
`scripts/release/plan.ts` with unit tests. The effects (git, npm, `$EDITOR`) are a thin
shell. This keeps the 100% rule meaningful for code that decides what gets published.

The release script refuses to run when:

- the working tree is dirty;
- the branch is not `main`;
- `npm whoami` fails;
- a selected package's `pack:check` manifest has a required file missing;
- or `@coool/adaptive-core` / `@coool/adaptive-testkit` appear in the tarball's `dist/`
  files or in its `dependencies`, `peerDependencies`, `optionalDependencies` or
  `bundleDependencies`, which would mean the core was not bundled. (They legitimately
  stay in `devDependencies`, which npm ignores for installs.)

The AGENTS.md rule "version bumps are commits named exactly after the version, tagged
`vX.Y.Z`" is replaced by "releases are made only with `npm run release`".

## Migration steps

Each step is one commit (or a short series). Each ends with all gates green, and none
changes runtime behaviour.

### Step 0 — rename fallout and baseline (S)

- Run `git remote set-url origin https://github.com/coool-labs/adaptive.git`.
- In `package.json`, set `repository.url` to `git+https://github.com/coool-labs/adaptive.git`.
- Rewrite the CHANGELOG link footer to the new repo URL.
- Grep for other `opencode-adaptive` _repo_ mentions: README badges and links, and docs.
  The npm name `@coool/opencode-adaptive` stays.
- **Baseline:** after the edits above, run `npm run verify:release` on the current layout.
  Save:
  - `tar -tzf` of the packed tarball → `test-artifacts/baseline/pack-listing.txt`
  - the vitest test count → `test-artifacts/baseline/tests.txt`
  - `dist/` file hashes → `test-artifacts/baseline/dist.sha`
- Commit: `repo: point at coool-labs/adaptive`.

### Step 1 — move the plugin into `packages/opencode` (M)

- `git mv` into `packages/opencode/`: `src`, `test`, all of `scripts/` (the moved
  `package.json` scripts call `pack-check.ts`, `traceability.ts` and `verify-release.ts`),
  `guiconfig.ts`, `vitest.config.ts`, `playwright.config.ts`, `termwright.config.ts`,
  `plugin-test.config.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md` and
  `CHANGELOG.md`. `git mv` keeps `git log --follow` history.
- `git mv` the OpenCode-specific docs into `packages/opencode/docs/`: `ARCHITECTURE.md`
  (today's file describes the OpenCode module layout), `TEST_STRATEGY.md`,
  `PUBLISH_EVIDENCE.md`, `PLAN.md`, `TASKS.md` and `COMPETITORS.md`. `PRODUCT.md`,
  `REQUIREMENTS.md`, `research/` and `plans/` stay at the root.
- Copy `LICENSE` into `packages/opencode/` (npm packs it from the package directory; the
  root keeps its own).
- `traceability.ts` reads `../../docs/REQUIREMENTS.md` until step 2 moves it back to the
  root. Fix doc links that pointed between moved and unmoved docs.
- The root `package.json` becomes `{ "private": true, "workspaces": [...] }` with
  delegating scripts. The current `package.json` moves to `packages/opencode/package.json`
  unchanged, apart from `repository.directory: "packages/opencode"`.
- Config discovery: ESLint (flat config), Prettier and Biome all search upward from the
  file, so the root configs keep applying to `packages/opencode/**`. Confirm by running
  each tool from the package directory and checking it reports the same files as from the
  root. The package's `tsconfig.json` stays self-contained until step 2.
- Devdependency split. The root keeps the shared tooling:
  - `typescript`, `eslint`, `typescript-eslint`, `@eslint/js`, `eslint-config-prettier`
  - `prettier`, `@biomejs/biome`, `vitest`, `@vitest/coverage-v8`, `vite-node`
  - `fast-check`, `@types/node`

  The opencode package keeps everything host- or surface-specific (`@opencode/plugin`,
  `@opentui/*`, `solid-js`, playwright, termwright, `opencode-plugin-test`, jsdom, vite
  plugins). `allowScripts` moves to the root.

- Fix path assumptions. Each is a known lookup, so grep for `process.cwd()`,
  `test-artifacts`, `dist/` and `import.meta.dirname`:
  - `test/runtime-e2e/helpers.ts:18,23`
  - `test/package.test.ts:20,26,42`
  - `scripts/pack-check.ts`
  - the e2e configs
  - `.gitignore` globs (`packages/*/dist`, `packages/*/coverage`, `**/test-artifacts`)
- Regenerate `package-lock.json` from scratch (`rm -rf node_modules package-lock.json && npm install`).
  Then check that solid-js resolves to one copy (`npm ls solid-js`), because the vitest
  aliases depend on it.
- **Exit:** `npm run verify:release -w @coool/opencode-adaptive` is green, the test count
  equals the baseline, the pack listing is **byte-identical** to the baseline, and the
  `dist/` hashes match `dist.sha` except for `.map` files (their `sources` paths may
  change with the directory depth; pack-check still proves the sources are embedded).
- Commit: `monorepo: move OpenCode plugin to packages/opencode`.

### Step 2 — root tooling (M)

- Add `tsconfig.base.json` (today's compilerOptions). Package tsconfigs extend it. Root
  `eslint.config.js` and `biome.json` gain package globs.
- Split opencode's `runtime-e2e` vitest project into `vitest.e2e.config.ts`
  (`e2e:runtime` script), then add the root `vitest.config.ts` with the flat projects
  glob. `npm test` count = baseline minus the runtime E2E tests, which `verify` now runs
  separately; the two counts together must equal the baseline.
- Add `scripts/run.ts`, `scripts/affected.ts` and `scripts/doctor.ts` at the root, with
  tests in the `scripts/test/` tooling project. `verify-release.ts` becomes
  `run.ts verify --all`, and the old script is deleted.
- Move `traceability.ts` and `pack-check.ts` back up to the root `scripts/` (`git mv`)
  and generalize them: traceability gets `--pkg` and applicability tags, pack-check gets
  `--pkg` and reads its required-file list from `packages/<x>/pack-manifest.json`.
- Rewrite the root AGENTS.md command table and CONTRIBUTING to match.
- **Exit:** `npm run check -- --all` and `npm run verify -- --all` are green.

### Step 3 — prepare the seams while still one package (M)

Before extraction, make the to-be-core set import only from inside itself. The set
is `core/`, `health/`, `state/`, `execution/`, `ui/flow/`, `rpc/status.ts`,
`supervisor/log.ts` and `adapters/codex-capacity/`. Today's violations, all of them
type-level:

- `ui/flow/controller.ts` imports `TierRequestSetResult` from `rpc/handlers.ts`. Move that
  type (and any other result types the flow uses) to `state/tier-requests/types.ts`.
- `rpc/handlers.ts` imports `supervisor/log.ts`. That is fine, since log moves to core.
- Host copy in the flow:
  - `INVITE_TITLE = "OpenCode Adaptive"`
  - "Search OpenCode models" (`tiers.ts:40`)
  - the receipt explanations that say "left the choice to OpenCode" (`receipts.ts:106-111`)

  Add a `copy: HostCopy` field to `AdaptiveEnv`: `inviteTitle`, `modelSearchPlaceholder`,
  and `receiptExplanation(reason)` for the host-dependent receipt reasons
  (`routing-defer`, `adaptive-off`, `pinned-unverified`, `pinned-incompatible`). These
  are whole sentences supplied by the host, not a `hostName` slot: in OpenCode "defer"
  means "OpenCode's own choice stands", while in Pi it means "the tier's first configured
  model was used", so the sentences differ in meaning, not just in the name. OpenCode
  passes today's strings, so the UI text stays identical (existing UI and E2E assertions
  prove it).

- Add a temporary lint block that enforces the boundary on the to-be-core set. It turns
  into the permanent core block in step 4.
- **Exit:** all gates green, pack listing unchanged.

### Step 4 — extract `packages/core` and `packages/testkit`; bundle with tsdown (L)

- `git mv` the set into `packages/core/src/` with the renames from the target layout, and
  move the matching tests (`test/core`, `test/health`, `test/state`, `test/execution`,
  `test/ui/flow*`, `test/rpc/status.test.ts`, `test/adapters/codex-capacity`).
  `test/fixtures/fake-provider` moves into `packages/testkit/src/fake-provider`.
- Run a one-off codemod (`scripts/codemods/core-imports.ts`, deleted in the same commit
  after use). It rewrites relative imports in `packages/opencode` that point into moved
  modules to `@coool/adaptive-core/<entry>`, and adds the needed re-exports to each core
  entry `index.ts` (only the names actually imported).
- `packages/opencode/package.json` gets `"@coool/adaptive-core": "0.0.0"` in
  devDependencies (bundled, so not a runtime dependency) plus `tsdown`.
- Build change: replace `tsc -p tsconfig.build.json` with `tsdown`. Entries are
  `src/index.ts`, `src/tui.tsx` and `src/rpc.ts`, built as ESM with
  `sourcemap: true` and embedded sources (pack-check requires them). `dts: true` with
  `@coool/adaptive-core` inlined. Externals are everything in `peerDependencies` and
  `dependencies`, plus the host-provided `@opentui/*` and `solid-js`. The JSX transform is
  automatic with `importSource: "solid-js"`, which matches tsc's current
  `react-jsx`/`jsxImportSource` output. `guiconfig.ts` (vite, GUI) stays as is, and its
  core imports resolve through the workspace.
- `pack-check` adds three checks:
  - no `@coool/adaptive-core` / `@coool/adaptive-testkit` string in any packed `dist/`
    file (including `.d.ts`; `.map` `sourcesContent` is the inlined core source, which
    does not name the package)
  - no such entry in `dependencies`, `peerDependencies`, `optionalDependencies` or
    `bundleDependencies` (`devDependencies` is allowed and expected)
  - the export targets exist
- **Exit:**
  - core: `npm run coverage -w @coool/adaptive-core` is at 100% from core tests alone
  - opencode: 100% on its remaining `src`
  - `plugin-test` passes on 2.2.1, current and latest; `e2e:tui` (the JSX bundle check),
    `e2e:gui`, `e2e:web` and runtime E2E pass; traceability is green
  - the pack listing differs from the baseline only by the expected set: core files gone
    from `dist/`, bundled chunks added. That diff is recorded in the commit message.
- If `e2e:tui` fails because of the JSX transform and can't be fixed in about a day,
  apply the fallback from "Rejected: publishing the core".

### Step 5 — release tooling and per-package changelogs (M)

- Add `scripts/release/` (plan + CLI + tests), `npm run release`, `release:status`, and
  a `pack-manifest.json` per published package.
- **Exit:** `npm run release -- --dry-run` prints a correct plan for opencode (last tag
  `v1.5.0`, the monorepo commits since), and the planner's unit tests cover a private
  package being skipped and a never-tagged package.

### Step 6 — docs and the requirement catalogue (S)

- Root `docs/PRODUCT.md` (host-neutral) and `docs/ARCHITECTURE.md` (packages and rules).
  Tag every ADP id `[both]`, `[opencode]` or `[pi]` (the Pi plan has the proposed
  mapping). Traceability filters by tag.
- Root README covers what Adaptive is, the two install lines and links to each package
  README. The package READMEs are what npm shows.
- `GOAL.md` is gitignored and stays local at the root. Note in AGENTS.md that it is the
  OpenCode product contract and that `docs/PRODUCT.md` is the shared one.

### Step 7 — prove the pipeline (S)

- Release `opencode-adaptive@1.5.1` (no behaviour change, "built from the monorepo")
  with `npm run release`.
- Install it into a real OpenCode and confirm the plugin loads, `/adaptive` opens and a
  routed turn writes a receipt.
- Only after this does work on `packages/pi` beyond the spike start landing on `main`.

## Risks and how each is caught

| Risk                                                                                  | Caught by                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Hoisting changes which `solid-js` copy the tests resolve, breaking the vitest aliases | `npm ls solid-js` in step 1 + the unit suite                                             |
| `opencode-plugin-test` assumes the repo root is the package root                      | step 1 exit (plugin-test from the workspace). Fix upstream in our own package if needed. |
| tsdown JSX output differs from tsc for `@opentui/solid`                               | `e2e:tui` + `plugin-test` in step 4, with a fallback ready                               |
| Bundled `.d.ts` still references the core                                             | pack-check string scan                                                                   |
| Core coverage was partly supplied by supervisor tests                                 | per-package coverage in step 4. Add core tests, never lower the gate.                    |
| Path assumptions in E2E helpers                                                       | baseline test count + byte-identical pack listing in step 1                              |
| An agent runs a gate for only one package after a core change                         | `check` and `verify` default to _affected_, and core selects everything                  |

## Effort

S = up to half a day, M = about a day, L = 2–3 days.

| Step | 0   | 1   | 2   | 3   | 4   | 5   | 6   | 7   |
| ---- | --- | --- | --- | --- | --- | --- | --- | --- |
| Size | S   | M   | M   | M   | L   | M   | S   | S   |
| Days | 0.5 | 1   | 1   | 1   | 2–3 | 1   | 0.5 | 0.5 |

The total is about 7.5–8.5 working days. Steps 1 and 4 carry almost all the risk. Steps
0–3 can land independently, each leaving the repo releasable.
