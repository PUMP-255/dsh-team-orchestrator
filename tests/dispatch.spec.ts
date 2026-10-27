/** Unit behavior of the `team_dispatch` tool: routing, briefing, gating, and output. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import type { Config } from '../src/config.ts'
import { resolveRoles } from '../src/roles.ts'
import type { ResolvedRole } from '../src/roles.ts'
import {
  assertDispatchArgs,
  captainSectionText,
  composeDispatchPrompt,
  defineTeamDispatchTool,
} from '../src/dispatch.ts'
import type { DispatchRecord } from '../src/dispatch.ts'

function config(overrides?: Partial<Config>): Config {
  return {
    provider: 'spawn',
    roles: {
      planner: { provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high', brief: 'Design first.' },
      coder: { provider: 'deepseek-official', model: 'm-fast', reasoningEffort: 'low' },
    },
    taskRouting: { plan: 'planner', implement: 'coder' },
    concurrency: 2,
    maxDepth: 'provider-managed',
    allowCaptainOverride: false,
    ...overrides,
  }
}

function configWithPreset(): Config {
  const cfg = config()
  return { ...cfg, roles: { ...cfg.roles, coder: { ...cfg.roles.coder!, preset: 'minimal' } } }
}

function roleFor(cfg: Config, roles: ReadonlyMap<string, ResolvedRole>): (kind: string) => ResolvedRole {
  return (kind) => {
    const roleId = cfg.taskRouting[kind]
    if (roleId === undefined) {
      throw new Error(`team-orchestrator: unknown task kind "${kind}";`
        + ` declared kinds: ${Object.keys(cfg.taskRouting).map(id => `"${id}"`).join(', ')}`)
    }
    const role = roles.get(roleId)
    if (role === undefined) {
      throw new Error(`team-orchestrator: task kind "${kind}" routes to undeclared role "${roleId}"`)
    }
    return role
  }
}

const PROVIDER = {
  name: 'spawn',
  capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
  inheritsParentContext: false,
} as const

const NO_SCHEMA_PROVIDER = {
  name: 'spawn',
  capabilities: { agentOptions: true, agentPreset: true, outputSchema: false, depthLimit: true },
  inheritsParentContext: false,
} as const

const NO_PRESET_PROVIDER = {
  name: 'spawn',
  capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
  inheritsParentContext: false,
} as const

interface Harness {
  readonly definition: ReturnType<typeof defineTeamDispatchTool>
  readonly started: SubagentActivationSpec[]
  readonly preflighted: string[]
  readonly records: DispatchRecord[]
  readonly settled: Set<string>
  running(): number
  settleAll(): void
  /** Dispatch through the definition with only the fields execute reads. */
  dispatch(args: unknown, signal: AbortSignal): Promise<unknown>
}

function harness(overrides?: Partial<Config>): Harness {
  const cfg = config(overrides)
  const roles = resolveRoles(cfg)
  const started: SubagentActivationSpec[] = []
  const preflighted: string[] = []
  const records: DispatchRecord[] = []
  const settled = new Set<string>()
  let active = 0
  const resolvers: Array<() => void> = []
  const definition = defineTeamDispatchTool({
    provider: PROVIDER,
    subagents: {
      startActivation: async (spec) => {
        started.push(spec)
        return {
          childId: SessionId(`child-${started.length}`),
          result: new Promise((resolve) => {
            resolvers.push(() => {
              resolve({ output: [], stopReason: 'completed' as const })
            })
          }),
          dispose: async () => undefined,
        }
      },
    },
    team: {
      kinds: Object.keys(cfg.taskRouting),
      roleFor: roleFor(cfg, roles),
      roleForKinds: () => Object.keys(cfg.taskRouting).map(kind => roleFor(cfg, roles)(kind)),
      admitDispatch: () => {
        if (active >= cfg.concurrency) {
          throw new Error(`team-orchestrator: ${active} dispatches already running (concurrency ${cfg.concurrency})`)
        }
        active += 1
      },
      releaseDispatch: () => { active -= 1 },
      recordDispatch: (entry) => { records.unshift(entry) },
      markSettled: (childId) => { settled.add(childId) },
      recentLabelsFor: (kind, excludeChildId) => records
        .filter(record => record.kind === kind && record.childId !== excludeChildId)
        .map(record => record.label)
        .slice(0, 3),
    },
    llm: {
      resolveCallConfig: async (call) => {
        preflighted.push(`${call.provider}/${call.model}/${call.reasoningEffort ?? ''}`)
        return { ...call }
      },
    },
  })
  return {
    definition,
    started,
    preflighted,
    records,
    settled,
    running: () => active,
    settleAll: () => {
      const pending = resolvers.splice(0, resolvers.length)
      for (const resolve of pending) resolve()
    },
    dispatch: (args, signal) => executeThrough(definition, args, signal),
  }
}

