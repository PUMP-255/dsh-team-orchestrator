/**
 * The model-facing `team_dispatch` tool: mode-and-kind-routed delegation through
 * the configured team. The model selects a mode (where several are declared) and
 * a task kind, and writes the brief; the plugin owns which roles exist, which
 * model and reasoning effort each role runs on, and escalates once to the role's
 * fallback route when the primary child fails.
 *
 * @module @deepseek-ai/dsh-team-orchestrator/dispatch
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
/**
 * Validate tool-call arguments at the tool JSON boundary.
 * @param value - raw parsed arguments.
 * @returns the validated arguments.
 */
export function assertDispatchArgs(value) {
    if (typeof value !== 'object' || value === null) {
        throw new Error('team_dispatch arguments must be an object');
    }
    const args = value;
    for (const field of ['kind', 'description', 'prompt']) {
        const current = args[field];
        if (typeof current !== 'string' || current.length === 0) {
            throw new Error(`team_dispatch \`${field}\` must be a non-empty string`);
        }
    }
    if (args.mode !== undefined && (typeof args.mode !== 'string' || args.mode.length === 0)) {
        throw new Error('team_dispatch `mode` must be a non-empty string');
    }
    if (args.cwd !== undefined && typeof args.cwd !== 'string') {
        throw new Error('team_dispatch `cwd` must be a string');
    }
    if (args.output_schema !== undefined) {
        if (typeof args.output_schema !== 'object' || Array.isArray(args.output_schema)) {
            throw new Error('team_dispatch `output_schema` must be an object');
        }
        assertObjectJsonSchema(args.output_schema);
    }
}
/**
 * Compose the child prompt: the role's discipline line, then the brief.
 * @param role - the routed role.
 * @param prompt - the dispatcher's task brief.
 * @returns the composed child prompt.
 */
export function composeDispatchPrompt(role, prompt) {
    return role.brief === undefined ? prompt : `${role.brief}\n\n${prompt}`;
}
/**
 * Build the `team_dispatch` tool definition. The executor validates the schema,
 * so `execute` re-validates only as defense at the tool JSON boundary.
 * @param deps - dispatch dependencies.
 * @returns the tool definition.
 */
