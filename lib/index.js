/**
 * Mode-and-role-pinned team delegation: a configuration-declared mode table
 * resolves task kinds to per-role child LLM routes, and the captain selects one
 * mode per dispatch. Roles and routes are host-pinned data — the model chooses
 * only the mode and the task kind. The `team_dispatch` tool and the captain
 * prompt section mount when the configured subagent provider registers, and
 * failed primary children escalate once to their role's fallback route.
 *
 * @module @deepseek-ai/dsh-team-orchestrator
 */
import { Service } from '@deepseek-ai/cordis';
import { ConfigSchema } from "./config.js";
import { flattenRoles, resolveModes, validateRoleRoutes, } from "./roles.js";
import { captainSectionText, defineTeamDispatchTool, } from "./dispatch.js";
import { defineTeamStatusTool } from "./status.js";
import { teamUsageProjectionDefinition } from "./usage-projection.js";
export { flattenRoles, resolveMode, resolveModes, resolveTaskKind, validateRoleRoutes } from "./roles.js";
export { composeDispatchPrompt, captainSectionText, defineTeamDispatchTool } from "./dispatch.js";
export { defineTeamStatusTool, modeStatusRows } from "./status.js";
export { teamUsageProjectionDefinition } from "./usage-projection.js";
/**
 * Owns the resolved mode table and the `team_dispatch` delegation tool.
 * Structural and referential validation rejects at mount; live route
 * validation runs against the LLM runtime at init and, when a provider
 * adapter has not registered yet, re-runs on `llm/adapters-updated` — the
 * earliest resolvable point for each route. The tool and captain section mount
 * when the configured subagent provider registers.
 */
