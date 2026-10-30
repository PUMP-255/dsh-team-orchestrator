/**
 * The model-facing `team_status` tool: one snapshot of the dispatch registry —
 * per-mode concurrency against each mode's cap, per-role dispatch counts, and
 * summed provider-reported token usage of settled dispatches. Registry state is
 * this process's in-memory record; it does not survive restarts.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/status
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { UsageSnapshot } from './dispatch.ts';
import type { DispatchRecord } from './dispatch.ts';
import type { ResolvedMode } from './roles.ts';
/** The registry surface `team_status` reports; narrowed for direct unit testing. */
export interface TeamStatusDeps {
    /** Declared modes, in configuration order. */
    readonly modes: readonly ResolvedMode[];
    /** Dispatches currently running in one mode. */
    runningDispatches(mode: string): number;
    /** One mode's concurrency cap. */
    maxConcurrency(mode: string): number;
    /** The dispatch registry snapshot, newest first. */
    readonly registry: readonly DispatchRecord[];
    /** Child ids recorded as settled. */
    readonly settledChildIds: ReadonlySet<string>;
}
/** Per-role status row. */
export interface RoleStatus {
    /** Role id. */
    readonly role: string;
    /** The role's pinned model id. */
    readonly model: string;
    /** The role's pinned reasoning effort. */
    readonly effort: string;
    /** Dispatches accepted for this role. */
    readonly dispatched: number;
    /** Dispatches still running. */
    readonly running: number;
    /** Settled dispatches whose child did not complete. */
    readonly failed: number;
    /** Labels of this role's dispatches, newest first. */
    readonly labels: readonly string[];
    /** Summed provider-reported usage of this role's settled dispatches; absent when none settled readably. */
    readonly usage?: UsageSnapshot;
}
/** Per-mode status: one mode's cap, running count, and role rows. */
export interface ModeStatus {
    /** Mode id. */
    readonly mode: string;
    /** Dispatches of this mode still running. */
    readonly running: number;
    /** This mode's concurrency cap. */
    readonly concurrency: number;
    /** Role rows of this mode, in the order its routing reaches them. */
    readonly roles: readonly RoleStatus[];
}
/**
 * Fold the registry into per-mode status, in mode-declaration order.
 * @param deps - status dependencies.
 * @returns one entry per declared mode.
 */
export declare function modeStatusRows(deps: TeamStatusDeps): readonly ModeStatus[];
/**
 * Build the `team_status` tool definition.
 * @param deps - status dependencies.
 * @returns the tool definition.
 */
export declare function defineTeamStatusTool(deps: TeamStatusDeps): ToolDefinition;
//# sourceMappingURL=status.d.ts.map