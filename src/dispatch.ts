/**
 * The model-facing `team_dispatch` tool: kind-routed delegation through the
 * configured role table. The model declares what kind of task it is dispatching
 * and writes the brief; the plugin owns which role and route runs it, and
 * escalates once to the role's fallback route when the primary child fails.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/dispatch
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentActivationSpec, SubagentActivation, SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ResolvedRole, RouteValidatingLlm } from './roles.ts'

/** The subagent-runtime surface dispatch needs; narrowed for direct unit testing. */
export interface DispatchSubagents {
  /** Start one managed child activation through the named provider. */
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
}

/** What the dispatch path needs; narrowed for direct unit testing. */
export interface TeamDispatchDeps {
  /** The continuable subagent provider children run through (capabilities only). */
  readonly provider: SubagentProvider
  /** The live subagent runtime that starts children. */
  readonly subagents: DispatchSubagents
  /** Resolved delegation-depth cap for dispatched children; absent leaves the budget to the provider. */
  readonly maxDepth?: number
  /** The resolved role table's model-facing surface. */
  readonly team: {
    /** Declared task kinds, in configuration order. */
    readonly kinds: readonly string[]
    /** Resolve one kind to its routed role; rejects unknown kinds. */
    roleFor(kind: string): ResolvedRole
    /** The routed roles of all declared kinds, in configuration order. */
    roleForKinds(): readonly ResolvedRole[]
    /** Take one concurrency slot; rejects when the cap is reached. */
    admitDispatch(): void
    /** Return one concurrency slot when the dispatched child settles. */
    releaseDispatch(): void
    /** Record one accepted dispatch for status reporting. */
    recordDispatch(entry: DispatchRecord): void
    /** Mark one recorded dispatch settled when its child run settles. */
    markSettled(childId: string): void
    /** Record the terminal outcome of one dispatch's child. */
    markOutcome(childId: string, outcome: string): void
    /** Recent labels already dispatched for one kind, newest first. */
    recentLabelsFor(kind: string, excludeChildId?: string): readonly string[]
  }
  /** Live LLM runtime for the dispatch-time route preflight. */
  readonly llm: RouteValidatingLlm
  /** Warn sink for fallback escalation that could not start; absent logs nothing. */
  readonly onWarn?: (message: string) => void
}

/** One recorded dispatch, for `team_status` reporting. */
export interface DispatchRecord {
  /** The child agent's session id. */
  readonly childId: string
  /** The dispatched task kind. */
  readonly kind: string
  /** The routed role id. */
  readonly role: string
  /** The pinned model id this attempt ran on. */
  readonly model: string
  /** The dispatcher's short display label. */
  readonly label: string
  /** Whether this attempt is the role's primary route or its fallback escalation. */
  readonly route: 'primary' | 'fallback'
  /** The child's terminal stop reason; absent until the run settles. */
  outcome?: string
  /** Provider-reported usage captured when the child settled; absent until then or when the child session is unreadable. */
  usage?: UsageSnapshot
}

/** Provider-reported token totals of one settled dispatch, off the shared `tokenUsage` projection. */
export interface UsageSnapshot {
  /** Input tokens outside cache traffic. */
  readonly uncachedInputTokens: number
  /** Output tokens. */
  readonly outputTokens: number
  /** Cache-read tokens. */
  readonly cacheReadTokens: number
  /** Cache-write tokens. */
  readonly cacheWriteTokens: number
}

/** Validated `team_dispatch` arguments. */
export interface DispatchArgs {
  readonly kind: string
  readonly description: string
  readonly prompt: string
  readonly cwd?: string
  readonly output_schema?: ObjectJsonSchema
}

/**
 * Validate tool-call arguments at the tool JSON boundary.
 * @param value - raw parsed arguments.
 * @returns the validated arguments.
 */
export function assertDispatchArgs(value: unknown): asserts value is DispatchArgs {
  if (typeof value !== 'object' || value === null) {
    throw new Error('team_dispatch arguments must be an object')
  }
  const args = value as Partial<DispatchArgs>
  for (const field of ['kind', 'description', 'prompt'] as const) {
    const current: unknown = args[field]
    if (typeof current !== 'string' || current.length === 0) {
      throw new Error(`team_dispatch \`${field}\` must be a non-empty string`)
    }
  }
  if (args.cwd !== undefined && typeof args.cwd !== 'string') {
    throw new Error('team_dispatch `cwd` must be a string')
  }
  if (args.output_schema !== undefined) {
    if (typeof args.output_schema !== 'object' || Array.isArray(args.output_schema)) {
      throw new Error('team_dispatch `output_schema` must be an object')
    }
    assertObjectJsonSchema(args.output_schema)
  }
}

