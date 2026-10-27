/**
 * Pure role-table resolution: config data in, resolved per-role child routes
 * out. Owns the cross-field referent checks the schema cannot express (routing
 * targets, non-empty tables) so misconfiguration rejects at the resolve step.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/roles
 */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
/**
 * Resolve the declared role table. Rejects an empty table, an empty routing
 * map, and any routing entry naming an undeclared role.
 * @param config - validated plugin configuration.
 * @returns roles by role id, keyed in declaration order.
 */
export function resolveRoles(config) {
    const roleEntries = Object.entries(config.roles);
    if (roleEntries.length === 0) {
        throw new Error('team-orchestrator: the roles table is empty; declare at least one role');
    }
    const routingEntries = Object.entries(config.taskRouting);
    if (routingEntries.length === 0) {
        throw new Error('team-orchestrator: taskRouting is empty; declare at least one task kind');
    }
    const roles = new Map();
    for (const [id, role] of roleEntries) {
        const reasoningEffort = ReasoningEffortId(role.reasoningEffort);
        roles.set(id, {
            id,
            route: { provider: role.provider, model: role.model, reasoningEffort },
            options: { provider: role.provider, model: role.model, reasoningEffort },
            ...role.brief === undefined ? {} : { brief: role.brief },
            ...role.preset === undefined ? {} : { preset: role.preset },
        });
    }
    for (const [kind, roleId] of routingEntries) {
        if (!roles.has(roleId)) {
            throw new Error(`team-orchestrator: task kind "${kind}" routes to undeclared role "${roleId}";`
                + ` declared roles: ${roleEntries.map(([id]) => `"${id}"`).join(', ')}`);
        }
    }
    return roles;
}
/**
 * Resolve one task kind to its role.
 * @param roles - resolved role table.
 * @param routing - the configuration's task-kind routing.
 * @param kind - task kind requested by the caller.
 * @returns the routed role.
 */
export function resolveTaskKind(roles, routing, kind) {
    const roleId = routing[kind];
    if (roleId === undefined) {
        throw new Error(`team-orchestrator: unknown task kind "${kind}";`
            + ` declared kinds: ${Object.keys(routing).map(id => `"${id}"`).join(', ')}`);
    }
    const role = roles.get(roleId);
    if (role === undefined) {
        throw new Error(`team-orchestrator: task kind "${kind}" routes to undeclared role "${roleId}"`);
    }
    return role;
}
/**
 * Validate every role's exact route against the live LLM runtime. Provider
 * lookup, model metadata, and effort admissibility are the runtime's owned
 * checks. Routes whose provider adapter is not registered yet are reported as
 * deferred instead of failing, so mount order does not reject a valid table.
 * @param llm - live LLM runtime.
 * @param roles - resolved role table.
 * @param signal - cancellation for adapter-owned capability lookups.
 * @returns ids of roles whose provider adapter was not registered yet.
 */
export async function validateRoleRoutes(llm, roles, signal) {
    const deferred = [];
    for (const role of roles.values()) {
        try {
            await llm.resolveCallConfig({ ...role.route }, signal);
        }
        catch (error) {
            if (error instanceof LlmError && error.code === 'NO_ADAPTER') {
                deferred.push(role.id);
                continue;
            }
            throw error;
        }
    }
    return deferred;
}
//# sourceMappingURL=roles.js.map