export function defineTeamDispatchTool(deps) {
    if (!deps.provider.capabilities.agentOptions) {
        throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support child agentOptions`);
    }
    const presetNeedingRoles = deps.team.modes.flatMap(mode => [...mode.roles.values()]
        .filter(role => role.preset !== undefined)
        .map(role => deps.team.modes.length === 1 ? `"${role.id}"` : `"${mode.id}/${role.id}"`));
    if (presetNeedingRoles.length > 0 && !deps.provider.capabilities.agentPreset) {
        throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support child agent presets`
            + ` (roles with presets: ${presetNeedingRoles.join(', ')})`);
    }
    const severalModes = deps.team.modes.length > 1;
    return defineTool({
        name: 'team_dispatch',
        description: (severalModes
            ? 'Dispatch one team task to the role its kind routes to in the mode you choose. Every mode\'s roles, models, and reasoning efforts are host-pinned; you choose the mode, the kind, and write the complete brief.'
            : 'Dispatch one team task to the role configured for its task kind. The role\'s model and reasoning effort are host-pinned; you choose only the kind and write the complete brief.')
            + ' This tool starts an independently managed subagent and immediately returns its id; the runtime notifies you when it finishes.'
            + ' Before re-dispatching the same kind, check the returned `recent` labels and state what differs from those attempts.',
        parameters: {
            ...severalModes ? {
                mode: {
                    type: 'string',
                    enum: deps.team.modes.map(mode => mode.id),
                    description: `Mode to run this task in. Each mode declares its own roles, routes, and flow budget; omission runs the default, "${deps.team.defaultMode.id}".`,
                },
            } : {},
            kind: {
                type: 'string',
                required: true,
                enum: [...deps.team.kinds],
                description: severalModes
                    ? 'Task kind; routes to the role the chosen mode declares for it. A kind is only routable in a mode that declares it.'
                    : 'Task kind; routes to the role configured for it.',
            },
            description: {
                type: 'string',
                required: true,
                description: 'A short (3-5 word) description of the delegated task, for display.',
            },
            prompt: {
                type: 'string',
                required: true,
                description: 'Complete, self-contained brief for the role: exact file paths, full expected behavior, and acceptance criteria. The child does not see this conversation.',
            },
            cwd: {
                type: 'string',
                description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
            },
            ...(deps.provider.capabilities.outputSchema ? {
                output_schema: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Optional object-rooted JSON Schema (type/properties/required/additionalProperties/items/enum/const/oneOf only) the child\'s final answer must satisfy; the validated object arrives with the completion notice.',
                },
            } : {}),
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', required: true, const: 'dispatch' },
                    subagentId: { type: 'string', required: true },
                    mode: { type: 'string', required: true },
                    role: { type: 'string', required: true },
                    model: { type: 'string', required: true },
                    escalates: { type: 'boolean', required: true },
                    recent: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `dispatched ${severalModes ? `in mode "${value.mode}" to ` : 'to '}role "${value.role}" (${value.model}); started subagent ${value.subagentId}`
                        + (value.escalates
                            ? '; if this run ends without completing, it automatically re-dispatches once on this role\'s stronger fallback route'
                            : ''),
                }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertDispatchArgs(args);
            const parent = exec.agent;
            if (parent === undefined) {
                throw new Error('team_dispatch requires a calling agent (exec.agent was undefined)');
            }
            const mode = args.mode === undefined ? deps.team.defaultMode : deps.team.modeFor(args.mode);
            const role = mode.roleFor(args.kind);
            if (args.output_schema !== undefined && !deps.provider.capabilities.outputSchema) {
                throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support structured child output`);
            }
            const composed = composeDispatchPrompt(role, args.prompt);
            deps.team.admitDispatch(mode.id);
            try {
                await deps.llm.resolveCallConfig({ ...role.route }, exec.signal);
                if (role.fallback !== undefined) {
                    await deps.llm.resolveCallConfig({ ...role.fallback.route }, exec.signal);
                }
                const depth = deps.depthFor(mode.id);
                const context = {
                    mode: mode.id,
                    kind: args.kind,
                    composed,
                    label: args.description,
                    cwd: args.cwd,
                    outputSchema: args.output_schema,
                    parent,
                    signal: exec.signal,
                    ...role.preset === undefined ? {} : { preset: role.preset },
                    ...depth === undefined ? {} : { maxDepth: depth },
                };
                const started = await startAttempt(deps, context, role.options);
                deps.team.recordDispatch({
                    childId: started.childId,
                    mode: mode.id,
                    kind: args.kind,
                    role: role.id,
                    model: role.route.model,
                    label: args.description,
                    route: 'primary',
                });
                observeAttempt(deps, started, role, 1, context);
                return {
                    kind: 'dispatch',
                    subagentId: started.childId,
                    mode: mode.id,
                    role: role.id,
                    model: role.route.model,
                    escalates: role.fallback !== undefined,
                    recent: [...deps.team.recentLabelsFor(args.kind, started.childId)],
                };
            }
            catch (error) {
                deps.team.releaseDispatch(mode.id);
                throw error;
            }
        },
    });
}
/** Start one child attempt with one route's options and the shared dispatch framing. */
function startAttempt(deps, context, routeOptions) {
    return deps.subagents.startActivation({
        provider: deps.provider.name,
        label: context.label,
        request: {
            ...context.cwd === undefined ? {} : { cwd: context.cwd },
            prompt: [{ type: 'text', text: context.composed }],
            parent: context.parent,
            agentOptions: { ...routeOptions },
            ...context.preset === undefined ? {} : { agentPreset: context.preset },
            ...context.maxDepth === undefined ? {} : { maxDepth: context.maxDepth },
            ...context.outputSchema === undefined ? {} : { outputSchema: context.outputSchema },
        },
        signal: context.signal,
        delivery: 'parent',
    });
}
/**
 * Observe one attempt's settlement: release its slot, record the outcome, and
 * — for a failed primary attempt of a role with a fallback route — escalate
 * once to the fallback. Cancellation is never escalated.
 */
function observeAttempt(deps, started, role, attemptNumber, context) {
    void started.result.then((result) => { settleAttempt(deps, started.childId, role, attemptNumber, result, context); }, () => { settleAttempt(deps, started.childId, role, attemptNumber, undefined, context); });
}
function settleAttempt(deps, childId, role, attemptNumber, result, context) {
    deps.team.releaseDispatch(context.mode);
    deps.team.markSettled(childId);
    const outcome = result?.stopReason ?? 'error';
    deps.team.markOutcome(childId, outcome);
    if (attemptNumber !== 1 || role.fallback === undefined || outcome === 'completed' || outcome === 'aborted')
        return;
    void escalate(deps, role, outcome, context);
}
/** Start the fallback attempt for one failed primary child; never re-escalates. */
async function escalate(deps, role, failedOutcome, context) {
    const fallback = role.fallback;
    if (fallback === undefined)
        return;
    const label = `${context.label} (fallback)`;
    const composed = `${context.composed}\n\nA previous attempt with a faster model ended without completing (stop reason: ${failedOutcome}).`
        + ' You are the escalation running a stronger model: deliver the task fully.';
    try {
        deps.team.admitDispatch(context.mode);
    }
    catch (error) {
        deps.onWarn?.(`team-orchestrator: fallback for role "${role.id}" in mode "${context.mode}" skipped,`
            + ` no free concurrency slot: ${String(error)}`);
        return;
    }
    try {
        const started = await startAttempt(deps, { ...context, label, composed }, fallback.options);
        deps.team.recordDispatch({
            childId: started.childId,
            mode: context.mode,
            kind: context.kind,
            role: role.id,
            model: fallback.route.model,
            label,
            route: 'fallback',
        });
        observeAttempt(deps, started, role, 2, { ...context, label, composed });
    }
    catch (error) {
        deps.team.releaseDispatch(context.mode);
        deps.onWarn?.(`team-orchestrator: fallback for role "${role.id}" in mode "${context.mode}" failed to start: ${String(error)}`);
    }
}
/** One role's mention in the captain section: its id, model, and reasoning effort. */
function roleRouteText(role, verbose) {
    const effort = role.route.reasoningEffort;
    return verbose
        ? `role \`${role.id}\` (\`${role.route.model}\` at \`${effort}\` reasoning effort)`
        : `\`${role.id}\` (\`${role.route.model}\` at \`${effort}\`)`;
}
/** The captain section's per-mode body: this mode's kinds, routes, and discipline. */
function modeBody(mode, verbose) {
    const routes = mode.kinds.map(kind => {
        const role = mode.roleFor(kind);
        return verbose
            ? `- \`${kind}\` → ${roleRouteText(role, true)}`
            : `\`${kind}\` → ${roleRouteText(role, false)}`;
    });
    const body = verbose ? routes.join('\n') : routes.join(', ');
    return mode.brief === undefined ? body : `${body}\n  ${mode.brief}`;
}
/**
 * The captain prompt section text: the mode table, its kind→role routes, and the
 * briefing discipline, rendered only where the tool is visible.
 * @param team - the resolved deployment.
 * @returns the section text.
 */
export function captainSectionText(team) {
    const modes = [...team.modes.values()];
    const single = modes.length === 1 ? modes[0] : undefined;
    const table = single === undefined
        ? 'Delegate team tasks with `team_dispatch`: choose the `mode` whose roles, routes, and flow fit the task, then its task kind; omit `mode` to run the default.'
            + ' Prefer the cheapest mode that can deliver; choose a stricter mode when the work needs review, verification, or stronger reasoning.\n\n'
            + modes.map(mode => `- \`${mode.id}\`${mode.id === team.defaultMode.id ? ' (default)' : ''}: ${modeBody(mode, false)}`).join('\n')
        : 'Delegate team tasks with `team_dispatch` by task kind; each kind runs on its configured role and model route:\n'
            + modeBody(single, true);
    return `${table}\n\n`
        + 'Write every brief short and concrete — exact file paths, full expected behavior, and acceptance criteria; the child does not see this conversation. Consult a high-effort planning role before dispatching open-ended work to a fast implementation role. Dispatch independent kinds together in one message; when only waiting for results remains, end your turn instead of polling. Check `team_status` before dispatching more work when completions seem overdue. Do not re-dispatch the same kind for the same goal: the dispatch result lists that kind\'s recent labels, and a retry must state what differs from those attempts.\n\n'
        + 'You are the implementer of last resort: dispatch the matching kind first and implement directly only after that dispatch failed. Role routes carry a fallback escalation automatically; failed dispatches re-run on a stronger model without your involvement.';
}
//# sourceMappingURL=dispatch.js.map