export class TeamOrchestrator extends Service {
    static inject = ['llm', 'tools', 'subagents', 'systemPrompt', 'sessionProjections', 'agents'];
    static Config = ConfigSchema;
    config;
    team;
    activeDispatches = new Map();
    modeDepth = new Map();
    dispatchRecords = [];
    settledChildren = new Set();
    childSessions = new Map();
    disposeUsageProjection;
    constructor(ctx, config) {
        super(ctx, 'teamOrchestrator');
        this.config = config;
        this.team = resolveModes(config);
    }
    async [Service.init]() {
        await this.initRouteValidation();
        await this.initPresetValidation();
        this.initUsageCapture();
        this.initDelegationTool();
    }
    /**
     * Validate every declared role preset across every mode against the
     * agent-presets registry, the earliest resolvable point: an unknown preset id
     * rejects this mount.
     */
    async initPresetValidation() {
        const presetIds = new Set();
        for (const mode of this.team.modes.values()) {
            for (const role of mode.roles.values()) {
                if (role.preset !== undefined)
                    presetIds.add(role.preset);
            }
        }
        if (presetIds.size === 0)
            return;
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) {
            throw new Error('team-orchestrator: role presets require the agent-presets service');
        }
        for (const id of presetIds) {
            await presets.resolve(id);
        }
    }
    /**
     * Capture settled children's provider-reported usage off this package's own
     * usage projection (keyed independently of the harness token-meter's
     * `tokenUsage` unit, which published DSH releases register themselves). The
     * child's live Session is retained at `subagent/start` — which precedes the
     * dispatch tool's own registry write, so retention is not gated on a
     * recorded dispatch — and released at the paired end. A held Session's
     * committed events stay foldable after child disposal, so the end edge reads
     * final totals.
     */
    initUsageCapture() {
        try {
            const dispose = this.ctx.sessionProjections.register(teamUsageProjectionDefinition);
            this.disposeUsageProjection = dispose;
            this.ctx.effect(() => () => { this.disposeUsageProjection?.(); });
        }
        catch (error) {
            this.ctx.logger.error('team-orchestrator: token usage projection unavailable: %s', error);
        }
        this.ctx.effect(() => this.ctx.on('subagent/start', (info) => {
            const session = this.ctx.agents.get(info.id)?.session;
            if (session !== undefined)
                this.childSessions.set(info.id, session);
        }));
        this.ctx.effect(() => this.ctx.on('subagent/end', (info) => { this.captureUsage(info); }));
    }
    /**
     * Read one settled child's usage totals onto its dispatch record.
     * @param info - the settled run's end payload.
     */
    captureUsage(info) {
        const record = this.dispatchRecords.find(entry => entry.childId === info.id);
        const session = this.childSessions.get(info.id);
        this.childSessions.delete(info.id);
        if (record === undefined || session === undefined || record.usage !== undefined)
            return;
        const state = this.ctx.sessionProjections.stateOf(session, 'teamOrchestratorUsage');
        if (state === undefined)
            return;
        record.usage = { ...state.totals };
    }
    /** Validate declared routes of every mode, deferring until every provider adapter registers. */
    async initRouteValidation() {
        const routes = flattenRoles(this.team);
        const deferred = await validateRoleRoutes(this.ctx.llm, routes);
        if (deferred.length === 0)
            return;
        const disposeRetry = this.ctx.effect(() => this.ctx.on('llm/adapters-updated', () => {
            void validateRoleRoutes(this.ctx.llm, routes)
                .then(async (stillDeferred) => {
                if (stillDeferred.length === 0)
                    await disposeRetry();
            })
                .catch((error) => {
                this.ctx.logger.error('team-orchestrator: declared route rejected by the LLM runtime: %s', error);
            });
        }));
    }
    /** Mount `team_dispatch`, `team_status`, and the captain section once the provider registers. */
    initDelegationTool() {
        let mounted = false;
        const tryMount = (provider) => {
            if (provider.name !== this.config.provider || mounted)
                return;
            for (const mode of this.team.modes.values()) {
                const maxDepth = this.ctx.subagents.resolveMaxDepth(mode.maxDepth);
                if (maxDepth !== undefined && !provider.capabilities.depthLimit) {
                    throw new Error(`team-orchestrator: mode "${mode.id}": provider "${provider.name}" cannot enforce maxDepth`
                        + ' (no depthLimit capability) — set that mode\'s maxDepth to \'provider-managed\' to leave the recursion budget to the provider');
                }
                this.modeDepth.set(mode.id, maxDepth);
            }
            const definition = defineTeamDispatchTool({
                provider,
                subagents: this.ctx.subagents,
                depthFor: mode => this.modeDepth.get(mode),
                team: {
                    modes: [...this.team.modes.values()],
                    defaultMode: this.team.defaultMode,
                    kinds: this.team.kinds,
                    modeFor: mode => this.modeFor(mode),
                    recentLabelsFor: (kind, excludeChildId) => this.recentLabelsFor(kind, excludeChildId),
                    admitDispatch: (mode) => { this.admitDispatch(mode); },
                    releaseDispatch: (mode) => { this.releaseDispatch(mode); },
                    recordDispatch: (entry) => { this.recordDispatch(entry); },
                    markSettled: (childId) => { this.markSettled(childId); },
                    markOutcome: (childId, outcome) => { this.markOutcome(childId, outcome); },
                },
                llm: this.ctx.llm,
                onWarn: (message) => { this.ctx.logger.warn(message); },
            });
            const statusDefinition = defineTeamStatusTool({
                modes: [...this.team.modes.values()],
                runningDispatches: mode => this.runningDispatches(mode),
                maxConcurrency: mode => this.maxConcurrency(mode),
                registry: this.dispatchRecords,
                settledChildIds: this.settledChildren,
            });
            const disposeTool = this.ctx.effect(() => {
                const disposeDispatch = this.ctx.tools.register(definition);
                const disposeStatus = this.ctx.tools.register(statusDefinition);
                return () => {
                    disposeStatus();
                    disposeDispatch();
                };
            });
            const disposeSection = this.ctx.systemPrompt.section({
                // TOOL_TEAM_DISPATCH does not exist in published dsh-system-prompt
                // releases yet; the delegation guidance therefore shares the subagent
                // placement until a release carries the dedicated order name.
                name: 'team-orchestrator:captain',
                order: this.ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
                text: (context) => {
                    if (this.ctx.tools.get(definition.name, context.scope) !== definition)
                        return '';
                    return captainSectionText(this.team);
                },
            });
            mounted = true;
            this.ctx.effect(() => () => {
                disposeSection();
                void disposeTool();
                mounted = false;
            });
        };
        this.ctx.effect(() => this.ctx.on('subagent/provider-added', tryMount));
        const initial = this.ctx.subagents.getProvider(this.config.provider);
        if (initial !== undefined)
            tryMount(initial);
        else {
            this.ctx.logger.info(`team-orchestrator: subagent provider "${this.config.provider}" not registered yet;`
                + ' the team_dispatch tool will register when it appears');
        }
    }
    /**
     * Resolve one declared mode.
     * @param mode - mode id requested by a caller.
     * @returns the resolved mode.
     */
    modeFor(mode) {
        const resolved = this.team.modes.get(mode);
        if (resolved === undefined) {
            throw new Error(`team-orchestrator: unknown mode "${mode}"; declared modes:`
                + ` ${[...this.team.modes.keys()].map(id => `"${id}"`).join(', ')}`);
        }
        return resolved;
    }
    /** Declared modes, in configuration order. */
    get modes() {
        return [...this.team.modes.values()];
    }
    /** The mode a dispatch runs in when it omits `mode`. */
    get defaultMode() {
        return this.team.defaultMode;
    }
    /** Every declared task kind across modes, in mode-then-declaration order. */
    get kinds() {
        return this.team.kinds;
    }
    /** Whether the captain may request a route outside the declared table. */
    get captainMayOverride() {
        return this.config.allowCaptainOverride;
    }
    /**
     * Take one dispatch concurrency slot in one mode.
     * @param mode - the mode the dispatch runs in.
     * @throws when that mode's cap is already running.
     */
    admitDispatch(mode) {
        const active = this.runningDispatches(mode);
        const cap = this.maxConcurrency(mode);
        if (active >= cap) {
            throw new Error(`team-orchestrator: mode "${mode}": ${active} dispatches already running`
                + ` (concurrency ${cap}); wait for a completion notice before dispatching again`);
        }
        this.activeDispatches.set(mode, active + 1);
    }
    /**
     * Return one dispatch concurrency slot to its mode after the dispatched child settles.
     * @param mode - the mode the dispatch ran in.
     */
    releaseDispatch(mode) {
        this.activeDispatches.set(mode, Math.max(0, this.runningDispatches(mode) - 1));
    }
    /**
     * Record one accepted dispatch for status reporting.
     * @param entry - the accepted dispatch's identifying data.
     */
    recordDispatch(entry) {
        this.dispatchRecords.unshift(entry);
    }
    /**
     * Mark one recorded dispatch settled when its child run settles.
     * @param childId - the settled child's session id.
     */
    markSettled(childId) {
        this.settledChildren.add(childId);
    }
    /**
     * Record the terminal outcome of one dispatch's child.
     * @param childId - the settled child's session id.
     * @param outcome - the child run's terminal stop reason.
     */
    markOutcome(childId, outcome) {
        const record = this.dispatchRecords.find(entry => entry.childId === childId);
        if (record !== undefined)
            record.outcome = outcome;
    }
    /**
     * Recent labels already dispatched for one kind, newest first.
     * @param kind - the task kind to look up.
     * @param excludeChildId - one child id to skip, conventionally the dispatch being answered.
     * @returns up to three labels of prior dispatches of this kind, across modes.
     */
    recentLabelsFor(kind, excludeChildId) {
        return this.dispatchRecords
            .filter(record => record.kind === kind && record.childId !== excludeChildId)
            .map(record => record.label)
            .slice(0, 3);
    }
    /**
     * Dispatches currently running in one mode.
     * @param mode - the mode to report.
     * @returns that mode's running dispatches against its concurrency cap.
     */
    runningDispatches(mode) {
        return this.activeDispatches.get(mode) ?? 0;
    }
    /**
     * One mode's concurrency cap.
     * @param mode - the mode to report.
     * @returns the mode's configured cap.
     */
    maxConcurrency(mode) {
        return this.modeFor(mode).concurrency;
    }
    /** The dispatch registry snapshot, newest first. */
    get registry() {
        return this.dispatchRecords;
    }
}
export const name = 'team-orchestrator';
export default TeamOrchestrator;
//# sourceMappingURL=index.js.map