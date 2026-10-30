/** Unit behavior of the `team_dispatch` tool: mode and kind routing, briefing, gating, fallback, and output. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import type { Config, ModeConfig } from '../src/config.ts'
import { resolveModes } from '../src/roles.ts'
import type { ResolvedMode, ResolvedTeam } from '../src/roles.ts'
import {
  assertDispatchArgs,
  captainSectionText,
  composeDispatchPrompt,
  defineTeamDispatchTool,
} from '../src/dispatch.ts'
import type { DispatchRecord, TeamDispatchDeps } from '../src/dispatch.ts'

function fastMode(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    concurrency: 2,
    maxDepth: 'provider-managed',
    roles: {
      planner: {
        provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high', brief: 'Design first.',
        fallback: { provider: 'deepseek-official', model: 'm-strongest', reasoningEffort: 'max' },
      },
      coder: { provider: 'deepseek-official', model: 'm-fast', reasoningEffort: 'low' },
    },
    taskRouting: { plan: 'planner', implement: 'coder' },
    ...overrides,
  }
}

function strictMode(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    brief: 'Every implementation is followed by a review dispatch.',
    concurrency: 1,
    maxDepth: 'provider-managed',
    roles: {
      planner: { provider: 'deepseek-official', model: 'm-max', reasoningEffort: 'max' },
      coder: {
        provider: 'deepseek-official', model: 'm-pro', reasoningEffort: 'high',
        fallback: { provider: 'deepseek-official', model: 'm-max', reasoningEffort: 'max' },
      },
      challenger: { provider: 'deepseek-official', model: 'm-max', reasoningEffort: 'high', brief: 'Adversarial review only.' },
    },
    taskRouting: { plan: 'planner', implement: 'coder', review: 'challenger' },
    ...overrides,
  }
}

function config(overrides?: Partial<Config>): Config {
  return {
    provider: 'spawn',
    defaultMode: 'fast',
    modes: { fast: fastMode(), strict: strictMode() },
    allowCaptainOverride: false,
    ...overrides,
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

interface ExecutableDefinition {
  execute(args: unknown, exec: { signal: AbortSignal; agent?: object }): Promise<unknown>
}

interface Harness {
  readonly definition: ReturnType<typeof defineTeamDispatchTool>
  readonly started: SubagentActivationSpec[]
  readonly preflighted: string[]
  readonly records: DispatchRecord[]
  readonly warnings: string[]
  readonly settled: Set<string>
  running(mode: string): number
  /** Resolve one child's result by its 1-based ordinal. */
  settleChild(ordinal: number, stopReason: string): void
  dispatch(args: unknown, signal: AbortSignal): Promise<unknown>
}

type NarrowExecute = (args: unknown, exec: { signal: AbortSignal; agent?: object }) => Promise<unknown>

/** Resolve one mode id the way the service does, for ad-hoc tool definitions. */
function modeResolver(team: ResolvedTeam): (mode: string) => ResolvedMode {
  return (mode) => {
    const resolved = team.modes.get(mode)
    if (resolved === undefined) throw new Error(`team-orchestrator: unknown mode "${mode}"`)
    return resolved
  }
}

/** A no-op team surface for definitions that only exercise schema or capability gates. */
function inertSurface(team: ResolvedTeam): TeamDispatchDeps['team'] {
  return {
    modes: [...team.modes.values()],
    defaultMode: team.defaultMode,
    kinds: team.kinds,
    modeFor: modeResolver(team),
    recentLabelsFor: () => [],
    admitDispatch: () => undefined,
    releaseDispatch: () => undefined,
    recordDispatch: () => undefined,
    markSettled: () => undefined,
    markOutcome: () => undefined,
  }
}

interface HarnessOptions {
  /** Resolved depth cap per mode id. */
  readonly depths?: Readonly<Record<string, number>>
  /** Fail the Nth (1-based) `startActivation` call. */
  readonly failStartCall?: number
  /** Refuse the Nth (1-based) `admitDispatch` call. */
  readonly refuseAdmitCall?: number
}

