# AGENTS.md — dsh-team-orchestrator standalone repo

Mode-and-role-pinned team delegation plugin for DeepSeek Harness (dsh). A
configuration-declared mode table gives each mode a complete team — its own role
set, task-kind routing, concurrency cap, and delegation-depth policy — and each
role pins one exact child LLM route (provider + model + reasoning effort). The
model selects the mode and the task kind and never names a route. Failed primary
children escalate once to their role's stronger fallback route. Ships
`team_dispatch` / `team_status` model tools and a captain system-prompt section.

## Repo layout

```
src/
  index.ts             Plugin entry: TeamOrchestrator service. Owns the mode
                       table, mounts both tools + captain section when the
                       configured subagent provider registers, captures child
                       usage at subagent/start|end, resolves each mode's depth
                       cap, validates every mode's routes at init (NO_ADAPTER
                       defers to llm/adapters-updated).
  config.ts            zod-ish (schemastery) config schema: defaultMode, modes
                       (brief/concurrency/maxDepth + roles + taskRouting), roles
                       (provider/model/reasoningEffort/brief/preset/maxTokens/
                       fallback), allowCaptainOverride.
  roles.ts             resolveModes / resolveMode / resolveTaskKind /
                       flattenRoles / validateRoleRoutes.
  dispatch.ts          team_dispatch tool: mode+kind→role→AgentOptions, per-mode
                       concurrency and depth cap, fallback escalation on
                       non-completed settlement, recent-label dedupe hint,
                       output_schema passthrough, mode table in the captain text.
  status.ts            team_status tool: per-mode concurrency, per-role
                       dispatched/running/failed, summed token usage.
  usage-projection.ts  VENDORED usage projection unit (key
                       'teamOrchestratorUsage') — see "Upstream deltas".
tests/                 roles / dispatch / status spec files (vitest).
lib/                   COMMITTED build output. Consumers install without
                       building. Rebuild + commit lib/ whenever src/ changes.
examples/              weak-matrix.patch.yml — all-weak roles + strong fallback
                       escalation, declared as one mode (the pilot-campaign
                       recipe). modes.patch.yml — fast/balanced/strict with
                       different role sets, routes, and budgets.
cordis.patch.yml       The dsh.bundle patch layer: mounts the plugin with the
                       default configuration, which declares two modes (`fast`
                       is the default, `strict` adds strong planning/review/
                       verify roles and halves concurrency).
```

## Upstream relationship (sync workflow)

This package is the standalone distribution of
`packages/experimental/team-orchestrator` in the DeepSeek Harness monorepo.
The active development copy of the monorepo is `D:\projects\dsh-orch`
(branch `feat/team-orchestrator`; the canonical checkout
`D:\projects\deepseek-harness` holds an older snapshot plus research docs:
`paper-plan.md`, `team-orchestrator-plan.md`, `team-orchestrator-optimization.md`).
The SWE-bench pilot campaign that motivated the fallback design is
`D:\projects\swe-bench-adapter\CAMPAIGN.md` (all-weak roles won 9/9 at 1/13th
the cost of all-strong; the leader self-implementing was the failure mode).

**Sync direction: monorepo → this repo.** Copy src/ and tests/ from upstream,
then re-apply the three intentional deltas (the first two are API-availability
workarounds for published DSH releases, marked in code comments; the third is
the mode feature developed here first):

1. `src/index.ts` — upstream registers the shared `tokenUsage` projection via
   a `@deepseek-ai/dsh-token-meter` root export that npm releases do not ship.
   Here we register the vendored `teamUsageProjectionDefinition` (own key
   `teamOrchestratorUsage`) and read through the typed
   `sessionProjections.stateOf(session, 'teamOrchestratorUsage')`.
2. `src/index.ts` — upstream captain section uses
   `getSectionOrder('TOOL_TEAM_DISPATCH')` (a system-prompt order name added
   after the published releases). Here it stays `TOOL_SUBAGENT`.
