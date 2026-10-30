/**
 * The model-facing `team_dispatch` tool: mode-and-kind-routed delegation through
 * the configured team. The model selects a mode (where several are declared) and
 * a task kind, and writes the brief; the plugin owns which roles exist, which
 * model and reasoning effort each role runs on, and escalates once to the role's
 * fallback route when the primary child fails.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/dispatch
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import type { SubagentActivationSpec, SubagentActivation, SubagentProvider } from '@deepseek-ai/dsh-subagent';
import type { ResolvedMode, ResolvedRole, ResolvedTeam, RouteValidatingLlm } from './roles.ts';
/** The subagent-runtime surface dispatch needs; narrowed for direct unit testing. */
export interface DispatchSubagents {
    /** Start one managed child activation through the named provider. */
    startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>;
}
/** What the dispatch path needs; narrowed for direct unit testing. */
export interface TeamDispatchDeps {
    /** The continuable subagent provider children run through (capabilities only). */
    readonly provider: SubagentProvider;
    /** The live subagent runtime that starts children. */
    readonly subagents: DispatchSubagents;
    /** Resolve one mode's delegation-depth cap; absent leaves the budget to the provider. */
    depthFor(mode: string): number | undefined;
    /** The resolved mode table's model-facing surface. */
    readonly team: {
        /** Declared modes, in configuration order. */
        readonly modes: readonly ResolvedMode[];
        /** The mode a dispatch runs in when it omits `mode`. */
        readonly defaultMode: ResolvedMode;
        /** Every declared task kind across modes, in declaration order (the `kind` enum). */
        readonly kinds: readonly string[];
        /** Resolve one mode id; rejects an undeclared mode. */
        modeFor(mode: string): ResolvedMode;
        /** Recent labels already dispatched for one kind, newest first. */
        recentLabelsFor(kind: string, excludeChildId?: string): readonly string[];
        /** Take one concurrency slot in one mode; rejects when that mode's cap is reached. */
        admitDispatch(mode: string): void;
        /** Return one concurrency slot to one mode when the dispatched child settles. */
        releaseDispatch(mode: string): void;
        /** Record one accepted dispatch for status reporting. */
        recordDispatch(entry: DispatchRecord): void;
        /** Mark one recorded dispatch settled when its child run settles. */
        markSettled(childId: string): void;
        /** Record the terminal outcome of one dispatch's child. */
        markOutcome(childId: string, outcome: string): void;
    };
    /** Live LLM runtime for the dispatch-time route preflight. */
    readonly llm: RouteValidatingLlm;
    /** Warn sink for fallback escalation that could not start; absent logs nothing. */
    readonly onWarn?: (message: string) => void;
}
/** One recorded dispatch, for `team_status` reporting. */
export interface DispatchRecord {
    /** The child agent's session id. */
    readonly childId: string;
    /** The mode the dispatch ran in. */
    readonly mode: string;
    /** The dispatched task kind. */
    readonly kind: string;
    /** The routed role id within that mode. */
    readonly role: string;
    /** The pinned model id this attempt ran on. */
    readonly model: string;
    /** The dispatcher's short display label. */
    readonly label: string;
    /** Whether this attempt is the role's primary route or its fallback escalation. */
    readonly route: 'primary' | 'fallback';
    /** The child's terminal stop reason; absent until the run settles. */
    outcome?: string;
    /** Provider-reported usage captured when the child settled; absent until then or when the child session is unreadable. */
    usage?: UsageSnapshot;
}
/** Provider-reported token totals of one settled dispatch, off the shared `tokenUsage` projection. */
export interface UsageSnapshot {
    /** Input tokens outside cache traffic. */
    readonly uncachedInputTokens: number;
    /** Output tokens. */
    readonly outputTokens: number;
    /** Cache-read tokens. */
    readonly cacheReadTokens: number;
    /** Cache-write tokens. */
    readonly cacheWriteTokens: number;
}
/** Validated `team_dispatch` arguments. */
export interface DispatchArgs {
    readonly mode?: string;
    readonly kind: string;
    readonly description: string;
    readonly prompt: string;
    readonly cwd?: string;
    readonly output_schema?: ObjectJsonSchema;
}
/**
 * Validate tool-call arguments at the tool JSON boundary.
 * @param value - raw parsed arguments.
 * @returns the validated arguments.
 */
export declare function assertDispatchArgs(value: unknown): asserts value is DispatchArgs;
/**
 * Compose the child prompt: the role's discipline line, then the brief.
 * @param role - the routed role.
 * @param prompt - the dispatcher's task brief.
 * @returns the composed child prompt.
 */
export declare function composeDispatchPrompt(role: ResolvedRole, prompt: string): string;
/**
 * Build the `team_dispatch` tool definition. The executor validates the schema,
 * so `execute` re-validates only as defense at the tool JSON boundary.
 * @param deps - dispatch dependencies.
 * @returns the tool definition.
 */
export declare function defineTeamDispatchTool(deps: TeamDispatchDeps): ToolDefinition;
/**
 * The captain prompt section text: the mode table, its kind→role routes, and the
 * briefing discipline, rendered only where the tool is visible.
 * @param team - the resolved deployment.
 * @returns the section text.
 */
export declare function captainSectionText(team: ResolvedTeam): string;
//# sourceMappingURL=dispatch.d.ts.map