function harness(cfg: Config = config(), options: HarnessOptions = {}): Harness {
  const team = resolveModes(cfg)
  const started: SubagentActivationSpec[] = []
  const preflighted: string[] = []
  const records: DispatchRecord[] = []
  const warnings: string[] = []
  const settled = new Set<string>()
  const active = new Map<string, number>()
  let admitCalls = 0
  const resolvers = new Map<number, (result: { output: never[]; stopReason: string }) => void>()
  const definition = defineTeamDispatchTool({
    provider: PROVIDER,
    subagents: {
      startActivation: async (spec) => {
        const ordinal = started.length + 1
        if (options.failStartCall === ordinal) throw new Error('start refused')
        started.push(spec)
        return {
          childId: SessionId(`child-${ordinal}`),
          result: new Promise((resolve) => {
            resolvers.set(ordinal, (result) => { resolve(result) })
          }),
          dispose: async () => undefined,
        }
      },
    },
    depthFor: mode => options.depths?.[mode],
    team: {
      modes: [...team.modes.values()],
      defaultMode: team.defaultMode,
      kinds: team.kinds,
      modeFor: modeResolver(team),
      recentLabelsFor: (kind, excludeChildId) => records
        .filter(record => record.kind === kind && record.childId !== excludeChildId)
        .map(record => record.label)
        .slice(0, 3),
      admitDispatch: (mode) => {
        admitCalls += 1
        if (options.refuseAdmitCall === admitCalls) throw new Error('no free slot')
        const running = active.get(mode) ?? 0
        const cap = modeResolver(team)(mode).concurrency
        if (running >= cap) {
          throw new Error(`team-orchestrator: mode "${mode}": ${running} dispatches already running (concurrency ${cap})`)
        }
        active.set(mode, running + 1)
      },
      releaseDispatch: (mode) => { active.set(mode, Math.max(0, (active.get(mode) ?? 0) - 1)) },
      recordDispatch: (entry) => { records.unshift(entry) },
      markSettled: (childId) => { settled.add(childId) },
      markOutcome: (childId, outcome) => {
        const record = records.find(entry => entry.childId === childId)
        if (record !== undefined) record.outcome = outcome
      },
    },
    llm: {
      resolveCallConfig: async (call) => {
        preflighted.push(`${call.provider}/${call.model}/${call.reasoningEffort ?? ''}`)
        return { ...call }
      },
    },
    onWarn: (message) => { warnings.push(message) },
  })
  return {
    definition,
    started,
    preflighted,
    records,
    warnings,
    settled,
    running: mode => active.get(mode) ?? 0,
    settleChild: (ordinal, stopReason) => {
      const resolve = resolvers.get(ordinal)
      if (resolve === undefined) throw new Error(`child-${ordinal} has no pending result`)
      resolvers.delete(ordinal)
      resolve({ output: [], stopReason })
    },
    dispatch: (args, signal) => executeThrough(definition, args, signal),
  }
}

function executeThrough(definition: ReturnType<typeof defineTeamDispatchTool>, args: unknown, signal: AbortSignal): Promise<unknown> {
  // oxlint-disable-next-line typescript/unbound-method -- execute is an arrow property, never this-bound
  const executable = definition.execute as NarrowExecute
  return executable(args, { signal, agent: {} })
}

