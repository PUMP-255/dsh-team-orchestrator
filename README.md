# @deepseek-ai/dsh-team-orchestrator

English | [中文](README.zh.md)

## Summary

`dsh-team-orchestrator` turns a configuration-declared mode table into selectable team configurations for subagent delegation. Each mode declares its own role set, the task-kind routing that selects roles, a concurrency cap, and a delegation-depth policy; each role pins one exact provider, model, and reasoning effort. A mode's roles are host-pinned data: the model selects the mode and the task kind, never a route. A failed primary child escalates once to its role's stronger fallback route automatically.

The package is pre-stable software: its public contract may change without notice while the DeepSeek Harness APIs it builds on are pre-stable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Develop this package](#develop-this-package)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Declare modes in the composition (cordis.yml or an overlay). Each mode is a complete team:

```yaml
- id: team-orchestrator
  name: '@deepseek-ai/dsh-team-orchestrator'
  config:
    provider: spawn
    defaultMode: fast
    modes:
      fast:
        brief: Deliver directly; check the result yourself before reporting.
        concurrency: 3
        maxDepth: provider-managed
        roles:
          planner:
            provider: deepseek-official
            model: deepseek-flash
            reasoningEffort: low
            brief: Design solutions and produce implementable briefs.
          coder:
            provider: deepseek-official
            model: deepseek-flash
            reasoningEffort: low
            brief: Execute the brief verbatim; make no design decisions.
            preset: minimal-tools
            maxTokens: 65536
        taskRouting:
          plan: planner
          implement: coder
      strict:
        brief: Every implementation is reviewed before you report completion.
        concurrency: 2
        roles:
          planner:
            provider: deepseek-official
            model: deepseek-v4-pro
            reasoningEffort: high
            brief: Design solutions and produce implementable briefs.
          coder:
            provider: deepseek-official
            model: deepseek-flash
            reasoningEffort: low
            brief: Execute the brief verbatim; make no design decisions.
            maxTokens: 65536
            fallback:
              provider: deepseek-official
              model: deepseek-v4-pro
              reasoningEffort: high
          reviewer:
            provider: deepseek-official
            model: deepseek-v4-pro
            reasoningEffort: high
            brief: Review findings only; never implement.
        taskRouting:
          plan: planner
          implement: coder
          review: reviewer
```

Mount rejects an empty mode table, an empty role table, an empty routing map, routing that names a role its own mode does not declare, a role that no `taskRouting` entry names, and a role fallback identical to its primary route. `defaultMode` may be omitted only when exactly one mode is declared — that mode is the default; with several modes an omitted default is rejected instead of guessed, and a `defaultMode` naming no declared mode is rejected. Every declared route of every mode is validated against the live LLM runtime — provider lookup, exact-model metadata, and effort admissibility — at init, or on the next `llm/adapters-updated` event for routes whose provider adapter has not registered yet; an invalid route fails there. A declared role preset rejects at init unless the agent-presets service is mounted and the preset id resolves; the agent-preset capability requires a dsh host at 0.2.1-rc.1 or newer (older hosts refuse the mount only when a role actually declares a preset — the shipped default configuration does not). A numeric `maxDepth` rejects at provider registration when the provider lacks the depthLimit capability; the check and the cap are per mode.

### Modes

A mode owns everything that makes one deployment cheaper or stricter than another: which roles exist, which model and reasoning effort each role runs on, how many of that mode's children may run at once, and how deep they may recurse. Per-role `preset`, `maxTokens`, and `fallback` are declared inside the mode too, so a cheap mode can run a minimal-tools coder and a strict mode can run a strong reviewer without a second plugin instance. Task kinds are resolved inside the selected mode, so a kind only one mode declares is unavailable in the others and is rejected with that mode's own kind list.

`team_dispatch` exposes an optional `mode` parameter only when more than one mode is declared; with a single mode every dispatch runs that mode and the parameter is absent. An omitted `mode` runs `defaultMode`. Concurrency slots are counted per mode, so two modes running at once each keep their own cap. A mode's `brief` is prompt guidance shown to the captain — it is not a runtime gate, and no mode can force a later dispatch the captain does not make.

### Fallback escalation

Each role may declare a stronger `fallback` route (`provider`/`model`/`reasoningEffort`). When the role's primary child settles without completing — `error`, `max-tokens`, `refusal`, or any other non-`completed`, non-`aborted` stop reason — the plugin automatically re-dispatches the same task once on the fallback route, in the same mode, with the brief plus a note naming the failed attempt's stop reason. Cancellation never escalates, the fallback attempt never escalates again, and both routes are preflighted at dispatch time so an invalid fallback fails with the dispatch, not mid-flight. `maxTokens` caps each child request's output budget against runaway reasoning; a `max-tokens` settlement is a normal fallback trigger. See `examples/weak-matrix.patch.yml` for the weak-model matrix with strong-model escalation this mechanism was built for.

### Upgrading from 0.1

The 0.1 configuration declared one flat `roles`/`taskRouting`/`concurrency`/`maxDepth` table. Wrap that table in a single mode to keep the same behavior; add `defaultMode` only once a second mode exists:

```yaml
config:
  provider: spawn
  modes:
    fast:
      concurrency: 3
      roles: { ... }        # unchanged
      taskRouting: { ... }  # unchanged
```

A leftover 0.1 top-level `roles`, `taskRouting`, `concurrency`, or `maxDepth` is rejected at mount: those fields are no longer read, so keeping one beside `modes` would silently do nothing.

### Model-facing tools

`team_dispatch` starts one child for a task kind in the chosen mode: the model passes `mode` (only where several are declared), `kind`, a display `description`, a complete brief, and — where the provider supports it — an optional `output_schema` the child's final answer must satisfy. The tool resolves the mode and kind to their role, re-validates the pinned route (and the role's fallback route, when declared) through the LLM runtime, prepends the role's `brief`, and starts the child through the configured subagent provider with the role's pinned `AgentOptions`, preset, and the mode's depth cap. The result names the mode, the role, and whether the role escalates on failure, and lists the kind's recent dispatch labels so a retry can state what differs. `team_status` reports the dispatch registry per mode: running dispatches against that mode's `concurrency`, per-role dispatched/running/failed counts, and summed provider-reported token usage of settled dispatches (captured off this package's own `teamOrchestratorUsage` session projection; a child whose session is no longer readable settles without a usage snapshot). A captain prompt section renders the mode table, its kind→role routes, and the briefing discipline wherever the tools are visible.