3. **The mode table is a standalone-first feature.** The upstream copy
   (`D:\projects\dsh-orch\packages\experimental\team-orchestrator`) still
   declares the 0.1 flat `roles`/`taskRouting`/`concurrency`/`maxDepth` shape.
   The mode table — `config.modes` + `defaultMode`, `resolveModes`,
   per-mode concurrency/depth/status, the `team_dispatch` `mode` parameter —
   exists only here and must be ported upstream before the next sync; until
   then `diff -r` reports these files as different by design.

Everything else must stay byte-identical to upstream. Verify with
`diff -r` against `D:\projects\dsh-orch\packages\experimental\team-orchestrator`
(only the three deltas above plus `@module` doc names may differ).

## Hard constraints (all learned the hard way)

- **zod must be exactly `4.4.3`** (no caret). The `@deepseek-ai/*` peers are
  compiled against zod 4.4.3; a second zod copy makes
  `ProjectionDefinition['stateSchema']` unassignable (12 type errors).
- **tsc needs a big heap**: `npm run build` already runs
  `node --max-old-space-size=8192`; without it tsc OOMs even for this small
  source set. If typechecking feels inexplicably heavy, delete `.tsbuildinfo`
  first.
- **`engines.dsh: ">=0.2.0-rc.2"`** decides the plugin manager's
  compatibility gate alone (peer ranges are ignored when engines.dsh is
  present). Do not remove it: the desktop runtime may be older than the
  peers (`^0.2.1-rc.1`).
- **`agentPreset` capability needs a dsh host ≥ 0.2.1-rc.1.** Published
  0.2.0-rc.2 hosts lack it; a role declaring a preset then fails the mount,
  so the default configuration declares none.
- **A nested schemastery object is not optional.** `z.object({...})` used for an
  optional nested field defaults to `{}` when the key is absent, and its own
  `.required()` children then reject the value. A field that may be absent must
  be `z.union([objectSchema, z.const(null)])`: absence stays absent, an explicit
  `null` is accepted and treated as undeclared, and a present-but-incomplete
  object still rejects. Before 0.2.0-rc.1 this made every config with a
  fallback-less role fail `ConfigSchema` validation — the plugin could silently
  never mount; `tests/config.spec.ts` now validates the schema itself.
- **lib/ is committed.** After any src change: `npm run build`, `npm test`,
  commit both together. `npm publish` re-runs both via `prepublishOnly`.
- **Relative imports use `.ts` extensions** (`rewriteRelativeImportExtensions`
  rewrites them at build). Keep that style.
- Tests instantiate the service's pieces through narrow fakes — they never
  boot cordis. The tool `execute` is invoked through the
  `ExecutableDefinition` cast with an inline
  `oxlint-disable typescript/unbound-method` (execute is an arrow property,
  never `this`-bound).

## Environment

- **Node: use `D:\nvm\v24.22.1`** — prepend
  `export PATH="/d/nvm/v24.22.1:$PATH"` in each shell. The machine default is
  Node 20 (pnpm 11 crashes: missing `node:sqlite`) and Node 22 breaks the
  harness lefthook installer (`lstat` returns `dev=0` on Windows 22, so its
  lock check always fails). Node ≥ 24.9 matches the harness `engines`.
- `pnpm dsh` only works inside a dsh checkout (`D:\projects\dsh-orch` or
  `D:\projects\deepseek-harness`) — the standalone repo has no `dsh` script.
- Real-API runs need `DEEPSEEK_API_KEY` (the harness reads the checkout's
  `.env`). The DeepSeek account has run out of balance before
  (`QUOTA: Insufficient Balance`, 402) — that error means top up, not debug.
- Profiles live in `~/.dsh/profiles/<name>/`; the plugin manager installs
  into the **desktop** profile (the GUI app). `--profile orch` is the dev
  profile used for smokes; it links this repo's tgz/checkout.

## Verification ladder

1. `npm test` — 70 unit tests (ConfigSchema validation of the mount path and
   its defaults, mode resolution and default-mode rules, in-mode routing, mode
   and kind gating, per-mode concurrency on every admit/release path, fallback
   escalation, schema/capability rejections, per-mode status folding and
   rendering). All new behavior needs tests, including every rejection path.
