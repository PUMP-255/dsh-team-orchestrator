/**
 * Pure mode resolution: config data in, resolved per-mode role tables out. Owns
 * the cross-field referent checks the schema cannot express (routing targets,
 * non-empty tables, the default mode) so misconfiguration rejects at the resolve
 * step. Each mode resolves independently: a role id and a task kind mean what
 * that mode declares them to mean.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/roles
 */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
/**
 * Resolve one declared mode. Rejects an empty role table, an empty routing map,
 * routing that names a role the mode does not declare, and a fallback identical
 * to its primary route.
 * @param id - the mode id from the configuration table.
 * @param mode - that mode's validated configuration.
 * @returns the resolved mode.
 */
export function resolveMode(id, mode) {
    if (id.length === 0) {
        throw new Error('team-orchestrator: a mode id must be non-empty');
    }
    if (id.includes('/')) {
        throw new Error(`team-orchestrator: mode id "${id}" must not contain "/": mode and role ids share one route-validation key`);
    }
    const roleEntries = Object.entries(mode.roles);
    if (roleEntries.length === 0) {
        throw new Error(`team-orchestrator: mode "${id}": the roles table is empty; declare at least one role`);
    }
    const routingEntries = Object.entries(mode.taskRouting);
    if (routingEntries.length === 0) {
        throw new Error(`team-orchestrator: mode "${id}": taskRouting is empty; declare at least one task kind`);
    }
    const roles = new Map();
    for (const [roleId, role] of roleEntries) {
        if (roleId.length === 0) {
            throw new Error(`team-orchestrator: mode "${id}": a role id must be non-empty`);
        }
        if (roleId.includes('/')) {
            throw new Error(`team-orchestrator: mode "${id}": role id "${roleId}" must not contain "/": mode and role ids share one route-validation key`);
        }
        const reasoningEffort = ReasoningEffortId(role.reasoningEffort);
        const route = { provider: role.provider, model: role.model, reasoningEffort };
        let resolvedFallback;
        const declaredFallback = role.fallback ?? undefined;
        if (declaredFallback !== undefined) {
            const fallbackRoute = {
                provider: declaredFallback.provider,
                model: declaredFallback.model,
                reasoningEffort: ReasoningEffortId(declaredFallback.reasoningEffort),
            };
            if (fallbackRoute.provider === route.provider
                && fallbackRoute.model === route.model
                && fallbackRoute.reasoningEffort === route.reasoningEffort) {
                throw new Error(`team-orchestrator: mode "${id}": role "${roleId}" declares a fallback identical to its primary route`);
            }
            resolvedFallback = {
                route: fallbackRoute,
                options: { ...role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens }, ...fallbackRoute },
            };
        }
        roles.set(roleId, {
            id: roleId,
            route,
            options: {
                ...role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens },
                provider: route.provider,
                model: route.model,
                reasoningEffort,
            },
            ...role.brief === undefined ? {} : { brief: role.brief },
            ...role.preset === undefined ? {} : { preset: role.preset },
            ...resolvedFallback === undefined ? {} : { fallback: resolvedFallback },
        });
    }
    for (const [kind, roleId] of routingEntries) {
        if (!roles.has(roleId)) {
            throw new Error(`team-orchestrator: mode "${id}": task kind "${kind}" routes to undeclared role "${roleId}";`
                + ` declared roles: ${roleEntries.map(([declared]) => `"${declared}"`).join(', ')}`);
        }
    }
    const routed = new Set(routingEntries.map(([, roleId]) => roleId));
    const unrouted = roleEntries.map(([roleId]) => roleId).filter(roleId => !routed.has(roleId));
    if (unrouted.length > 0) {
        throw new Error(`team-orchestrator: mode "${id}": ${unrouted.length === 1 ? 'role' : 'roles'}`
            + ` ${unrouted.map(roleId => `"${roleId}"`).join(', ')} declared but no taskRouting entry names`
            + ` ${unrouted.length === 1 ? 'it' : 'them'}; a role no kind routes to can never be dispatched`);
    }
    const kinds = routingEntries.map(([kind]) => kind);
    const resolved = {
        id,
        ...mode.brief === undefined ? {} : { brief: mode.brief },
        roles,
        taskRouting: mode.taskRouting,
        kinds,
        concurrency: mode.concurrency,
        maxDepth: mode.maxDepth,
        roleFor: kind => resolveTaskKind(resolved, kind),
    };
    return resolved;
}
/** The 0.1 flat team fields that now belong inside each mode. */
const LEGACY_TOP_LEVEL_FIELDS = ['roles', 'taskRouting', 'concurrency', 'maxDepth'];
/**
 * Reject a half-migrated 0.1 configuration. The flat team fields are no longer
 * read, and the schema preserves unknown keys, so leaving one beside `modes`
 * would mount while silently doing nothing.
 * @param config - validated plugin configuration.
 */
