/**
 * Pure mode resolution: config data in, resolved per-mode role tables out. Owns
 * the cross-field referent checks the schema cannot express (routing targets,
 * non-empty tables, the default mode) so misconfiguration rejects at the resolve
 * step. Each mode resolves independently: a role id and a task kind mean what
 * that mode declares them to mean.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/roles
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { Config, ModeConfig } from './config.ts';
/** One fully resolved role: its pinned child route and delegated-prompt discipline. */
export interface ResolvedRole {
    /** Role id from the configuration table. */
    readonly id: string;
    /** The pinned exact child route, with every field required. */
    readonly route: Readonly<{
        provider: string;
        model: string;
        reasoningEffort: ReturnType<typeof ReasoningEffortId>;
    }>;
    /** Child Agent options carrying the pinned route and output-token cap. */
    readonly options: AgentOptions;
    /** Role discipline prepended to every delegated prompt; absent when undeclared. */
    readonly brief?: string;
    /** Agent preset id the role's children join; absent when undeclared. */
    readonly preset?: string;
    /** The stronger escalation route; absent when the role declares no fallback. */
    readonly fallback?: {
        /** The exact escalation route. */
        readonly route: Readonly<{
            provider: string;
            model: string;
            reasoningEffort: ReturnType<typeof ReasoningEffortId>;
        }>;
        /** Child Agent options carrying the escalation route. */
        readonly options: AgentOptions;
    };
}
/** One fully resolved mode: its role table, routing surface, and flow budget. */
export interface ResolvedMode {
    /** Mode id from the configuration table. */
    readonly id: string;
    /** Mode discipline shown to the captain; absent when undeclared. */
    readonly brief?: string;
    /** Resolved roles by role id, keyed in declaration order. */
    readonly roles: ReadonlyMap<string, ResolvedRole>;
    /** This mode's task-kind routing, keyed in declaration order. */
    readonly taskRouting: Readonly<Record<string, string>>;
    /** This mode's task kinds, in declaration order. */
    readonly kinds: readonly string[];
    /** Maximum concurrently running dispatched children of this mode. */
    readonly concurrency: number;
    /** Delegation-depth policy for this mode's children. */
    readonly maxDepth: number | 'provider-managed';
    /** Resolve one task kind in this mode; rejects a kind the mode does not route. */
    roleFor(kind: string): ResolvedRole;
}
/** The resolved deployment: every declared mode plus the default one. */
export interface ResolvedTeam {
    /** Resolved modes by mode id, keyed in declaration order. */
    readonly modes: ReadonlyMap<string, ResolvedMode>;
    /** The mode a dispatch runs in when it omits `mode`. */
    readonly defaultMode: ResolvedMode;
    /** Union of every declared task kind, in mode-then-declaration order. */
    readonly kinds: readonly string[];
}
/**
 * Resolve one declared mode. Rejects an empty role table, an empty routing map,
 * routing that names a role the mode does not declare, and a fallback identical
 * to its primary route.
 * @param id - the mode id from the configuration table.
 * @param mode - that mode's validated configuration.
 * @returns the resolved mode.
 */
export declare function resolveMode(id: string, mode: ModeConfig): ResolvedMode;
/**
 * Resolve the declared mode table and pick the default mode.
 *
 * `defaultMode` must name a declared mode. It may be omitted only when exactly
 * one mode is declared, which then is the default; with several modes an
 * omitted default is rejected rather than guessed. A leftover 0.1 top-level
 * team field is rejected instead of silently ignored.
 * @param config - validated plugin configuration.
 * @returns every resolved mode, the default one, and the kind union.
 */
export declare function resolveModes(config: Config): ResolvedTeam;
/**
 * Resolve one task kind within one mode.
 * @param mode - the resolved mode the dispatch runs in.
 * @param kind - task kind requested by the caller.
 * @returns the routed role.
 */
export declare function resolveTaskKind(mode: ResolvedMode, kind: string): ResolvedRole;
/**
 * Flatten every mode's roles into one id-keyed table for route validation.
 * @param team - the resolved deployment.
 * @returns roles keyed by `mode/role`, in mode-then-declaration order.
 */
export declare function flattenRoles(team: ResolvedTeam): ReadonlyMap<string, ResolvedRole>;
/** The runtime surface route validation needs; narrow for test fakes. */
export type RouteValidatingLlm = Pick<LlmRuntime, 'resolveCallConfig'>;
/**
 * Validate every role's exact route against the live LLM runtime. Provider
 * lookup, model metadata, and effort admissibility are the runtime's owned
 * checks. Routes whose provider adapter is not registered yet are reported as
 * deferred instead of failing, so mount order does not reject a valid table.
 * @param llm - live LLM runtime.
 * @param roles - resolved role table, keyed by whatever id the caller reports.
 * @param signal - cancellation for adapter-owned capability lookups.
 * @returns ids of roles whose provider adapter was not registered yet.
 */
export declare function validateRoleRoutes(llm: RouteValidatingLlm, roles: ReadonlyMap<string, ResolvedRole>, signal?: AbortSignal): Promise<readonly string[]>;
//# sourceMappingURL=roles.d.ts.map