type NarrowExecute = (args: unknown, exec: { signal: AbortSignal; agent?: object }) => Promise<unknown>

function executeThrough(definition: ReturnType<typeof defineTeamDispatchTool>, args: unknown, signal: AbortSignal): Promise<unknown> {
  // oxlint-disable-next-line typescript/unbound-method -- execute is an arrow property, never this-bound
  const executable = definition.execute as NarrowExecute
  return executable(args, { signal, agent: {} })
}

describe('assertDispatchArgs', () => {
  it('rejects empty and non-string fields', () => {
    expect(() => { assertDispatchArgs({ kind: '', description: 'd', prompt: 'p' }) }).toThrow('`kind` must be a non-empty string')
    expect(() => { assertDispatchArgs({ kind: 'plan', description: 7, prompt: 'p' }) }).toThrow('`description` must be a non-empty string')
    expect(() => { assertDispatchArgs(null) }).toThrow('must be an object')
  })
})

describe('composeDispatchPrompt', () => {
  it('prepends the role brief and keeps an unbriefed prompt verbatim', () => {
    const roles = resolveRoles(config())
    const planner = roles.get('planner')
    const coder = roles.get('coder')
    expect(planner === undefined || coder === undefined).toBe(false)
    if (planner === undefined || coder === undefined) return
    expect(composeDispatchPrompt(planner, 'Build x.')).toBe('Design first.\n\nBuild x.')
    expect(composeDispatchPrompt(coder, 'Build x.')).toBe('Build x.')
  })
})

