/**
 * The model-facing `team_dispatch` tool: kind-routed delegation through the
 * configured role table. The model declares what kind of task it is dispatching
 * and writes the brief; the plugin owns which role and route runs it.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/dispatch
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentActivationSpec, SubagentActivation, SubagentProvider } from '@deepseek-ai/dsh-subagent'
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
    /** Recent labels already dispatched for one kind, newest first. */
    recentLabelsFor(kind: string, excludeChildId?: string): readonly string[]
  }
  /** Live LLM runtime for the dispatch-time route preflight. */
  readonly llm: RouteValidatingLlm
}

/** One recorded dispatch, for `team_status` reporting. */
export interface DispatchRecord {
  /** The child agent's session id. */
  readonly childId: string
  /** The dispatched task kind. */
  readonly kind: string
  /** The routed role id. */
  readonly role: string
  /** The role's pinned model id. */
  readonly model: string
  /** The dispatcher's short display label. */
  readonly label: string
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
  const presetNeedingRoles = [...deps.team.roleForKinds()].filter(role => role.preset !== undefined)
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
          recent: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `dispatched to role "${value.role}" (${value.model}); started subagent ${value.subagentId}` }],
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
        const started = await deps.subagents.startActivation({
          provider: deps.provider.name,
          label: args.description,
          request: {
            ...args.cwd === undefined ? {} : { cwd: args.cwd },
            prompt: [{ type: 'text', text: composed }] as ContentBlock[],
            parent,
            agentOptions: { ...role.options },
            ...role.preset === undefined ? {} : { agentPreset: role.preset },
            ...deps.maxDepth === undefined ? {} : { maxDepth: deps.maxDepth },
            ...args.output_schema === undefined ? {} : { outputSchema: args.output_schema },
          },
          signal: exec.signal,
          delivery: 'parent',
        })
        void started.result
          .catch(() => undefined)
          .then(() => {
            deps.team.releaseDispatch()
            deps.team.markSettled(started.childId)
          })
        deps.team.recordDispatch({
          childId: started.childId,
          kind: args.kind,
          role: role.id,
          model: role.route.model,
          label: args.description,
        })
        return {
          kind: 'dispatch' as const,
          subagentId: started.childId,
          role: role.id,
          model: role.route.model,
          recent: [...deps.team.recentLabelsFor(args.kind, started.childId)],
        }
      } catch (error) {
        deps.team.releaseDispatch()
        throw error
      }
    },
  })
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
    + 'Write every brief complete and self-contained — exact file paths, full expected behavior, and acceptance criteria; the child does not see this conversation. Consult a high-effort planning role before dispatching open-ended work to a fast implementation role. Dispatch independent kinds together in one message; when only waiting for results remains, end your turn instead of polling. Check `team_status` before dispatching more work when completions seem overdue. Do not re-dispatch the same kind for the same goal: the dispatch result lists that kind\'s recent labels, and a retry must state what differs from those attempts.'
}
