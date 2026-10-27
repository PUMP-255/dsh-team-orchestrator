/**
 * Plugin configuration: the declared role table and the task-kind routing that
 * selects roles. Structure is validated here; cross-field referents (routing
 * targets, live model routes) are validated by {@link ./roles.ts} and the
 * service's init-time route check.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/config
 */
import z from '@deepseek-ai/schemastery';
/** Schemastery schema for {@link Config}; mount rejects on violation. */
export const ConfigSchema = z.object({
    provider: z.string().min(1).default('spawn'),
    roles: z.dict(z.object({
        provider: z.string().min(1).required(),
        model: z.string().min(1).required(),
        reasoningEffort: z.string().min(1).required(),
        brief: z.string(),
        preset: z.string().min(1),
    })).required(),
    taskRouting: z.dict(z.string().min(1)).required(),
    concurrency: z.natural().default(3),
    maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')]).default('provider-managed'),
    allowCaptainOverride: z.boolean().default(false),
});
//# sourceMappingURL=config.js.map