/**
 * Compose the child prompt: the role's discipline line, then the brief.
 * @param role - the routed role.
 * @param prompt - the dispatcher's task brief.
 * @returns the composed child prompt.
 */
export function composeDispatchPrompt(role: ResolvedRole, prompt: string): string {
  return role.brief === undefined ? prompt : `${role.brief}\n\n${prompt}`
}

/** The per-attempt inputs shared by the primary dispatch and its fallback. */
interface AttemptContext {
  /** The dispatched task kind. */
  readonly kind: string
  /** The composed child prompt (role brief plus the brief). */
  readonly composed: string
  /** The dispatcher's display label. */
  readonly label: string
  /** Optional child working directory. */
  readonly cwd?: string | undefined
  /** Optional structured-output schema. */
  readonly outputSchema?: ObjectJsonSchema | undefined
  /** The calling agent that owns the delegation. */
  readonly parent: NonNullable<Parameters<ToolDefinition['execute']>[1]['agent']>
  /** The tool call's cancellation signal. */
  readonly signal: AbortSignal
  /** The role's agent preset, when declared. */
  readonly preset?: string | undefined
}

/**
 * Build the `team_dispatch` tool definition. The executor validates the schema,
 * so `execute` re-validates only as defense at the tool JSON boundary.
 * @param deps - dispatch dependencies.
 * @returns the tool definition.
 */