async function drained(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

interface CompiledParameters {
  properties?: Record<string, { enum?: readonly string[]; description?: string } | undefined>
  required?: readonly string[]
}

function parametersOf(definition: ReturnType<typeof defineTeamDispatchTool>): CompiledParameters {
  return definition.parameters as CompiledParameters
}

describe('assertDispatchArgs', () => {
  it('rejects empty and non-string fields', () => {
    expect(() => { assertDispatchArgs({ kind: '', description: 'd', prompt: 'p' }) }).toThrow('`kind` must be a non-empty string')
    expect(() => { assertDispatchArgs({ kind: 'plan', description: 7, prompt: 'p' }) }).toThrow('`description` must be a non-empty string')
    expect(() => { assertDispatchArgs(null) }).toThrow('must be an object')
  })

  it('rejects an empty mode', () => {
    expect(() => { assertDispatchArgs({ kind: 'plan', description: 'd', prompt: 'p', mode: '' }) })
      .toThrow('`mode` must be a non-empty string')
  })
})

describe('composeDispatchPrompt', () => {
  it('prepends the role brief and keeps an unbriefed prompt verbatim', () => {
    const mode = resolveModes(config()).defaultMode
    expect(composeDispatchPrompt(mode.roleFor('plan'), 'Build x.')).toBe('Design first.\n\nBuild x.')
    expect(composeDispatchPrompt(mode.roleFor('implement'), 'Build x.')).toBe('Build x.')
  })
})

describe('team_dispatch dispatch', () => {
  it('routes through the default mode, carries its pinned route, and composes the brief', async () => {
    const h = harness()
    const result = await h.dispatch({ kind: 'plan', description: 'Design slugify', prompt: 'Plan the slugify module.' }, new AbortController().signal)
    expect(result).toEqual({
      kind: 'dispatch', subagentId: 'child-1', mode: 'fast', role: 'planner', model: 'm-strong', escalates: true, recent: [],
    })
    expect(h.preflighted).toEqual(['deepseek-official/m-strong/high', 'deepseek-official/m-strongest/max'])
    expect(h.started).toHaveLength(1)
    const spec = h.started[0]
    if (spec === undefined) throw new Error('dispatch did not start a child')
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('Design slugify')
    expect(spec.delivery).toBe('parent')
    expect(spec.request.prompt[0]).toMatchObject({ type: 'text', text: 'Design first.\n\nPlan the slugify module.' })
    expect(spec.request.agentOptions).toEqual({ provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high' })
  })

  it('runs the requested mode\'s own role table and route', async () => {
    const h = harness()
    const result = await h.dispatch({ mode: 'strict', kind: 'implement', description: 'Do it', prompt: 'Implement x.' }, new AbortController().signal)
    expect(result).toMatchObject({ mode: 'strict', role: 'coder', model: 'm-pro' })
    expect(h.started[0]?.request.agentOptions).toEqual({ provider: 'deepseek-official', model: 'm-pro', reasoningEffort: 'high' })
  })

  it('runs the configured default mode even when it is not the first declared', async () => {
    const h = harness(config({ defaultMode: 'strict' }))
    const result = await h.dispatch({ kind: 'review', description: 'Review it', prompt: 'p' }, new AbortController().signal)
    expect(result).toMatchObject({ mode: 'strict', role: 'challenger' })
  })

  it('routes a kind only one mode declares when that mode is chosen', async () => {
    const h = harness()
    const result = await h.dispatch({ mode: 'strict', kind: 'review', description: 'Review it', prompt: 'Review x.' }, new AbortController().signal)
    expect(result).toMatchObject({ mode: 'strict', role: 'challenger', model: 'm-max' })
    expect(h.started[0]?.request.prompt[0]).toMatchObject({ type: 'text', text: 'Adversarial review only.\n\nReview x.' })
  })

  it('rejects a kind the chosen mode does not route, listing that mode\'s kinds', async () => {
    const h = harness()
    await expect(h.dispatch({ kind: 'review', description: 'd', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('mode "fast": unknown task kind "review"; declared kinds: "plan", "implement"')
    expect(h.started).toHaveLength(0)
  })

  it('rejects an undeclared mode through the schema enum before dispatch', async () => {
    const h = harness()
    await expect(h.dispatch({ mode: 'turbo', kind: 'plan', description: 'd', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('must be one of')
    expect(h.started).toHaveLength(0)
  })

  it('rejects an unknown kind through the schema enum with the kinds of every mode', async () => {
    const h = harness()
    await expect(h.dispatch({ kind: 'deploy', description: 'd', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('must be one of')
  })

  it('rejects when no calling agent owns the dispatch', async () => {
    const h = harness()
    await expect((h.definition as ExecutableDefinition).execute({ kind: 'plan', description: 'd', prompt: 'p' }, { signal: new AbortController().signal }))
      .rejects.toThrow('requires a calling agent')
  })

  it('caps concurrency per mode and releases slots when children settle', async () => {
    const h = harness()
    const signal = new AbortController().signal
    await h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, signal)
    await h.dispatch({ kind: 'plan', description: 'b', prompt: 'p' }, signal)
    await expect(h.dispatch({ kind: 'plan', description: 'c', prompt: 'p' }, signal))
      .rejects.toThrow('mode "fast": 2 dispatches already running (concurrency 2)')
    // A separate mode keeps its own budget.
    await h.dispatch({ mode: 'strict', kind: 'plan', description: 'd', prompt: 'p' }, signal)
    await expect(h.dispatch({ mode: 'strict', kind: 'plan', description: 'e', prompt: 'p' }, signal))
      .rejects.toThrow('mode "strict": 1 dispatches already running (concurrency 1)')
    h.settleChild(1, 'completed')
    await drained()
    expect(h.running('fast')).toBe(1)
    expect(h.running('strict')).toBe(1)
  })

  it('releases the slot when the preflight rejects', async () => {
    const team = resolveModes(config())
    let active = 0
    const failing = defineTeamDispatchTool({
      provider: PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable after preflight') } },
      depthFor: () => undefined,
      team: {
        ...inertSurface(team),
        admitDispatch: () => { active += 1 },
        releaseDispatch: () => { active -= 1 },
      },
      llm: { resolveCallConfig: async () => { throw new Error('route drifted') } },
    })
    await expect(executeThrough(failing, { kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('route drifted')
    expect(active).toBe(0)
  })

  it('records accepted dispatches with their mode, route, and settled outcome', async () => {
    const h = harness()
    await h.dispatch({ kind: 'plan', description: 'Design it', prompt: 'p' }, new AbortController().signal)
    expect(h.records).toEqual([
      { childId: 'child-1', mode: 'fast', kind: 'plan', role: 'planner', model: 'm-strong', label: 'Design it', route: 'primary' },
    ])
    h.settleChild(1, 'completed')
    await drained()
    expect(h.settled.has('child-1')).toBe(true)
    expect(h.records[0]?.outcome).toBe('completed')
  })

  it('lists recent labels of the same kind across modes, excluding the current child', async () => {
    const h = harness()
    await h.dispatch({ kind: 'plan', description: 'First plan', prompt: 'p' }, new AbortController().signal)
    const result = await h.dispatch({ mode: 'strict', kind: 'plan', description: 'Second plan', prompt: 'p' }, new AbortController().signal)
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

  it('rejects a non-object-rooted output schema at the tool boundary', async () => {
    const h = harness()
    await expect(h.dispatch({ kind: 'plan', description: 'd', prompt: 'p', output_schema: { type: 'string' } }, new AbortController().signal))
      .rejects.toThrow()
    expect(h.started).toHaveLength(0)
  })

  it('rejects an output schema when the provider lacks the capability', async () => {
    const team = resolveModes(config())
    const noSchema = defineTeamDispatchTool({
      provider: NO_SCHEMA_PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable') } },
      depthFor: () => undefined,
      team: inertSurface(team),
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })
    await expect(executeThrough(noSchema, { kind: 'plan', description: 'd', prompt: 'p', output_schema: { type: 'object' } }, new AbortController().signal))
      .rejects.toThrow('does not support structured child output')
  })

  it('carries the role preset and the chosen mode\'s depth cap into the child request', async () => {
    const cfg = config()
    const presetCfg: Config = {
      ...cfg,
      modes: {
        ...cfg.modes,
        fast: fastMode({ roles: { ...fastMode().roles, coder: { ...fastMode().roles.coder!, preset: 'minimal' } } }),
      },
    }
    const team = resolveModes(presetCfg)
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
      depthFor: mode => mode === 'fast' ? 4 : 2,
      team: inertSurface(team),
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })
    await executeThrough(definition, { kind: 'implement', description: 'd', prompt: 'p' }, new AbortController().signal)
    expect(started[0]?.request.agentPreset).toBe('minimal')
    expect(started[0]?.request.maxDepth).toBe(4)
  })

  it('rejects definition when a role declares a preset the provider cannot honor, naming its mode', () => {
    const cfg = config()
    const presetCfg: Config = {
      ...cfg,
      modes: {
        ...cfg.modes,
        strict: strictMode({ roles: { ...strictMode().roles, challenger: { ...strictMode().roles.challenger!, preset: 'review-preset' } } }),
      },
    }
    const team = resolveModes(presetCfg)
    expect(() => defineTeamDispatchTool({
      provider: NO_PRESET_PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable') } },
      depthFor: () => undefined,
      team: inertSurface(team),
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })).toThrow('does not support child agent presets (roles with presets: "strict/challenger")')
  })

  it('names a single-mode preset by its role alone', () => {
    const cfg = config({ modes: { fast: fastMode({ roles: { ...fastMode().roles, coder: { ...fastMode().roles.coder!, preset: 'minimal' } } }) } })
    const team = resolveModes(cfg)
    expect(() => defineTeamDispatchTool({
      provider: NO_PRESET_PROVIDER,
      subagents: { startActivation: async () => { throw new Error('unreachable') } },
      depthFor: () => undefined,
      team: inertSurface(team),
      llm: { resolveCallConfig: async call => ({ ...call }) },
    })).toThrow('(roles with presets: "coder")')
  })
})

describe('mode parameter exposure', () => {
  it('omits the mode parameter when only one mode is declared', () => {
    const definition = harness(config({ modes: { fast: fastMode() } })).definition
    expect(parametersOf(definition).properties?.mode).toBeUndefined()
    expect(definition.description).toContain('you choose only the kind')
  })

  it('exposes the mode enum and the default when several modes are declared', () => {
    const definition = harness().definition
    const parameters = parametersOf(definition)
    const mode = parameters.properties?.mode
    expect(mode?.enum).toEqual(['fast', 'strict'])
    expect(mode?.description).toContain('"fast"')
    expect(parameters.required ?? []).not.toContain('mode')
    expect(definition.description).toContain('you choose the mode, the kind')
  })
})

describe('fallback escalation', () => {
  it('re-dispatches a failed primary child on the fallback route, keeping its mode', async () => {
    const h = harness()
    await h.dispatch({ kind: 'plan', description: 'Design it', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'max-tokens')
    await drained()
    expect(h.started).toHaveLength(2)
    const fallback = h.started[1]
    if (fallback === undefined) throw new Error('fallback did not start')
    expect(fallback.label).toBe('Design it (fallback)')
    expect(fallback.request.agentOptions).toEqual({ provider: 'deepseek-official', model: 'm-strongest', reasoningEffort: 'max' })
    const text = (fallback.request.prompt[0] as { text: string }).text
    expect(text).toContain('stop reason: max-tokens')
    expect(text).toContain('escalation running a stronger model')
    expect(h.records[0]).toMatchObject({ childId: 'child-2', mode: 'fast', route: 'fallback', label: 'Design it (fallback)', kind: 'plan' })
    expect(h.records[1]).toMatchObject({ childId: 'child-1', mode: 'fast', route: 'primary', outcome: 'max-tokens' })
    h.settleChild(2, 'completed')
    await drained()
    expect(h.records[0]?.outcome).toBe('completed')
    expect(h.running('fast')).toBe(0)
  })

  it('does not escalate a completed or cancelled primary child', async () => {
    const h = harness()
    await h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'completed')
    await drained()
    expect(h.started).toHaveLength(1)
    await h.dispatch({ kind: 'plan', description: 'b', prompt: 'p' }, new AbortController().signal)
    h.settleChild(2, 'aborted')
    await drained()
    expect(h.started).toHaveLength(2)
    expect(h.warnings).toEqual([])
  })

  it('does not escalate when the role declares no fallback', async () => {
    const h = harness()
    await h.dispatch({ kind: 'implement', description: 'a', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'error')
    await drained()
    expect(h.started).toHaveLength(1)
    expect(h.records[0]?.outcome).toBe('error')
  })

  it('never escalates the fallback attempt itself', async () => {
    const h = harness()
    await h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'error')
    await drained()
    h.settleChild(2, 'error')
    await drained()
    expect(h.started).toHaveLength(2)
  })

  it('keeps a non-default mode\'s fallback inside that mode', async () => {
    const h = harness()
    await h.dispatch({ mode: 'strict', kind: 'implement', description: 'Do it', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'error')
    await drained()
    expect(h.started).toHaveLength(2)
    expect(h.started[1]?.request.agentOptions).toEqual({
      provider: 'deepseek-official', model: 'm-max', reasoningEffort: 'max',
    })
    expect(h.records[0]).toMatchObject({ childId: 'child-2', mode: 'strict', route: 'fallback' })
    expect(h.running('strict')).toBe(1)
    expect(h.running('fast')).toBe(0)
    h.settleChild(2, 'completed')
    await drained()
    expect(h.running('strict')).toBe(0)
    expect(h.records[0]?.outcome).toBe('completed')
  })
})

describe('start and fallback failure paths', () => {
  it('releases the slot when starting the primary child fails', async () => {
    const h = harness(config(), { failStartCall: 1 })
    await expect(h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal))
      .rejects.toThrow('start refused')
    expect(h.started).toHaveLength(0)
    expect(h.running('fast')).toBe(0)
  })

  it('warns and skips the fallback when no concurrency slot is free', async () => {
    const h = harness(config(), { refuseAdmitCall: 2 })
    await h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'error')
    await drained()
    expect(h.started).toHaveLength(1)
    expect(h.warnings[0]).toContain('mode "fast" skipped, no free concurrency slot')
    expect(h.running('fast')).toBe(0)
  })

  it('releases the fallback slot and warns when the fallback child cannot start', async () => {
    const h = harness(config(), { failStartCall: 2 })
    await h.dispatch({ kind: 'plan', description: 'a', prompt: 'p' }, new AbortController().signal)
    h.settleChild(1, 'error')
    await drained()
    expect(h.started).toHaveLength(1)
    expect(h.records).toHaveLength(1)
    expect(h.warnings[0]).toContain('mode "fast" failed to start')
    expect(h.running('fast')).toBe(0)
  })
})

describe('captainSectionText', () => {
  it('renders the single mode\'s kind to role and route table unchanged', () => {
    const team = resolveModes(config({ modes: { fast: fastMode() } }))
    const text = captainSectionText(team)
    expect(text).toContain('each kind runs on its configured role and model route')
    expect(text).toContain('`plan` → role `planner` (`m-strong` at `high` reasoning effort)')
    expect(text).toContain('`implement` → role `coder` (`m-fast` at `low` reasoning effort)')
    expect(text).toContain('implementer of last resort')
  })

  it('renders every mode, its kinds, and its discipline when several are declared', () => {
    const text = captainSectionText(resolveModes(config()))
    expect(text).toContain('choose the `mode` whose roles, routes, and flow fit the task')
    expect(text).toContain('`fast` (default): `plan` → `planner` (`m-strong` at `high`), `implement` → `coder` (`m-fast` at `low`)')
    expect(text).toContain('`strict`: `plan` → `planner` (`m-max` at `max`), `implement` → `coder` (`m-pro` at `high`), `review` → `challenger` (`m-max` at `high`)')
    expect(text).toContain('  Every implementation is followed by a review dispatch.')
    expect(text).toContain('implementer of last resort')
  })

  it('renders a single mode\'s discipline after its table', () => {
    const text = captainSectionText(resolveModes(config({ modes: { strict: strictMode() }, defaultMode: 'strict' })))
    expect(text).toContain('`review` → role `challenger` (`m-max` at `high` reasoning effort)')
    expect(text).toContain('  Every implementation is followed by a review dispatch.')
  })
})
