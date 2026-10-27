/**
 * The model-facing `team_dispatch` tool: kind-routed delegation through the
 * configured role table. The model declares what kind of task it is dispatching
 * and writes the brief; the plugin owns which role and route runs it.
 *
 * @module @deepseek-ai/dsh-experimental-team-orchestrator/dispatch
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import type { SubagentActivationSpec, SubagentActivation, SubagentProvider } from '@deepseek-ai/dsh-subagent';
import type { ResolvedRole, RouteValidatingLlm } from './roles.ts';
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
    /** Resolved delegation-depth cap for dispatched children; absent leaves the budget to the provider. */
    readonly maxDepth?: number;
    /** The resolved role table's model-facing surface. */
    readonly team: {
        /** Declared task kinds, in configuration order. */
        readonly kinds: readonly string[];
        /** Resolve one kind to its routed role; rejects unknown kinds. */
        roleFor(kind: string): ResolvedRole;
        /** The routed roles of all declared kinds, in configuration order. */
        roleForKinds(): readonly ResolvedRole[];
        /** Take one concurrency slot; rejects when the cap is reached. */
        admitDispatch(): void;
        /** Return one concurrency slot when the dispatched child settles. */
        releaseDispatch(): void;
        /** Record one accepted dispatch for status reporting. */
        recordDispatch(entry: DispatchRecord): void;
        /** Mark one recorded dispatch settled when its child run settles. */
        markSettled(childId: string): void;
        /** Recent labels already dispatched for one kind, newest first. */
        recentLabelsFor(kind: string, excludeChildId?: string): readonly string[];
    };
    /** Live LLM runtime for the dispatch-time route preflight. */
    readonly llm: RouteValidatingLlm;
}
/** One recorded dispatch, for `team_status` reporting. */
export interface DispatchRecord {
    /** The child agent's session id. */
    readonly childId: string;
    /** The dispatched task kind. */
    readonly kind: string;
    /** The routed role id. */
    readonly role: string;
    /** The role's pinned model id. */
    readonly model: string;
    /** The dispatcher's short display label. */
    readonly label: string;
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
 * The captain prompt section text: the kind→role routing table and briefing
 * discipline, rendered only where the tool is visible.
 * @param kinds - declared task kinds in configuration order.
 * @param roleFor - kind-to-role resolver.
 * @returns the section text.
 */
export declare function captainSectionText(kinds: readonly string[], roleFor: (kind: string) => ResolvedRole): string;
//# sourceMappingURL=dispatch.d.ts.map