function rejectLegacyFields(config) {
    const raw = config;
    const present = LEGACY_TOP_LEVEL_FIELDS.filter(field => raw[field] !== undefined);
    if (present.length === 0)
        return;
    throw new Error(`team-orchestrator: 0.1 top-level ${present.map(field => `"${field}"`).join(', ')}`
        + ` ${present.length === 1 ? 'is' : 'are'} no longer read; declare ${present.length === 1 ? 'it' : 'them'} inside each mode`
        + ' (see README "Upgrading from 0.1")');
}
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
export function resolveModes(config) {
    rejectLegacyFields(config);
    const entries = Object.entries(config.modes);
    if (entries.length === 0) {
        throw new Error('team-orchestrator: the modes table is empty; declare at least one mode');
    }
    const modes = new Map();
    for (const [id, mode] of entries)
        modes.set(id, resolveMode(id, mode));
    const declared = [...modes.keys()].map(id => `"${id}"`).join(', ');
    const defaultId = config.defaultMode ?? (entries.length === 1 ? entries[0]?.[0] : undefined);
    if (defaultId === undefined) {
        throw new Error(`team-orchestrator: ${entries.length} modes are declared; set defaultMode to one of ${declared}`);
    }
    const defaultMode = modes.get(defaultId);
    if (defaultMode === undefined) {
        throw new Error(`team-orchestrator: defaultMode "${defaultId}" is not a declared mode; declared modes: ${declared}`);
    }
    const kinds = [];
    for (const mode of modes.values()) {
        for (const kind of mode.kinds)
            if (!kinds.includes(kind))
                kinds.push(kind);
    }
    return { modes, defaultMode, kinds };
}
/**
 * Resolve one task kind within one mode.
 * @param mode - the resolved mode the dispatch runs in.
 * @param kind - task kind requested by the caller.
 * @returns the routed role.
 */
export function resolveTaskKind(mode, kind) {
    const roleId = mode.taskRouting[kind];
    if (roleId === undefined) {
        throw new Error(`team-orchestrator: mode "${mode.id}": unknown task kind "${kind}";`
            + ` declared kinds: ${mode.kinds.map(declared => `"${declared}"`).join(', ')}`);
    }
    const role = mode.roles.get(roleId);
    if (role === undefined) {
        throw new Error(`team-orchestrator: mode "${mode.id}": task kind "${kind}" routes to undeclared role "${roleId}"`);
    }
    return role;
}
/**
 * Flatten every mode's roles into one id-keyed table for route validation.
 * @param team - the resolved deployment.
 * @returns roles keyed by `mode/role`, in mode-then-declaration order.
 */
export function flattenRoles(team) {
    const flat = new Map();
    for (const [modeId, mode] of team.modes) {
        for (const [roleId, role] of mode.roles)
            flat.set(`${modeId}/${roleId}`, role);
    }
    return flat;
}
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
export async function validateRoleRoutes(llm, roles, signal) {
    const deferred = [];
    for (const [id, role] of roles) {
        try {
            await llm.resolveCallConfig({ ...role.route }, signal);
        }
        catch (error) {
            if (error instanceof LlmError && error.code === 'NO_ADAPTER') {
                deferred.push(id);
                continue;
            }
            throw error;
        }
    }
    return deferred;
}
//# sourceMappingURL=roles.js.map