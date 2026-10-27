/**
 * The model-facing `team_status` tool: one snapshot of the dispatch registry —
 * concurrency against the cap and per-role dispatch counts. Registry state is
 * this process's in-memory record; it does not survive restarts and does not
 * include token usage (deferred until a cross-session usage read exists).
 *
 * @module @deepseek-ai/dsh-team-orchestrator/status
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DispatchRecord, UsageSnapshot } from './dispatch.ts'
import type { ResolvedRole } from './roles.ts'

/** The registry surface `team_status` reports; narrowed for direct unit testing. */
export interface TeamStatusDeps {
  /** Declared task kinds, in configuration order. */
  readonly kinds: readonly string[]
  /** Resolve one kind to its routed role. */
  roleFor(kind: string): ResolvedRole
  /** Dispatches currently running against the cap. */
  runningDispatches(): number
  /** Maximum concurrently running dispatched children. */
  maxConcurrency(): number
  /** The dispatch registry snapshot, newest first. */
  readonly registry: readonly DispatchRecord[]
  /** Child ids recorded as settled. */
  readonly settledChildIds: ReadonlySet<string>
}

/** Per-role status row. */
export interface RoleStatus {
  /** Role id. */
  readonly role: string
  /** The role's pinned model id. */
  readonly model: string
  /** The role's pinned reasoning effort. */
  readonly effort: string
  /** Dispatches accepted for this role. */
  readonly dispatched: number
  /** Dispatches still running. */
  readonly running: number
  /** Labels of this role's dispatches, newest first. */
  readonly labels: readonly string[]
  /** Summed provider-reported usage of this role's settled dispatches; absent when none settled readably. */
  readonly usage?: UsageSnapshot
}

/** Sum captured usage snapshots; undefined when no record carries one. */
function sumUsage(records: readonly DispatchRecord[]): UsageSnapshot | undefined {
  const captured = records.filter(record => record.usage !== undefined)
  if (captured.length === 0) return undefined
  const totals: Record<keyof UsageSnapshot, number> = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  for (const record of captured) {
    const usage = record.usage
    if (usage === undefined) continue
    totals.uncachedInputTokens += usage.uncachedInputTokens
    totals.outputTokens += usage.outputTokens
    totals.cacheReadTokens += usage.cacheReadTokens
    totals.cacheWriteTokens += usage.cacheWriteTokens
  }
  return { ...totals }
}

/**
 * Fold the registry into per-role status rows, in role-declaration order.
 * @param deps - status dependencies.
 * @returns one row per role reached through the routing table.
 */
export function roleStatusRows(deps: TeamStatusDeps): readonly RoleStatus[] {
  const rows = new Map<string, { row: RoleStatus; records: DispatchRecord[] }>()
  for (const kind of deps.kinds) {
    const role = deps.roleFor(kind)
    if (rows.has(role.id)) continue
    rows.set(role.id, {
      row: {
        role: role.id,
        model: role.route.model,
        effort: role.route.reasoningEffort,
        dispatched: 0,
        running: 0,
        labels: [],
      },
      records: [],
    })
  }
  for (const record of deps.registry) {
    const entry = rows.get(record.role)
    if (entry === undefined) continue
    const running = deps.settledChildIds.has(record.childId) ? 0 : 1
    entry.records.push(record)
    entry.row = {
      ...entry.row,
      dispatched: entry.row.dispatched + 1,
      running: entry.row.running + running,
      labels: [record.label, ...entry.row.labels],
    }
  }
  return [...rows.values()].map(({ row, records }) => {
    const usage = sumUsage(records)
    return usage === undefined ? row : { ...row, usage }
  })
}

/**
 * Build the `team_status` tool definition.
 * @param deps - status dependencies.
 * @returns the tool definition.
 */
export function defineTeamStatusTool(deps: TeamStatusDeps): ToolDefinition {
  return defineTool({
    name: 'team_status',
    description: 'Report the team dispatch registry: concurrency against the cap, per-role dispatch counts, and summed provider-reported token usage of settled dispatches. Registry state is this process\'s record.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'status' },
          running: { type: 'number', required: true },
          concurrency: { type: 'number', required: true },
          roles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                model: { type: 'string', required: true },
                effort: { type: 'string', required: true },
                dispatched: { type: 'number', required: true },
                running: { type: 'number', required: true },
                usage: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uncachedInputTokens: { type: 'number', required: true },
                    outputTokens: { type: 'number', required: true },
                    cacheReadTokens: { type: 'number', required: true },
                    cacheWriteTokens: { type: 'number', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const rows = value.roles.map((row) => {
          const usage = row.usage === undefined
            ? ''
            : `; tokens in/out ${row.usage.uncachedInputTokens}/${row.usage.outputTokens}`
          return `${row.role}: ${row.running} running / ${row.dispatched} dispatched (${row.model} at ${row.effort}${usage})`
        })
        return [{
          type: 'text',
          text: `dispatches ${value.running}/${value.concurrency} running\n${rows.join('\n')}`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    execute() {
      const roles = roleStatusRows(deps).map(row => ({
        role: row.role,
        model: row.model,
        effort: row.effort,
        dispatched: row.dispatched,
        running: row.running,
        ...row.usage === undefined ? {} : { usage: row.usage },
      }))
      return Promise.resolve({
        kind: 'status' as const,
        running: deps.runningDispatches(),
        concurrency: deps.maxConcurrency(),
        roles,
      })
    },
  })
}
