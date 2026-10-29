/**
 * The model-facing `team_status` tool: one snapshot of the dispatch registry —
 * concurrency against the cap, per-role dispatch counts, and summed
 * provider-reported token usage of settled dispatches. Registry state is this
 * process's in-memory record; it does not survive restarts.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/status
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { UsageSnapshot } from './dispatch.ts';
import type { DispatchRecord } from './dispatch.ts';
import type { ResolvedRole } from './roles.ts';
/** The registry surface `team_status` reports; narrowed for direct unit testing. */
export interface TeamStatusDeps {
    /** Declared task kinds, in configuration order. */
    readonly kinds: readonly string[];
    /** Resolve one kind to its routed role. */
    roleFor(kind: string): ResolvedRole;
    /** Dispatches currently running against the cap. */
    runningDispatches(): number;
    /** Maximum concurrently running dispatched children. */
    maxConcurrency(): number;
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
/**
 * Fold the registry into per-role status rows, in role-declaration order.
 * @param deps - status dependencies.
 * @returns one row per role reached through the routing table.
 */
export declare function roleStatusRows(deps: TeamStatusDeps): readonly RoleStatus[];
/**
 * Build the `team_status` tool definition.
 * @param deps - status dependencies.
 * @returns the tool definition.
 */
export declare function defineTeamStatusTool(deps: TeamStatusDeps): ToolDefinition;
//# sourceMappingURL=status.d.ts.map