describe('team_dispatch dispatch', () => {
  it('routes the kind, carries the pinned route, and composes the brief', async () => {
    const h = harness()
    const result = await h.dispatch({ kind: 'plan', description: 'Design slugify', prompt: 'Plan the slugify module.' }, new AbortController().signal)
    expect(result).toEqual({ kind: 'dispatch', subagentId: 'child-1', role: 'planner', model: 'm-strong', recent: [] })
    expect(h.preflighted).toEqual(['deepseek-official/m-strong/high'])
    expect(h.started).toHaveLength(1)
    const spec = h.started[0]
    if (spec === undefined) throw new Error('dispatch did not start a child')
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('Design slugify')
    expect(spec.delivery).toBe('parent')
    expect(spec.request.prompt[0]).toMatchObject({ type: 'text', text: 'Design first.\n\nPlan the slugify module.' })
    expect(spec.request.agentOptions).toEqual({ provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high' })
  })

  it('rejects an unknown kind through the schema enum with the declared kinds', async () => {
    const h = harness()
    await expect(h.dispatch({ kind: 'deploy', description: 'd', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('must be one of')
  })

  it('rejects when no calling agent owns the dispatch', async () => {
    const h = harness()
    // oxlint-disable-next-line typescript/unbound-method -- execute is an arrow property, never this-bound
    const executable = h.definition.execute as (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
    await expect(executable({ kind: 'plan', description: 'd', prompt: 'p' }, { signal: new AbortController().signal }))
      .rejects.toThrow('requires a calling agent')
  })

  it('rejects at the concurrency cap and releases when children settle', async () => {
    const h = harness({ concurrency: 1 })
    const signal = new AbortController().signal
    await h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, signal)
    await expect(h.dispatch({ kind: 'plan', description: 'b', prompt: 'p' }, signal))
      .rejects.toThrow('1 dispatches already running (concurrency 1)')
    h.settleAll()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.running()).toBe(0)
    await h.dispatch({ kind: 'implement', description: 'c', prompt: 'p' }, signal)
    expect(h.started).toHaveLength(2)
  })

  it('releases the slot when the preflight rejects', async () => {
    const cfg = config()
    const roles = resolveRoles(cfg)
    let active = 0
    const failing = defineTeamDispatchTool({
      provider: PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable after preflight') } },
      team: {
        kinds: ['plan'],
        roleFor: roleFor(cfg, roles),
        roleForKinds: () => [roleFor(cfg, roles)('plan')],
        admitDispatch: () => { active += 1 },
        releaseDispatch: () => { active -= 1 },
        recordDispatch: () => undefined,
        markSettled: () => undefined,
        recentLabelsFor: () => [],
      },
      llm: { resolveCallConfig: async () => { throw new Error('route drifted') } },
    })
    await expect(executeThrough(failing, { kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('route drifted')
    expect(active).toBe(0)
  })

  it('records accepted dispatches and marks them settled', async () => {
    const h = harness()
    await h.dispatch({ kind: 'plan', description: 'Design it', prompt: 'p' }, new AbortController().signal)
    expect(h.records).toEqual([
      { childId: 'child-1', kind: 'plan', role: 'planner', model: 'm-strong', label: 'Design it' },
    ])
    expect(h.settled.size).toBe(0)
    h.settleAll()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.settled.has('child-1')).toBe(true)
  })

  it('lists recent labels of the same kind, excluding the current child', async () => {
    const h = harness({ concurrency: 3 })
    await h.dispatch({ kind: 'plan', description: 'First plan', prompt: 'p' }, new AbortController().signal)
    const result = await h.dispatch({ kind: 'plan', description: 'Second plan', prompt: 'p' }, new AbortController().signal)
    expect(result).toMatchObject({ recent: ['First plan'] })
    const other = await h.dispatch({ kind: 'implement', description: 'Do it', prompt: 'p' }, new AbortController().signal)
    expect(other).toMatchObject({ recent: [] })
  })

  it('passes a validated output schema through to the child request', async () => {
    const h = harness()
    const schema = { type: 'object' as const, properties: { steps: { type: 'array' as const, items: { type: 'string' as const } } }, required: ['steps'], additionalProperties: false }
    await h.dispatch({ kind: 'plan', description: 'd', prompt: 'p', output_schema: schema }, new AbortController().signal)
    expect(h.started[0]?.request.outputSchema).toEqual(schema)
  })

  it('carries the role preset and the resolved depth cap into the child request', async () => {
    const cfg = configWithPreset()
    const roles = resolveRoles(cfg)
    const started: SubagentActivationSpec[] = []
    const definition = defineTeamDispatchTool({
      provider: PROVIDER,
      subagents: {
        startActivation: async (spec) => {
          started.push(spec)
          return {
            childId: SessionId(`child-${started.length}`),
            result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
            dispose: async () => undefined,
          }
        },
      },
      maxDepth: 4,
      team: {
        kinds: Object.keys(cfg.taskRouting),
        roleFor: roleFor(cfg, roles),
        roleForKinds: () => Object.keys(cfg.taskRouting).map(kind => roleFor(cfg, roles)(kind)),
        admitDispatch: () => undefined,
        releaseDispatch: () => undefined,
        recordDispatch: () => undefined,
        markSettled: () => undefined,
        recentLabelsFor: () => [],
      },
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })
    await executeThrough(definition, { kind: 'implement', description: 'd', prompt: 'p' }, new AbortController().signal)
    expect(started[0]?.request.agentPreset).toBe('minimal')
    expect(started[0]?.request.maxDepth).toBe(4)
  })

  it('rejects definition when a role declares a preset the provider cannot honor', () => {
    const cfg = configWithPreset()
    const roles = resolveRoles(cfg)
    expect(() => defineTeamDispatchTool({
      provider: NO_PRESET_PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable') } },
      team: {
        kinds: Object.keys(cfg.taskRouting),
        roleFor: roleFor(cfg, roles),
        roleForKinds: () => Object.keys(cfg.taskRouting).map(kind => roleFor(cfg, roles)(kind)),
        admitDispatch: () => undefined,
        releaseDispatch: () => undefined,
        recordDispatch: () => undefined,
        markSettled: () => undefined,
        recentLabelsFor: () => [],
      },
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })).toThrow('does not support child agent presets (roles with presets: "coder")')
  })

  it('rejects a non-object-rooted output schema at the tool boundary', async () => {
    const h = harness()
    await expect(h.dispatch({ kind: 'plan', description: 'd', prompt: 'p', output_schema: { type: 'string' } }, new AbortController().signal))
      .rejects.toThrow()
    expect(h.started).toHaveLength(0)
  })

  it('rejects an output schema when the provider lacks the capability', async () => {
    const cfg = config()
    const roles = resolveRoles(cfg)
    const noSchema = defineTeamDispatchTool({
      provider: NO_SCHEMA_PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable') } },
      team: {
        kinds: Object.keys(cfg.taskRouting),
        roleFor: roleFor(cfg, roles),
        roleForKinds: () => Object.keys(cfg.taskRouting).map(kind => roleFor(cfg, roles)(kind)),
        admitDispatch: () => undefined,
        releaseDispatch: () => undefined,
        recordDispatch: () => undefined,
        markSettled: () => undefined,
        recentLabelsFor: () => [],
      },
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })
    await expect(executeThrough(noSchema, { kind: 'plan', description: 'd', prompt: 'p', output_schema: { type: 'object' } }, new AbortController().signal))
      .rejects.toThrow('does not support structured child output')
  })
})

describe('captainSectionText', () => {
  it('renders the kind to role and route table', () => {
    const cfg = config()
    const roles = resolveRoles(cfg)
    const text = captainSectionText(Object.keys(cfg.taskRouting), roleFor(cfg, roles))
    expect(text).toContain('`plan` → role `planner` (`m-strong` at `high` reasoning effort)')
    expect(text).toContain('`implement` → role `coder` (`m-fast` at `low` reasoning effort)')
    expect(text).toContain('end your turn instead of polling')
  })
})
