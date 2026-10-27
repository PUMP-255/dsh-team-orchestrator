/**
 * The model-facing `team_status` tool: one snapshot of the dispatch registry —
 * concurrency against the cap and per-role dispatch counts. Registry state is
 * this process's in-memory record; it does not survive restarts and does not
 * include token usage (deferred until a cross-session usage read exists).
 *
 * @module @deepseek-ai/dsh-experimental-team-orchestrator/status
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Sum captured usage snapshots; undefined when no record carries one. */
function sumUsage(records) {
    const captured = records.filter(record => record.usage !== undefined);
    if (captured.length === 0)
        return undefined;
    const totals = {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
    for (const record of captured) {
        const usage = record.usage;
        if (usage === undefined)
            continue;
        totals.uncachedInputTokens += usage.uncachedInputTokens;
        totals.outputTokens += usage.outputTokens;
        totals.cacheReadTokens += usage.cacheReadTokens;
        totals.cacheWriteTokens += usage.cacheWriteTokens;
    }
    return { ...totals };
}
/**
 * Fold the registry into per-role status rows, in role-declaration order.
 * @param deps - status dependencies.
 * @returns one row per role reached through the routing table.
 */
export function roleStatusRows(deps) {
    const rows = new Map();
    for (const kind of deps.kinds) {
        const role = deps.roleFor(kind);
        if (rows.has(role.id))
            continue;
        rows.set(role.id, {
            row: {
                role: role.id,
                model: role.route.model,
                effort: role.route.reasoningEffort,
                dispatched: 0,
                running: 0,
                labels: [],
            },
            records: [],
        });
    }
    for (const record of deps.registry) {
        const entry = rows.get(record.role);
        if (entry === undefined)
            continue;
        const running = deps.settledChildIds.has(record.childId) ? 0 : 1;
        entry.records.push(record);
        entry.row = {
            ...entry.row,
            dispatched: entry.row.dispatched + 1,
            running: entry.row.running + running,
            labels: [record.label, ...entry.row.labels],
        };
    }
    return [...rows.values()].map(({ row, records }) => {
        const usage = sumUsage(records);
        return usage === undefined ? row : { ...row, usage };
    });
}
/**
 * Build the `team_status` tool definition.
 * @param deps - status dependencies.
 * @returns the tool definition.
 */
export function defineTeamStatusTool(deps) {
    return defineTool({
        name: 'team_status',
        description: 'Report the team dispatch registry: concurrency against the cap, per-role dispatch counts, and summed provider-reported token usage of settled dispatches. Registry state is this process\'s record.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { type: 'string', required: true, const: 'status' },
                    running: { type: 'number', required: true },
                    concurrency: { type: 'number', required: true },
                    roles: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                role: { type: 'string', required: true },
                                model: { type: 'string', required: true },
                                effort: { type: 'string', required: true },
                                dispatched: { type: 'number', required: true },
                                running: { type: 'number', required: true },
                                usage: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        uncachedInputTokens: { type: 'number', required: true },
                                        outputTokens: { type: 'number', required: true },
                                        cacheReadTokens: { type: 'number', required: true },
                                        cacheWriteTokens: { type: 'number', required: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const rows = value.roles.map((row) => {
                    const usage = row.usage === undefined
                        ? ''
                        : `; tokens in/out ${row.usage.uncachedInputTokens}/${row.usage.outputTokens}`;
                    return `${row.role}: ${row.running} running / ${row.dispatched} dispatched (${row.model} at ${row.effort}${usage})`;
                });
                return [{
                        type: 'text',
                        text: `dispatches ${value.running}/${value.concurrency} running\n${rows.join('\n')}`,
                    }];
            },
        },
        isConcurrencySafe: () => true,
        execute() {
            const roles = roleStatusRows(deps).map(row => ({
                role: row.role,
                model: row.model,
                effort: row.effort,
                dispatched: row.dispatched,
                running: row.running,
                ...row.usage === undefined ? {} : { usage: row.usage },
            }));
            return Promise.resolve({
                kind: 'status',
                running: deps.runningDispatches(),
                concurrency: deps.maxConcurrency(),
                roles,
            });
        },
    });
}
//# sourceMappingURL=status.js.map