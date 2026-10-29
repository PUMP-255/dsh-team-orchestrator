/**
 * Vendored token-usage projection unit, keyed independently of the harness's
 * own `tokenUsage` unit so this package works against published DSH releases
 * whose token-meter does not export its projection definition. The fold
 * mirrors that unit: each durable assistant settlement contributes the last
 * usage sample embedded in its stream, and `llm/retry-started` closes the
 * replacement slot so the retried attempt adds to the total.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/usage-projection
 */
import { z } from 'zod';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Provider-reported cumulative usage buckets for a complete session log. */
export interface TeamUsageProjection {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export interface TeamUsageState {
    totals: TeamUsageProjection;
    last: {
        turn: number;
        step: number;
        buckets: TeamUsageProjection;
    } | null;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        /** Team-orchestrator's independent per-session usage totals. */
        teamOrchestratorUsage: TeamUsageProjection;
    }
    interface SessionProjectionStateMap {
        teamOrchestratorUsage: TeamUsageState;
    }
}
/**
 * The team-orchestrator usage projection unit: an independent fold of the same
 * durable usage facts the harness token-meter watches, under this package's
 * own key.
 */
export declare const teamUsageProjectionDefinition: {
    key: "teamOrchestratorUsage";
    stateVersion: number;
    stateSchema: z.ZodObject<{
        totals: z.ZodObject<{
            uncachedInputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheWriteTokens: z.ZodNumber;
        }, z.core.$strict>;
        last: z.ZodNullable<z.ZodObject<{
            turn: z.ZodNumber;
            step: z.ZodNumber;
            buckets: z.ZodObject<{
                uncachedInputTokens: z.ZodNumber;
                outputTokens: z.ZodNumber;
                cacheReadTokens: z.ZodNumber;
                cacheWriteTokens: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strip>>;
    }, z.core.$strict>;
    init: () => {
        totals: TeamUsageProjection;
        last: null;
    };
    apply: (state: NoInfer<TeamUsageState>, event: SessionEvent) => TeamUsageState;
    wire: {
        viewSchema: z.ZodObject<{
            uncachedInputTokens: z.ZodNumber;
            outputTokens: z.ZodNumber;
            cacheReadTokens: z.ZodNumber;
            cacheWriteTokens: z.ZodNumber;
        }, z.core.$strict>;
        view: (state: NoInfer<TeamUsageState>) => TeamUsageProjection;
    };
};
//# sourceMappingURL=usage-projection.d.ts.map