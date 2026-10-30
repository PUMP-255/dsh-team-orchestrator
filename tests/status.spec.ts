/** Unit behavior of the `team_status` tool and the per-mode registry fold. */
import { describe, expect, it } from 'vitest'
import type { DispatchRecord } from '../src/dispatch.ts'
import type { Config, ModeConfig } from '../src/config.ts'
import { resolveModes } from '../src/roles.ts'
import { defineTeamStatusTool, modeStatusRows } from '../src/status.ts'
import type { TeamStatusDeps } from '../src/status.ts'

function fastMode(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    concurrency: 2,
    maxDepth: 'provider-managed',
    roles: {
      planner: { provider: 'p', model: 'm-strong', reasoningEffort: 'high' },
      coder: { provider: 'p', model: 'm-fast', reasoningEffort: 'low' },
    },
    taskRouting: { plan: 'planner', implement: 'coder' },
    ...overrides,
  }
}

function strictMode(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    concurrency: 1,
    maxDepth: 'provider-managed',
    roles: {
      planner: { provider: 'p', model: 'm-max', reasoningEffort: 'max' },
      challenger: { provider: 'p', model: 'm-max', reasoningEffort: 'high' },
    },
    taskRouting: { plan: 'planner', review: 'challenger' },
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

const USAGE_A = { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5 }
const USAGE_B = { uncachedInputTokens: 200, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }

const RECORDS: readonly DispatchRecord[] = [
  { childId: 'c2', mode: 'fast', kind: 'implement', role: 'coder', model: 'm-fast', label: 'Second', usage: USAGE_B },
  { childId: 'c1', mode: 'fast', kind: 'plan', role: 'planner', model: 'm-strong', label: 'First', usage: USAGE_A },
  { childId: 'c3', mode: 'strict', kind: 'plan', role: 'planner', model: 'm-max', label: 'Strict plan', usage: USAGE_B },
]

function deps(overrides?: { settled?: string[]; running?: Record<string, number>; cfg?: Config }): TeamStatusDeps {
  const cfg = overrides?.cfg ?? config()
  const team = resolveModes(cfg)
  return {
    modes: [...team.modes.values()],
    runningDispatches: mode => overrides?.running?.[mode] ?? 0,
    maxConcurrency: mode => team.modes.get(mode)?.concurrency ?? 0,
    registry: RECORDS,
    settledChildIds: new Set(overrides?.settled ?? []),
  }
}

type PortableRender = (args: unknown, value: unknown) => { type: string; text: string }[]

function renderText(definition: ReturnType<typeof defineTeamStatusTool>, value: unknown): string {
  const render = definition.output.render as unknown as PortableRender
  return render({}, value)[0]?.text ?? ''
}

describe('modeStatusRows', () => {
  it('folds each mode separately and never leaks another mode\'s records', () => {
    const rows = modeStatusRows(deps({ settled: ['c3'], running: { fast: 1 } }))
    expect(rows.map(mode => mode.mode)).toEqual(['fast', 'strict'])
    expect(rows[0]).toEqual({
      mode: 'fast',
      running: 1,
      concurrency: 2,
      roles: [
        { role: 'planner', model: 'm-strong', effort: 'high', dispatched: 1, running: 1, failed: 0, labels: ['First'], usage: USAGE_A },
        { role: 'coder', model: 'm-fast', effort: 'low', dispatched: 1, running: 1, failed: 0, labels: ['Second'], usage: USAGE_B },
      ],
    })
    expect(rows[1]).toEqual({
      mode: 'strict',
      running: 0,
      concurrency: 1,
      roles: [
        { role: 'planner', model: 'm-max', effort: 'max', dispatched: 1, running: 0, failed: 0, labels: ['Strict plan'], usage: USAGE_B },
        { role: 'challenger', model: 'm-max', effort: 'high', dispatched: 0, running: 0, failed: 0, labels: [] },
      ],
    })
  })

  it('sums usage across one mode-role\'s settled dispatches only', () => {
    const records: readonly DispatchRecord[] = [
      { childId: 'c4', mode: 'fast', kind: 'plan', role: 'planner', model: 'm-strong', label: 'Third', usage: USAGE_B },
      ...RECORDS,
    ]
    const rows = modeStatusRows({ ...deps({ settled: ['c3'] }), registry: records })
    expect(rows[0]?.roles[0]?.usage).toEqual({
      uncachedInputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    })
    expect(rows[1]?.roles[0]?.usage).toEqual(USAGE_B)
  })

  it('omits usage when no dispatch of a mode-role settled readably', () => {
    const records: readonly DispatchRecord[] = RECORDS.map(record => ({ ...record, usage: undefined }))
    const rows = modeStatusRows({ ...deps(), registry: records })
    expect(rows.every(mode => mode.roles.every(row => row.usage === undefined))).toBe(true)
  })

  it('counts only unsettled children as running', () => {
    const rows = modeStatusRows(deps({ settled: ['c1', 'c2', 'c3'] }))
    expect(rows.every(mode => mode.roles.every(row => row.running === 0))).toBe(true)
  })

  it('keeps zero rows for roles a mode\'s routing reaches but nothing dispatched', () => {
    const rows = modeStatusRows(deps())
    expect(rows[0]?.roles).toHaveLength(2)
    expect(rows[1]?.roles).toHaveLength(2)
  })
})

describe('team_status execute', () => {
  it('reports one nested block per mode', async () => {
    const definition = defineTeamStatusTool(deps({ settled: ['c3'], running: { fast: 1 } }))
    const result = await definition.execute({}, {
      signal: new AbortController().signal,
    } as never)
    expect(result).toEqual({
      kind: 'status',
      modes: [
        {
          mode: 'fast',
          running: 1,
          concurrency: 2,
          roles: [
            { role: 'planner', model: 'm-strong', effort: 'high', dispatched: 1, running: 1, failed: 0, usage: USAGE_A },
            { role: 'coder', model: 'm-fast', effort: 'low', dispatched: 1, running: 1, failed: 0, usage: USAGE_B },
          ],
        },
        {
          mode: 'strict',
          running: 0,
          concurrency: 1,
          roles: [
            { role: 'planner', model: 'm-max', effort: 'max', dispatched: 1, running: 0, failed: 0, usage: USAGE_B },
            { role: 'challenger', model: 'm-max', effort: 'high', dispatched: 0, running: 0, failed: 0 },
          ],
        },
      ],
    })
  })
})

describe('team_status render', () => {
  it('keeps the single-mode rendering free of mode names', () => {
    const definition = defineTeamStatusTool(deps({ settled: ['c3'], running: { fast: 1 }, cfg: config({ modes: { fast: fastMode() } }) }))
    const value = {
      kind: 'status',
      modes: [{
        mode: 'fast',
        running: 1,
        concurrency: 2,
        roles: [
          { role: 'planner', model: 'm-strong', effort: 'high', dispatched: 1, running: 1, failed: 0, usage: USAGE_A },
          { role: 'coder', model: 'm-fast', effort: 'low', dispatched: 1, running: 1, failed: 0, usage: USAGE_B },
        ],
      }],
    }
    expect(renderText(definition, value)).toBe('dispatches 1/2 running\n'
      + 'planner: 1 running / 1 dispatched (m-strong at high; tokens in/out 100/40)\n'
      + 'coder: 1 running / 1 dispatched (m-fast at low; tokens in/out 200/60)')
  })

  it('names each mode in the header and on every row when several are declared', () => {
    const definition = defineTeamStatusTool(deps({ settled: ['c3'], running: { fast: 1 } }))
    const value = {
      kind: 'status',
      modes: [
        {
          mode: 'fast', running: 1, concurrency: 2,
          roles: [
            { role: 'planner', model: 'm-strong', effort: 'high', dispatched: 1, running: 1, failed: 0, usage: USAGE_A },
            { role: 'coder', model: 'm-fast', effort: 'low', dispatched: 1, running: 1, failed: 0 },
          ],
        },
        {
          mode: 'strict', running: 0, concurrency: 1,
          roles: [
            { role: 'challenger', model: 'm-max', effort: 'high', dispatched: 2, running: 0, failed: 1 },
          ],
        },
      ],
    }
    const text = renderText(definition, value)
    expect(text.split('\n')[0]).toBe('dispatches running: fast 1/2, strict 0/1')
    expect(text).toContain('fast/planner: 1 running / 1 dispatched (m-strong at high; tokens in/out 100/40)')
    expect(text).toContain('fast/coder: 1 running / 1 dispatched (m-fast at low)')
    expect(text).toContain('strict/challenger: 0 running / 2 dispatched, 1 failed (m-max at high)')
  })
})
