---
description: "Experimental role-pinned team delegation: a config-declared role table resolves task kinds to per-role model routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-team-orchestrator

English | [中文](README.zh.md)

## Summary

`dsh-experimental-team-orchestrator` turns a configuration-declared role table into per-role child LLM routes for team delegation. Each role pins one exact provider, model, and reasoning effort; a task-kind routing map selects the role for a delegated task. Roles are host-pinned data: the model never names a route.

The package is experimental: its public contract remains under evaluation without a product-support commitment.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Declare roles and task-kind routing in the composition (cordis.yml or an overlay):

```yaml
- id: team-orchestrator
  name: '@deepseek-ai/dsh-experimental-team-orchestrator'
  config:
    provider: spawn
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
        preset: minimal-tools
    taskRouting:
      plan: planner
      implement: coder
      review: planner
    concurrency: 3
    maxDepth: provider-managed
```

Mount rejects an empty role table, an empty routing map, and any routing entry naming an undeclared role. Every declared route is validated against the live LLM runtime — provider lookup, exact-model metadata, and effort admissibility — at init, or on the next `llm/adapters-updated` event for routes whose provider adapter has not registered yet; an invalid route fails there. A declared role preset rejects at init unless the agent-presets service is mounted and the preset id resolves. A numeric `maxDepth` rejects at provider registration when the provider lacks the depthLimit capability.

### Model-facing tools

`team_dispatch` starts one child for a task kind: the model passes `kind`, a display `description`, a complete brief, and — where the provider supports it — an optional `output_schema` the child's final answer must satisfy. The tool resolves the kind to its role, re-validates the pinned route through the LLM runtime, prepends the role's `brief`, and starts the child through the configured subagent provider with the role's pinned `AgentOptions`, preset, and depth cap. The result lists the kind's recent dispatch labels so a retry can state what differs. `team_status` reports the dispatch registry: running dispatches against `concurrency`, per-role dispatched/running counts, and summed provider-reported token usage of settled dispatches (captured off the shared `tokenUsage` session projection; a child whose session is no longer readable settles without a usage snapshot). A captain prompt section renders the kind→role table and the briefing discipline wherever the tools are visible.

## Understand the implementation

`resolveRoles` performs the cross-field referent checks the schema cannot express and builds each role's child `AgentOptions` with a branded reasoning-effort id. `resolveTaskKind` maps a requested kind to its role and lists the declared kinds on an unknown kind. `validateRoleRoutes` delegates route admissibility to `LlmRuntime.resolveCallConfig`, reporting routes whose provider lacks an adapter as deferred instead of failing the mount. Both tools and the captain section mount when the configured subagent provider registers; a missing provider stays visible in the log and mounts later through `subagent/provider-added`.

## Known limitations and deferred work

The dispatch registry is per-process in-memory state and does not survive restarts. Rebuilding it from durable events is deferred: `tool/result` events carry only rendered content, so the dispatch tool's structured output (kind↔child correlation) is not durably recoverable without either a structured result field or new session events. Usage capture covers in-process children whose sessions remain readable through the sessions service. `allowCaptainOverride` is accepted but reserved: overriding always follows the subagent model-selection policy once enabled.