## Understand the implementation

`resolveModes` resolves every mode independently and picks the default one; `resolveMode` performs the cross-field referent checks a mode's own schema cannot express and builds each role's child `AgentOptions` with a branded reasoning-effort id. `resolveTaskKind` maps a requested kind to its role inside one mode and lists that mode's declared kinds on an unknown kind. `flattenRoles` keys every mode's roles for live route validation, and `validateRoleRoutes` delegates route admissibility to `LlmRuntime.resolveCallConfig`, reporting routes whose provider lacks an adapter as deferred instead of failing the mount. Both tools and the captain section mount when the configured subagent provider registers; a missing provider stays visible in the log and mounts later through `subagent/provider-added`.

## Develop this package

```sh
npm install    # install dependencies
npm run build  # emit lib/ (JavaScript, declarations, and maps) from src/
npm run test   # vitest unit tests
```

`lib/` is committed: consumers install the package without building it. Rebuild and commit `lib/` whenever `src/` changes; `npm publish` runs the build and tests again through `prepublishOnly`. The plugin mounts like any DSH plugin: list it in cordis.yml (or an overlay) with the configuration shown above, and the DSH runtime resolves the `@deepseek-ai` peer dependencies from its own installation.

## Known limitations and deferred work

The dispatch registry is per-process in-memory state and does not survive restarts. Rebuilding it from durable events is deferred: `tool/result` events carry only rendered content, so the dispatch tool's structured output (mode/kind↔child correlation) is not durably recoverable without either a structured result field or new session events. Usage capture covers in-process children whose sessions remain readable through the agents service. Concurrency is per mode, so the maximum number of simultaneously running children is the sum of the declared modes' caps. A mode `brief` and the captain prompt section are advisory guidance: the plugin cannot force a dispatch the captain does not make. `allowCaptainOverride` is accepted but reserved: overriding always follows the subagent model-selection policy once enabled.
