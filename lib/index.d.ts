/**
 * Mode-and-role-pinned team delegation: a configuration-declared mode table
 * resolves task kinds to per-role child LLM routes, and the captain selects one
 * mode per dispatch. Roles and routes are host-pinned data — the model chooses
 * only the mode and the task kind. The `team_dispatch` tool and the captain
 * prompt section mount when the configured subagent provider registers, and
 * failed primary children escalate once to their role's fallback route.
 *
 * @module @deepseek-ai/dsh-team-orchestrator
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
import { type ResolvedMode } from './roles.ts';
import { type DispatchRecord } from './dispatch.ts';
export type { Config, ModeConfig, RoleConfig, FallbackConfig } from './config.ts';
export { flattenRoles, resolveMode, resolveModes, resolveTaskKind, validateRoleRoutes } from './roles.ts';
export type { ResolvedMode, ResolvedRole, ResolvedTeam } from './roles.ts';
export { composeDispatchPrompt, captainSectionText, defineTeamDispatchTool } from './dispatch.ts';
export type { DispatchArgs, DispatchRecord, TeamDispatchDeps, UsageSnapshot } from './dispatch.ts';
export { defineTeamStatusTool, modeStatusRows } from './status.ts';
export type { ModeStatus, RoleStatus, TeamStatusDeps } from './status.ts';
export { teamUsageProjectionDefinition } from './usage-projection.ts';
export type { TeamUsageProjection, TeamUsageState } from './usage-projection.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Mode-and-role-pinned team delegation. */
        teamOrchestrator: TeamOrchestrator;
    }
}
/**
 * Owns the resolved mode table and the `team_dispatch` delegation tool.
 * Structural and referential validation rejects at mount; live route
 * validation runs against the LLM runtime at init and, when a provider
 * adapter has not registered yet, re-runs on `llm/adapters-updated` — the
 * earliest resolvable point for each route. The tool and captain section mount
 * when the configured subagent provider registers.
 */
export declare class TeamOrchestrator extends Service {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<Config>;
    private readonly config;
    private readonly team;
    private readonly activeDispatches;
    private readonly modeDepth;
    private readonly dispatchRecords;
    private readonly settledChildren;
    private readonly childSessions;
    private disposeUsageProjection;
    constructor(ctx: Context, config: Config);
    protected [Service.init](): Promise<void>;
    /**
     * Validate every declared role preset across every mode against the
     * agent-presets registry, the earliest resolvable point: an unknown preset id
     * rejects this mount.
     */
    private initPresetValidation;
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
    private initUsageCapture;
    /**
     * Read one settled child's usage totals onto its dispatch record.
     * @param info - the settled run's end payload.
     */
    private captureUsage;
    /** Validate declared routes of every mode, deferring until every provider adapter registers. */
    private initRouteValidation;
    /** Mount `team_dispatch`, `team_status`, and the captain section once the provider registers. */
    private initDelegationTool;
    /**
     * Resolve one declared mode.
     * @param mode - mode id requested by a caller.
     * @returns the resolved mode.
     */
    modeFor(mode: string): ResolvedMode;
    /** Declared modes, in configuration order. */
    get modes(): readonly ResolvedMode[];
    /** The mode a dispatch runs in when it omits `mode`. */
    get defaultMode(): ResolvedMode;
    /** Every declared task kind across modes, in mode-then-declaration order. */
    get kinds(): readonly string[];
    /** Whether the captain may request a route outside the declared table. */
    get captainMayOverride(): boolean;
    /**
     * Take one dispatch concurrency slot in one mode.
     * @param mode - the mode the dispatch runs in.
     * @throws when that mode's cap is already running.
     */
    admitDispatch(mode: string): void;
    /**
     * Return one dispatch concurrency slot to its mode after the dispatched child settles.
     * @param mode - the mode the dispatch ran in.
     */
    releaseDispatch(mode: string): void;
    /**
     * Record one accepted dispatch for status reporting.
     * @param entry - the accepted dispatch's identifying data.
     */
    recordDispatch(entry: DispatchRecord): void;
    /**
     * Mark one recorded dispatch settled when its child run settles.
     * @param childId - the settled child's session id.
     */
    markSettled(childId: string): void;
    /**
     * Record the terminal outcome of one dispatch's child.
     * @param childId - the settled child's session id.
     * @param outcome - the child run's terminal stop reason.
     */
    markOutcome(childId: string, outcome: string): void;
    /**
     * Recent labels already dispatched for one kind, newest first.
     * @param kind - the task kind to look up.
     * @param excludeChildId - one child id to skip, conventionally the dispatch being answered.
     * @returns up to three labels of prior dispatches of this kind, across modes.
     */
    recentLabelsFor(kind: string, excludeChildId?: string): readonly string[];
    /**
     * Dispatches currently running in one mode.
     * @param mode - the mode to report.
     * @returns that mode's running dispatches against its concurrency cap.
     */
    runningDispatches(mode: string): number;
    /**
     * One mode's concurrency cap.
     * @param mode - the mode to report.
     * @returns the mode's configured cap.
     */
    maxConcurrency(mode: string): number;
    /** The dispatch registry snapshot, newest first. */
    get registry(): readonly DispatchRecord[];
}
export declare const name = "team-orchestrator";
export default TeamOrchestrator;
//# sourceMappingURL=index.d.ts.map