export function defineTeamDispatchTool(deps: TeamDispatchDeps): ToolDefinition {
  if (!deps.provider.capabilities.agentOptions) {
    throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support child agentOptions`)
  }
  const presetNeedingRoles = deps.team.roleForKinds().filter(role => role.preset !== undefined)
  if (presetNeedingRoles.length > 0 && !deps.provider.capabilities.agentPreset) {
    throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support child agent presets`
      + ` (roles with presets: ${presetNeedingRoles.map(role => `"${role.id}"`).join(', ')})`)
  }
  return defineTool({
    name: 'team_dispatch',
    description: 'Dispatch one team task to the role configured for its task kind. The role\'s model and reasoning effort are host-pinned; you choose only the kind and write the complete brief.'
      + ' This tool starts an independently managed subagent and immediately returns its id; the runtime notifies you when it finishes.'
      + ' Before re-dispatching the same kind, check the returned `recent` labels and state what differs from those attempts.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: [...deps.team.kinds],
        description: 'Task kind; routes to its configured role and model route.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete, self-contained brief for the role: exact file paths, full expected behavior, and acceptance criteria. The child does not see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
      },
      ...(deps.provider.capabilities.outputSchema ? {
        output_schema: {
          type: 'object' as const,
          additionalProperties: true,
          description: 'Optional object-rooted JSON Schema (type/properties/required/additionalProperties/items/enum/const/oneOf only) the child\'s final answer must satisfy; the validated object arrives with the completion notice.',
        },
      } : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'dispatch' },
          subagentId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          model: { type: 'string', required: true },
          escalates: { type: 'boolean', required: true },
          recent: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `dispatched to role "${value.role}" (${value.model}); started subagent ${value.subagentId}`
          + (value.escalates
            ? '; if this run ends without completing, it automatically re-dispatches once on this role\'s stronger fallback route'
            : ''),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertDispatchArgs(args)
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('team_dispatch requires a calling agent (exec.agent was undefined)')
      }
      const role = deps.team.roleFor(args.kind)
      if (args.output_schema !== undefined && !deps.provider.capabilities.outputSchema) {
        throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support structured child output`)
      }
      const composed = composeDispatchPrompt(role, args.prompt)
      deps.team.admitDispatch()
      try {
        await deps.llm.resolveCallConfig({ ...role.route }, exec.signal)
        if (role.fallback !== undefined) {
          await deps.llm.resolveCallConfig({ ...role.fallback.route }, exec.signal)
        }
        const context: AttemptContext = {
          kind: args.kind,
          composed,
          label: args.description,
          cwd: args.cwd,
          outputSchema: args.output_schema,
          parent,
          signal: exec.signal,
          ...role.preset === undefined ? {} : { preset: role.preset },
        }
        const started = await startAttempt(deps, context, role.options)
        deps.team.recordDispatch({
          childId: started.childId,
          kind: args.kind,
          role: role.id,
          model: role.route.model,
          label: args.description,
          route: 'primary',
        })
        observeAttempt(deps, started, role, 1, context)
        return {
          kind: 'dispatch' as const,
          subagentId: started.childId,
          role: role.id,
          model: role.route.model,
          escalates: role.fallback !== undefined,
          recent: [...deps.team.recentLabelsFor(args.kind, started.childId)],
        }
      } catch (error) {
        deps.team.releaseDispatch()
        throw error
      }
    },
  })
}

/** Start one child attempt with one route's options and the shared dispatch framing. */
function startAttempt(deps: TeamDispatchDeps, context: AttemptContext, routeOptions: AgentOptions): Promise<SubagentActivation> {
  return deps.subagents.startActivation({
    provider: deps.provider.name,
    label: context.label,
    request: {
      ...context.cwd === undefined ? {} : { cwd: context.cwd },
      prompt: [{ type: 'text', text: context.composed }] as ContentBlock[],
      parent: context.parent,
      agentOptions: { ...routeOptions },
      ...context.preset === undefined ? {} : { agentPreset: context.preset },
      ...deps.maxDepth === undefined ? {} : { maxDepth: deps.maxDepth },
      ...context.outputSchema === undefined ? {} : { outputSchema: context.outputSchema },
    },
    signal: context.signal,
    delivery: 'parent',
  })
}

/**
 * Observe one attempt's settlement: release its slot, record the outcome, and
 * — for a failed primary attempt of a role with a fallback route — escalate
 * once to the fallback. Cancellation is never escalated.
 */
function observeAttempt(
  deps: TeamDispatchDeps,
  started: SubagentActivation,
  role: ResolvedRole,
  attemptNumber: 1 | 2,
  context: AttemptContext,
): void {
  void started.result.then(
    (result) => { settleAttempt(deps, started.childId, role, attemptNumber, result, context) },
    () => { settleAttempt(deps, started.childId, role, attemptNumber, undefined, context) },
  )
}

function settleAttempt(
  deps: TeamDispatchDeps,
  childId: SubagentActivation['childId'],
  role: ResolvedRole,
  attemptNumber: 1 | 2,
  result: SubagentResult | undefined,
  context: AttemptContext,
): void {
  deps.team.releaseDispatch()
  deps.team.markSettled(childId)
  const outcome = result?.stopReason ?? 'error'
  deps.team.markOutcome(childId, outcome)
  if (attemptNumber !== 1 || role.fallback === undefined || outcome === 'completed' || outcome === 'aborted') return
  void escalate(deps, role, outcome, context)
}

/** Start the fallback attempt for one failed primary child; never re-escalates. */
async function escalate(
  deps: TeamDispatchDeps,
  role: ResolvedRole,
  failedOutcome: string,
  context: AttemptContext,
): Promise<void> {
  const fallback = role.fallback
  if (fallback === undefined) return
  const label = `${context.label} (fallback)`
  const composed = `${context.composed}\n\nA previous attempt with a faster model ended without completing (stop reason: ${failedOutcome}).`
    + ' You are the escalation running a stronger model: deliver the task fully.'
  try {
    deps.team.admitDispatch()
  } catch (error) {
    deps.onWarn?.(`team-orchestrator: fallback for role "${role.id}" skipped, no free concurrency slot: ${String(error)}`)
    return
  }
  try {
    const started = await startAttempt(deps, { ...context, label, composed }, fallback.options)
    deps.team.recordDispatch({
      childId: started.childId,
      kind: context.kind,
      role: role.id,
      model: fallback.route.model,
      label,
      route: 'fallback',
    })
    observeAttempt(deps, started, role, 2, { ...context, label, composed })
  } catch (error) {
    deps.team.releaseDispatch()
    deps.onWarn?.(`team-orchestrator: fallback for role "${role.id}" failed to start: ${String(error)}`)
  }
}

/**
 * The captain prompt section text: the kind→role routing table and briefing
 * discipline, rendered only where the tool is visible.
 * @param kinds - declared task kinds in configuration order.
 * @param roleFor - kind-to-role resolver.
 * @returns the section text.
 */
export function captainSectionText(kinds: readonly string[], roleFor: (kind: string) => ResolvedRole): string {
  const routes = kinds.map((kind) => {
    const role = roleFor(kind)
    const effort = role.route.reasoningEffort
    return `- \`${kind}\` → role \`${role.id}\` (\`${role.route.model}\` at \`${effort}\` reasoning effort)`
  })
  return 'Delegate team tasks with `team_dispatch` by task kind; each kind runs on its configured role and model route:\n'
    + `${routes.join('\n')}\n\n`
    + 'Write every brief short and concrete — exact file paths, full expected behavior, and acceptance criteria; the child does not see this conversation. Consult a high-effort planning role before dispatching open-ended work to a fast implementation role. Dispatch independent kinds together in one message; when only waiting for results remains, end your turn instead of polling. Check `team_status` before dispatching more work when completions seem overdue. Do not re-dispatch the same kind for the same goal: the dispatch result lists that kind\'s recent labels, and a retry must state what differs from those attempts.\n\n'
    + 'You are the implementer of last resort: dispatch the matching kind first and implement directly only after that dispatch failed. Role routes carry a fallback escalation automatically; failed dispatches re-run on a stronger model without your involvement.'
}
