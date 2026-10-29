/**
 * Role-pinned team delegation: a configuration-declared role table resolves
 * task kinds to per-role child LLM routes. Roles are host-pinned data — the
 * model never names a route. The `team_dispatch` tool and the captain prompt
 * section mount when the configured subagent provider registers, and failed
 * primary children escalate once to their role's fallback route.
 *
 * @module @deepseek-ai/dsh-team-orchestrator
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { Config } from './config.ts'
import { ConfigSchema } from './config.ts'
import {
  resolveRoles,
  resolveTaskKind,
  validateRoleRoutes,
  type ResolvedRole,
} from './roles.ts'
import {
  captainSectionText,
  defineTeamDispatchTool,
  type DispatchRecord,
} from './dispatch.ts'
import { defineTeamStatusTool } from './status.ts'
import { teamUsageProjectionDefinition } from './usage-projection.ts'

export type { Config, RoleConfig, FallbackConfig } from './config.ts'
export { resolveRoles, resolveTaskKind, validateRoleRoutes } from './roles.ts'
export type { ResolvedRole } from './roles.ts'
export { composeDispatchPrompt, captainSectionText, defineTeamDispatchTool } from './dispatch.ts'
export type { DispatchArgs, DispatchRecord, TeamDispatchDeps, UsageSnapshot } from './dispatch.ts'
export { defineTeamStatusTool, roleStatusRows } from './status.ts'
export type { RoleStatus, TeamStatusDeps } from './status.ts'
export { teamUsageProjectionDefinition } from './usage-projection.ts'
export type { TeamUsageProjection, TeamUsageState } from './usage-projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Role-pinned team delegation. */
    teamOrchestrator: TeamOrchestrator
  }
}

/**
 * Owns the resolved role table and the `team_dispatch` delegation tool.
 * Structural and referential validation rejects at mount; live route
 * validation runs against the LLM runtime at init and, when a provider
 * adapter has not registered yet, re-runs on `llm/adapters-updated` — the
 * earliest resolvable point for each route. The tool and captain section mount
 * when the configured subagent provider registers.
 */
export class TeamOrchestrator extends Service {
  static inject = ['llm', 'tools', 'subagents', 'systemPrompt', 'sessionProjections', 'agents']

  static Config = ConfigSchema

