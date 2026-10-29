/** Unit behavior of the `team_status` tool and the registry fold. */
import { describe, expect, it } from 'vitest'
import type { DispatchRecord } from '../src/dispatch.ts'
import type { Config } from '../src/config.ts'
import { resolveRoles } from '../src/roles.ts'
import { defineTeamStatusTool, roleStatusRows } from '../src/status.ts'

function config(): Config {
  return {
    provider: 'spawn',
    roles: {
      planner: { provider: 'p', model: 'm-strong', reasoningEffort: 'high' },
      coder: { provider: 'p', model: 'm-fast', reasoningEffort: 'low' },
    },
    taskRouting: { plan: 'planner', implement: 'coder' },
    concurrency: 2,
    allowCaptainOverride: false,
  }
}

const USAGE_A = { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5 }
const USAGE_B = { uncachedInputTokens: 200, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }

const RECORDS: readonly DispatchRecord[] = [
  { childId: 'c2', kind: 'implement', role: 'coder', model: 'm-fast', label: 'Second', usage: USAGE_B },
  { childId: 'c1', kind: 'plan', role: 'planner', model: 'm-strong', label: 'First', usage: USAGE_A },
]

function deps(overrides?: { settled?: string[]; running?: number }) {
  const cfg = config()
  const roles = resolveRoles(cfg)
  return {
    kinds: Object.keys(cfg.taskRouting),
    roleFor: (kind: string) => {
      const roleId = cfg.taskRouting[kind]
      const role = roleId === undefined ? undefined : roles.get(roleId)
      if (role === undefined) throw new Error(`unknown kind "${kind}"`)
      return role
    },
    runningDispatches: () => overrides?.running ?? 1,
    maxConcurrency: () => cfg.concurrency,
    registry: RECORDS,
    settledChildIds: new Set(overrides?.settled ?? []),
  }
}

describe('roleStatusRows', () => {
  it('folds the registry into role-declaration-order rows and sums captured usage', () => {
    const rows = roleStatusRows(deps())
    expect(rows).toEqual([
      { role: 'planner', model: 'm-strong', effort: 'high', dispatched: 1, running: 1, failed: 0, labels: ['First'], usage: USAGE_A },
      { role: 'coder', model: 'm-fast', effort: 'low', dispatched: 1, running: 1, failed: 0, labels: ['Second'], usage: USAGE_B },
    ])
  })

  it('sums usage across one role\'s settled dispatches', () => {
    const records: DispatchRecord[] = [
      { childId: 'c3', kind: 'plan', role: 'planner', model: 'm-strong', label: 'Third', usage: USAGE_B },
      ...RECORDS.filter(record => record.role === 'planner'),
    ]
    const rows = roleStatusRows({ ...deps(), registry: records })
    expect(rows[0]?.usage).toEqual({
      uncachedInputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    })
  })

  it('omits usage when no dispatch of a role settled readably', () => {
    const records: readonly DispatchRecord[] = RECORDS.map(record => ({ ...record, usage: undefined }))
    const rows = roleStatusRows({ ...deps(), registry: records })
    expect(rows.every(row => row.usage === undefined)).toBe(true)
  })

  it('does not count settled children as running', () => {
    const rows = roleStatusRows(deps({ settled: ['c1', 'c2'], running: 0 }))
    expect(rows.every(row => row.running === 0)).toBe(true)
  })

  it('keeps zero rows for roles the routing reaches but nothing dispatched', () => {
    const rows = roleStatusRows(deps({ settled: ['c1', 'c2'], running: 0 }))
    expect(rows).toHaveLength(2)
  })
})

describe('team_status execute', () => {
  it('reports the concurrency snapshot and per-role rows', async () => {
    const definition = defineTeamStatusTool(deps())
    const result = await definition.execute({}, {
      signal: new AbortController().signal,
    } as never)
    expect(result).toEqual({
      kind: 'status',
      running: 1,
      concurrency: 2,
      roles: [
        { role: 'planner', model: 'm-strong', effort: 'high', dispatched: 1, running: 1, failed: 0, usage: USAGE_A },
        { role: 'coder', model: 'm-fast', effort: 'low', dispatched: 1, running: 1, failed: 0, usage: USAGE_B },
      ],
    })
  })
})