2. `npm run build` — must stay at 0 errors under `strict` +
   `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
3. Real-API smoke (after any behavior change):
   `pnpm dsh --profile orch --patch examples/weak-matrix.patch.yml "<small
   task>"` from `D:\projects\dsh-orch`. Expect children on
   `deepseek-flash at low`, `team_status` reporting per-role usage, and no
   `(fallback)` re-dispatch when the primary completes.
4. Session-log evidence: child sessions live under
   `~/.dsh/sessions/--D-projects-dsh-orch--/`; `session.v4.jsonl.zstd`
   decompresses with `zlib.zstdDecompressSync`. `subagent/descriptor` events
   carry `agentModel`/`agentReasoningEffort` — that is the ground truth for
   "which model actually ran".

## Current state (2026-10-30)

- `main` at `f768982` (AGENTS.md handoff), pushed to
  `https://github.com/PUMP-255/dsh-team-orchestrator`. Working tree carries the
  unreleased 0.2.0-rc.1 mode work.
- **0.2.0-rc.1: modes.** The configuration shape changed from one flat team to
  `modes: { <id>: { brief?, concurrency, maxDepth, roles, taskRouting } }` plus
  `defaultMode`. This is a deliberate breaking change (pre-1.0, pre-stable
  contract); README documents the 0.1 → 0.2 wrapping. `team_dispatch` exposes
  `mode` only when several modes are declared, concurrency slots and depth caps
  are per mode, and `team_status` reports one block per mode. The shipped
  `cordis.patch.yml` now declares `fast` (default, pilot recipe) and `strict`
  (strong planning/review/verify, concurrency 2).
- Local verification for 0.2.0-rc.1: `npm test` 70/70, `npm run build` 0 errors.
  An independent review caught the nested-schema fallback blocker (fixed, with
  `tests/config.spec.ts` as the regression); the three shipped/example patch
  configurations were also parsed by the real dsh loader (`dsh --dump-config`).
  Real-API smoke for the mode path passed (2026-10-30, `--profile orch`, fresh
  install of the 0.2.0-rc.1 tarball, shipped two-mode default config, no
  overlay): the model called
  `team_dispatch({mode: "strict", kind: "implement"})`; that child's session
  header showed `deepseek-flash/low` + `maxTokens 65536` (strict/coder) and the
  tool render read `dispatched in mode "strict" to role "coder"`. A second run
  dispatched `{mode: "strict", kind: "review"}`; its child header showed
  `deepseek-v4-pro/high` (strict/reviewer, where `fast` routes its reviewer to
  flash/low), proving the mode actually selects the role's route.
  `team_status` reported per-mode blocks with per-mode-role usage
  (`strict/reviewer ... tokens in/out 13652/244`) and per-mode concurrency
  (`fast 0/3, strict 0/2`). No fallback re-dispatch occurred; evidence lives in
  the parent session logs under `~/.dsh/sessions/--D-projects-dsh-orch--/`.
  The `orch` profile now carries 0.2.0-rc.1 (roll back with
  `pnpm dsh plugin --profile orch add <0.1.0-rc.2 tarball>` if needed).
- Installable through the plugin manager (bundle declaration + default-config
  patch verified against a 0.2.0-rc.2 desktop runtime; re-verify the new
  two-mode default config there after the next install).
- Known limitations: dispatch registry is per-process memory (rebuild from
  durable events is impossible until `tool/result` gains structured payloads);
  usage capture covers live-child sessions only; fallback needs a free
  concurrency slot at settlement time; per-mode concurrency means the total
  simultaneous children can reach the sum of the modes' caps; a mode `brief` is
  prompt guidance and cannot force a dispatch.
- Deferred roadmap (see `D:\projects\dsh-orch\team-orchestrator-optimization.md`
  §P2/P3): `allowCaptainOverride` (peers-based whitelist via
  subagent-model-selection-policy), workflow-engine parallel template, npm
  publish (requires an npm scope — `@deepseek-ai` is not publishable by us;
  a rename touches package.json `name`, cordis.patch.yml, and the example
  overlay), snapshot recording (needs a Unix host; Windows replay of the
  snapshot corpus is broken upstream), and web UI.