  private readonly config: Config
  private readonly roles: ReadonlyMap<string, ResolvedRole>
  private activeDispatches = 0
  private readonly dispatchRecords: DispatchRecord[] = []
  private readonly settledChildren = new Set<string>()
  private readonly childSessions = new Map<string, Session>()
  private disposeUsageProjection: (() => void) | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'teamOrchestrator')
    this.config = config
    this.roles = resolveRoles(config)
  }

  protected async [Service.init](): Promise<void> {
    await this.initRouteValidation()
    await this.initPresetValidation()
    this.initUsageCapture()
    this.initDelegationTool()
  }

  /**
   * Validate every declared role preset against the agent-presets registry,
   * the earliest resolvable point: an unknown preset id rejects this mount.
   */
  private async initPresetValidation(): Promise<void> {
    const presetIds = [...new Set([...this.roles.values()]
      .map(role => role.preset)
      .filter((preset): preset is string => preset !== undefined))]
    if (presetIds.length === 0) return
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      throw new Error('team-orchestrator: role presets require the agent-presets service')
    }
    for (const id of presetIds) {
      await presets.resolve(id)
    }
  }

  /**
   * Capture settled children's provider-reported usage off this package's own
   * usage projection (keyed independently of the harness token-meter's
   * `tokenUsage` unit, which published DSH releases register themselves). The
   * child's live Session is retained at `subagent/start` — which precedes the
   * dispatch tool's own registry write, so retention is not gated on a
   * recorded dispatch — and released at the paired end. A held Session's
   * committed events stay foldable after child disposal, so the end edge reads
   * final totals.
   */
  private initUsageCapture(): void {
    try {
      const dispose = this.ctx.sessionProjections.register(teamUsageProjectionDefinition)
      this.disposeUsageProjection = dispose
      this.ctx.effect(() => () => { this.disposeUsageProjection?.() })
    } catch (error) {
      this.ctx.logger.error('team-orchestrator: token usage projection unavailable: %s', error)
    }
    this.ctx.effect(() => this.ctx.on('subagent/start', (info) => {
      const session = this.ctx.agents.get(info.id)?.session
      if (session !== undefined) this.childSessions.set(info.id, session)
    }))
    this.ctx.effect(() => this.ctx.on('subagent/end', (info) => { this.captureUsage(info) }))
  }

  /**
   * Read one settled child's usage totals onto its dispatch record.
   * @param info - the settled run's end payload.
   */
  private captureUsage(info: SubagentRunEndInfo): void {
    const record = this.dispatchRecords.find(entry => entry.childId === info.id)
    const session = this.childSessions.get(info.id)
    this.childSessions.delete(info.id)
    if (record === undefined || session === undefined || record.usage !== undefined) return
    const state = this.ctx.sessionProjections.stateOf(session, 'teamOrchestratorUsage')
    if (state === undefined) return
    record.usage = { ...state.totals }
  }

  /** Validate declared routes, deferring until every provider adapter registers. */
  private async initRouteValidation(): Promise<void> {
    const deferred = await validateRoleRoutes(this.ctx.llm, this.roles)
    if (deferred.length === 0) return
    const disposeRetry = this.ctx.effect(() => this.ctx.on('llm/adapters-updated', () => {
      void validateRoleRoutes(this.ctx.llm, this.roles)
        .then(async (stillDeferred) => {
          if (stillDeferred.length === 0) await disposeRetry()
        })
        .catch((error: unknown) => {
          this.ctx.logger.error('team-orchestrator: declared route rejected by the LLM runtime: %s', error)
        })
    }))
  }

  /** Mount `team_dispatch` and the captain section once the provider registers. */
  private initDelegationTool(): void {
    let mounted = false
    const tryMount = (provider: SubagentProvider): void => {
      if (provider.name !== this.config.provider || mounted) return
      const maxDepth = this.ctx.subagents.resolveMaxDepth(this.config.maxDepth)
      if (maxDepth !== undefined && !provider.capabilities.depthLimit) {
        throw new Error(`team-orchestrator: provider "${provider.name}" cannot enforce maxDepth`
          + ' (no depthLimit capability) — set maxDepth: \'provider-managed\' to leave the recursion budget to the provider')
      }
      const definition = defineTeamDispatchTool({
        provider,
        subagents: this.ctx.subagents,
        ...maxDepth === undefined ? {} : { maxDepth },
        team: {
          kinds: this.kinds,
          roleFor: kind => this.roleFor(kind),
          roleForKinds: () => this.kinds.map(kind => this.roleFor(kind)),
          admitDispatch: () => { this.admitDispatch() },
          releaseDispatch: () => { this.releaseDispatch() },
          recordDispatch: (entry) => { this.recordDispatch(entry) },
          markSettled: (childId) => { this.markSettled(childId) },
          markOutcome: (childId, outcome) => { this.markOutcome(childId, outcome) },
          recentLabelsFor: (kind, excludeChildId) => this.recentLabelsFor(kind, excludeChildId),
        },
        llm: this.ctx.llm,
        onWarn: (message) => { this.ctx.logger.warn(message) },
      })
      const statusDefinition = defineTeamStatusTool({
        kinds: this.kinds,
        roleFor: kind => this.roleFor(kind),
        runningDispatches: () => this.runningDispatches,
        maxConcurrency: () => this.maxConcurrency,
        registry: this.dispatchRecords,
        settledChildIds: this.settledChildren,
      })
      const disposeTool = this.ctx.effect(() => {
        const disposeDispatch = this.ctx.tools.register(definition)
        const disposeStatus = this.ctx.tools.register(statusDefinition)
        return () => {
          disposeStatus()
          disposeDispatch()
        }
      })
      const disposeSection = this.ctx.systemPrompt.section({
        // TOOL_TEAM_DISPATCH does not exist in published dsh-system-prompt
        // releases yet; the delegation guidance therefore shares the subagent
        // placement until a release carries the dedicated order name.
        name: 'team-orchestrator:captain',
        order: this.ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: (context) => {
          if (this.ctx.tools.get(definition.name, context.scope) !== definition) return ''
          return captainSectionText(this.kinds, kind => this.roleFor(kind))
        },
      })
      mounted = true
      this.ctx.effect(() => () => {
        disposeSection()
        void disposeTool()
        mounted = false
      })
    }
    this.ctx.effect(() => this.ctx.on('subagent/provider-added', tryMount))
    const initial = this.ctx.subagents.getProvider(this.config.provider)
    if (initial !== undefined) tryMount(initial)
    else {
      this.ctx.logger.info(`team-orchestrator: subagent provider "${this.config.provider}" not registered yet;`
        + ' the team_dispatch tool will register when it appears')
    }
  }

  /**
   * Resolve one task kind to its routed role.
   * @param kind - task kind requested by a caller.
   * @returns the routed role.
   */
  roleFor(kind: string): ResolvedRole {
    return resolveTaskKind(this.roles, this.config.taskRouting, kind)
  }

  /** Declared task kinds, in configuration order. */
  get kinds(): readonly string[] {
    return Object.keys(this.config.taskRouting)
  }

  /** Maximum concurrently running dispatched children. */
  get maxConcurrency(): number {
    return this.config.concurrency
  }

  /** Whether the captain may request a route outside the declared table. */
  get captainMayOverride(): boolean {
    return this.config.allowCaptainOverride
  }

  /**
   * Take one dispatch concurrency slot.
   * @throws when the configured cap is already running.
   */
  admitDispatch(): void {
    if (this.activeDispatches >= this.config.concurrency) {
      throw new Error(`team-orchestrator: ${this.activeDispatches} dispatches already running`
        + ` (concurrency ${this.config.concurrency}); wait for a completion notice before dispatching again`)
    }
    this.activeDispatches += 1
  }

  /** Return one dispatch concurrency slot after the dispatched child settles. */
  releaseDispatch(): void {
    this.activeDispatches -= 1
  }

  /**
   * Record one accepted dispatch for status reporting.
   * @param entry - the accepted dispatch's identifying data.
   */
  recordDispatch(entry: DispatchRecord): void {
    this.dispatchRecords.unshift(entry)
  }

  /**
   * Mark one recorded dispatch settled when its child run settles.
   * @param childId - the settled child's session id.
   */
  markSettled(childId: string): void {
    this.settledChildren.add(childId)
  }

  /**
   * Record the terminal outcome of one dispatch's child.
   * @param childId - the settled child's session id.
   * @param outcome - the child run's terminal stop reason.
   */
  markOutcome(childId: string, outcome: string): void {
    const record = this.dispatchRecords.find(entry => entry.childId === childId)
    if (record !== undefined) record.outcome = outcome
  }

  /**
   * Recent labels already dispatched for one kind, newest first.
   * @param kind - the task kind to look up.
   * @param excludeChildId - one child id to skip, conventionally the dispatch being answered.
   * @returns up to three labels of prior dispatches of this kind.
   */
  recentLabelsFor(kind: string, excludeChildId?: string): readonly string[] {
    return this.dispatchRecords
      .filter(record => record.kind === kind && record.childId !== excludeChildId)
      .map(record => record.label)
      .slice(0, 3)
  }

  /** Dispatches currently running against the concurrency cap. */
  get runningDispatches(): number {
    return this.activeDispatches
  }

  /** The dispatch registry snapshot, newest first. */
  get registry(): readonly DispatchRecord[] {
    return this.dispatchRecords
  }
}

export const name = 'team-orchestrator'
export default TeamOrchestrator
