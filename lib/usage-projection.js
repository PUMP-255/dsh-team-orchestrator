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
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';
const zeroBuckets = () => ({
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
});
const bucketsFrom = (usage) => ({
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
});
const bucketsEqual = (left, right) => left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
const addReplacing = (totals, previous, next) => ({
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
});
const projectionSchema = z.object({
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
}).strict();
const stateSchema = z.object({
    totals: projectionSchema,
    last: z.object({
        turn: z.number().int().nonnegative(),
        step: z.number().int().nonnegative(),
        buckets: projectionSchema,
    }).nullable(),
}).strict();
/** The usage one durable Assistant settlement reports for its attempt, if any. */
function usageOf(event) {
    if (event.type === 'assistant/message' && event.data.usage !== undefined)
        return event.data.usage;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')
        return undefined;
    return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage;
}
/**
 * The team-orchestrator usage projection unit: an independent fold of the same
 * durable usage facts the harness token-meter watches, under this package's
 * own key.
 */
export const teamUsageProjectionDefinition = {
    key: 'teamOrchestratorUsage',
    stateVersion: 1,
    stateSchema,
    init: () => ({ totals: zeroBuckets(), last: null }),
    apply: (state, event) => {
        if (event.type === 'llm/retry-started') {
            return state.last?.turn === event.data.turn && state.last.step === event.data.step
                ? { ...state, last: null }
                : state;
        }
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
            return state;
        }
        const sample = usageOf(event);
        if (sample === undefined)
            return state;
        const { turn, step } = event.data;
        const usage = sample;
        const buckets = bucketsFrom(usage);
        const previous = state.last !== null
            && state.last.turn === turn
            && state.last.step === step
            ? state.last.buckets
            : undefined;
        if (previous !== undefined && bucketsEqual(previous, buckets))
            return state;
        return {
            totals: addReplacing(state.totals, previous, buckets),
            last: { turn, step, buckets },
        };
    },
    wire: { viewSchema: projectionSchema, view: state => state.totals },
};
//# sourceMappingURL=usage-projection.js.map