/**
 * Pure mode resolution: config data in, resolved per-mode role tables out. Owns
 * the cross-field checks the schema cannot express (inheritance chains, routing
 * targets, non-empty tables, the default mode) so misconfiguration rejects at
 * the resolve step. Each mode resolves independently: a role id and a task kind
 * mean what that mode declares them to mean.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/roles
 */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
/**
 * Fold a role's `extends` chain from the role back to its root, nearest
 * declaration winning each field. An absent field keeps walking the chain.
 * Rejects an unknown parent, an inheritance cycle, and a role left without a
 * complete route.
 * @param roleId - the role id to fold.
 * @param declared - the declaring mode's role table.
 * @param modeId - the declaring mode's id, for error messages.
 * @returns the role's concrete route fields and inherited optional fields.
 */
function inheritRoleFields(roleId, declared, modeId) {
    const chain = [];
    const visited = new Set();
    let current = roleId;
    while (current !== undefined) {
        if (visited.has(current)) {
            throw new Error(`team-orchestrator: mode "${modeId}": role inheritance cycle `
                + [...chain.map(entry => `"${entry.id}"`), `"${current}"`].join(' -> '));
        }
        const role = declared[current];
        if (role === undefined) {
            throw new Error(`team-orchestrator: mode "${modeId}": role "${chain[chain.length - 1]?.id ?? roleId}" extends undeclared role "${current}";`
                + ` declared roles: ${Object.keys(declared).map(declaredId => `"${declaredId}"`).join(', ')}`);
        }
        visited.add(current);
        chain.push({ id: current, role });
        current = role.extends;
    }
    let provider;
    let model;
    let reasoningEffort;
    let brief;
    let preset;
    let maxTokens;
    let fallback;
    for (const { role } of chain) {
        provider ??= role.provider;
        model ??= role.model;
        reasoningEffort ??= role.reasoningEffort;
        brief ??= role.brief;
        preset ??= role.preset;
        maxTokens ??= role.maxTokens;
        fallback ??= role.fallback;
    }
    if (provider === undefined || model === undefined || reasoningEffort === undefined) {
        const missing = [
            provider === undefined ? 'provider' : undefined,
            model === undefined ? 'model' : undefined,
            reasoningEffort === undefined ? 'reasoningEffort' : undefined,
        ].filter(field => field !== undefined);
        throw new Error(`team-orchestrator: mode "${modeId}": role "${roleId}" is incomplete after inheritance: missing ${missing.join(', ')};`
            + ' declare each field directly or anywhere along its inheritance chain');
    }
    return {
        provider,
        model,
        reasoningEffort,
        ...brief === undefined ? {} : { brief },
        ...preset === undefined ? {} : { preset },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...fallback === undefined ? {} : { fallback },
    };
}
/**
 * Resolve one declared mode. Rejects an empty role table, an empty routing map,
 * routing that names a role the mode does not declare, an inheritance cycle, an
 * unknown inheritance parent, a role left without a complete route after
 * inheritance, an unnamed unrouted role, and a fallback identical to its
 * primary route.
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
    for (const [roleId] of roleEntries) {
        if (roleId.length === 0) {
            throw new Error(`team-orchestrator: mode "${id}": a role id must be non-empty`);
        }
        if (roleId.includes('/')) {
            throw new Error(`team-orchestrator: mode "${id}": role id "${roleId}" must not contain "/": mode and role ids share one route-validation key`);
        }
        const inherited = inheritRoleFields(roleId, mode.roles, id);
        const reasoningEffort = ReasoningEffortId(inherited.reasoningEffort);
        const route = { provider: inherited.provider, model: inherited.model, reasoningEffort };
        let resolvedFallback;
        if (inherited.fallback !== undefined && inherited.fallback !== null) {
            const declaredFallback = inherited.fallback;
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
                options: { ...inherited.maxTokens === undefined ? {} : { maxTokens: inherited.maxTokens }, ...fallbackRoute },
            };
        }
        roles.set(roleId, {
            id: roleId,
            route,
            options: {
                ...inherited.maxTokens === undefined ? {} : { maxTokens: inherited.maxTokens },
                provider: route.provider,
                model: route.model,
                reasoningEffort,
            },
            ...inherited.brief === undefined ? {} : { brief: inherited.brief },
            ...inherited.preset === undefined ? {} : { preset: inherited.preset },
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
    // A role that only serves as an inheritance parent never appears in
    // taskRouting by design; any unrouted role nobody extends stays rejected.
    const inheritanceParents = new Set(roleEntries
        .map(([, role]) => role.extends)
        .filter((parentId) => parentId !== undefined));
    const unrouted = roleEntries.map(([roleId]) => roleId)
        .filter(roleId => !routed.has(roleId) && !inheritanceParents.has(roleId));
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