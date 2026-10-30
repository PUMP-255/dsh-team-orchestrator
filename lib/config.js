/**
 * Plugin configuration: the declared mode table. Each mode is a complete team —
 * a role table, the task-kind routing that selects roles, and the mode's own
 * flow budget — and the captain selects one mode per dispatch. Structure is
 * validated here; cross-field referents (routing targets, the default mode, live
 * model routes) are validated by {@link ./roles.ts} and the service's init-time
 * route check.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/config
 */
import z from '@deepseek-ai/schemastery';
/** Schemastery schema for one role's stronger escalation route. */
const FallbackSchema = z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    reasoningEffort: z.string().min(1).required(),
});
/** Schemastery schema for one declared role. */
const RoleSchema = z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    reasoningEffort: z.string().min(1).required(),
    brief: z.string(),
    preset: z.string().min(1),
    maxTokens: z.natural().min(1),
    // A bare nested object defaults to `{}` when the key is absent, and its
    // required children then reject every role that legitimately declares no
    // fallback. The nullable union keeps absence absent while still validating
    // the whole route whenever one is declared.
    fallback: z.union([FallbackSchema, z.const(null)]),
});
/** Schemastery schema for one mode. */
const ModeSchema = z.object({
    brief: z.string(),
    roles: z.dict(RoleSchema).required(),
    taskRouting: z.dict(z.string().min(1)).required(),
    concurrency: z.natural().default(3),
    maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed')]).default('provider-managed'),
});
/** Schemastery schema for {@link Config}; mount rejects on violation. */
export const ConfigSchema = z.object({
    provider: z.string().min(1).default('spawn'),
    defaultMode: z.string().min(1),
    modes: z.dict(ModeSchema).required(),
    allowCaptainOverride: z.boolean().default(false),
});
//# sourceMappingURL=config.js.map