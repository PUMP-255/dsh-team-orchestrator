/**
 * The model-facing `team_status` tool: one snapshot of the dispatch registry —
 * per-mode concurrency against each mode's cap, per-role dispatch counts, and
 * summed provider-reported token usage of settled dispatches. Registry state is
 * this process's in-memory record; it does not survive restarts.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/status
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { UsageSnapshot } from './dispatch.ts'
import type { DispatchRecord } from './dispatch.ts'
import type { ResolvedMode } from './roles.ts'

/** The registry surface `team_status` reports; narrowed for direct unit testing. */
export interface TeamStatusDeps {
  /** Declared modes, in configuration order. */
  readonly modes: readonly ResolvedMode[]
  /** Dispatches currently running in one mode. */
  runningDispatches(mode: string): number
  /** One mode's concurrency cap. */
  maxConcurrency(mode: string): number
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
  /** Settled dispatches whose child did not complete. */
  readonly failed: number
  /** Labels of this role's dispatches, newest first. */
  readonly labels: readonly string[]
  /** Summed provider-reported usage of this role's settled dispatches; absent when none settled readably. */
  readonly usage?: UsageSnapshot
}

/** Per-mode status: one mode's cap, running count, and role rows. */
export interface ModeStatus {
  /** Mode id. */
  readonly mode: string
  /** Dispatches of this mode still running. */
  readonly running: number
  /** This mode's concurrency cap. */
  readonly concurrency: number
  /** Role rows of this mode, in the order its routing reaches them. */
  readonly roles: readonly RoleStatus[]
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
 * Fold one mode's registry slice into per-role rows, in the order the mode's
 * routing reaches roles.
 * @param mode - the resolved mode.
 * @param registry - the whole registry; records of other modes are ignored.
 * @param settledChildIds - child ids recorded as settled.
 * @returns one row per role the mode's routing reaches.
 */
function roleStatusRows(
  mode: ResolvedMode,
  registry: readonly DispatchRecord[],
  settledChildIds: ReadonlySet<string>,
): readonly RoleStatus[] {
  const rows = new Map<string, { row: RoleStatus; records: DispatchRecord[] }>()
  for (const kind of mode.kinds) {
    const role = mode.roleFor(kind)
    if (rows.has(role.id)) continue
    rows.set(role.id, {
      row: {
        role: role.id,
        model: role.route.model,
        effort: role.route.reasoningEffort,
        dispatched: 0,
        running: 0,
        failed: 0,
        labels: [],
      },
      records: [],
    })
  }
  for (const record of registry) {
    if (record.mode !== mode.id) continue
    const entry = rows.get(record.role)
    if (entry === undefined) continue
    const running = settledChildIds.has(record.childId) ? 0 : 1
    const failed = record.outcome !== undefined && record.outcome !== 'completed' ? 1 : 0
    entry.records.push(record)
    entry.row = {
      ...entry.row,
      dispatched: entry.row.dispatched + 1,
      running: entry.row.running + running,
      failed: entry.row.failed + failed,
      labels: [record.label, ...entry.row.labels],
    }
  }
  return [...rows.values()].map(({ row, records }) => {
    const usage = sumUsage(records)
    return usage === undefined ? row : { ...row, usage }
  })
}

/**
 * Fold the registry into per-mode status, in mode-declaration order.
 * @param deps - status dependencies.
 * @returns one entry per declared mode.
 */
export function modeStatusRows(deps: TeamStatusDeps): readonly ModeStatus[] {
  return deps.modes.map(mode => ({
    mode: mode.id,
    running: deps.runningDispatches(mode.id),
    concurrency: deps.maxConcurrency(mode.id),
    roles: roleStatusRows(mode, deps.registry, deps.settledChildIds),
  }))
}

/** One role row rendered as a line; `prefix` names the mode when several are declared. */
function renderRoleRow(row: Omit<RoleStatus, 'labels'>, prefix: string): string {
  const usage = row.usage === undefined
    ? ''
    : `; tokens in/out ${row.usage.uncachedInputTokens}/${row.usage.outputTokens}`
  const failed = row.failed === 0 ? '' : `, ${row.failed} failed`
  return `${prefix}${row.role}: ${row.running} running / ${row.dispatched} dispatched${failed} (${row.model} at ${row.effort}${usage})`
}

/**
 * Build the `team_status` tool definition.
 * @param deps - status dependencies.
 * @returns the tool definition.
 */
export function defineTeamStatusTool(deps: TeamStatusDeps): ToolDefinition {
  return defineTool({
    name: 'team_status',
    description: 'Report the team dispatch registry: each mode\'s concurrency against its cap, per-role dispatch counts, and summed provider-reported token usage of settled dispatches. Registry state is this process\'s record.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'status' },
          modes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                mode: { type: 'string', required: true },
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
                      failed: { type: 'number', required: true },
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
          },
        },
      },
      render: (_args, value) => {
        const several = value.modes.length > 1
        const header = several
          ? `dispatches running: ${value.modes.map(mode => `${mode.mode} ${mode.running}/${mode.concurrency}`).join(', ')}`
          : `dispatches ${value.modes[0]?.running ?? 0}/${value.modes[0]?.concurrency ?? 0} running`
        const rows = value.modes.flatMap(mode => mode.roles.map(row => renderRoleRow(row, several ? `${mode.mode}/` : '')))
        return [{ type: 'text', text: `${header}\n${rows.join('\n')}` }]
      },
    },
    isConcurrencySafe: () => true,
    execute() {
      const modes = modeStatusRows(deps).map(mode => ({
        mode: mode.mode,
        running: mode.running,
        concurrency: mode.concurrency,
        roles: mode.roles.map(row => ({
          role: row.role,
          model: row.model,
          effort: row.effort,
          dispatched: row.dispatched,
          running: row.running,
          failed: row.failed,
          ...row.usage === undefined ? {} : { usage: row.usage },
        })),
      }))
      return Promise.resolve({ kind: 'status' as const, modes })
    },
  })
}
