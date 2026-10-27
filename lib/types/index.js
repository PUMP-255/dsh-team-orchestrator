/**
 * Experimental team orchestrator: a configuration-declared role table resolves
 * task kinds to per-role child LLM routes. Roles are host-pinned data — the
 * model never names a route. The `team_dispatch` tool and the captain prompt
 * section mount when the configured subagent provider registers.
 *
 * @module @deepseek-ai/dsh-experimental-team-orchestrator
 */
import { Service } from '@deepseek-ai/cordis';
import { tokenUsageProjectionDefinition } from '@deepseek-ai/dsh-token-meter';
import { ConfigSchema } from "./config.js";
import { resolveRoles, resolveTaskKind, validateRoleRoutes, } from "./roles.js";
import { captainSectionText, defineTeamDispatchTool, } from "./dispatch.js";
import { defineTeamStatusTool } from "./status.js";
export { resolveRoles, resolveTaskKind, validateRoleRoutes } from "./roles.js";
export { composeDispatchPrompt, captainSectionText, defineTeamDispatchTool } from "./dispatch.js";
export { defineTeamStatusTool, roleStatusRows } from "./status.js";
/**
 * Owns the resolved role table and the `team_dispatch` delegation tool.
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
    roles;
    activeDispatches = 0;
    dispatchRecords = [];
    settledChildren = new Set();
    childSessions = new Map();
    usageReader;
    constructor(ctx, config) {
        super(ctx, 'teamOrchestrator');
        this.config = config;
        this.roles = resolveRoles(config);
    }
    async [Service.init]() {
        await this.initRouteValidation();
        await this.initPresetValidation();
        this.initUsageCapture();
        this.initDelegationTool();
    }
    /**
     * Validate every declared role preset against the agent-presets registry,
     * the earliest resolvable point: an unknown preset id rejects this mount.
     */
    async initPresetValidation() {
        const presetIds = [...new Set([...this.roles.values()]
                .map(role => role.preset)
                .filter((preset) => preset !== undefined))];
        if (presetIds.length === 0)
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
     * Capture settled children's provider-reported usage off the shared
     * `tokenUsage` projection. The child's live Session is retained at
     * `subagent/start` — which precedes the dispatch tool's own registry write,
     * so retention is not gated on a recorded dispatch — and released at the
     * paired end. A held Session's committed events stay foldable after child
     * disposal, so the end edge reads final totals.
     */
    initUsageCapture() {
        void this.ctx.sessionProjections.register(tokenUsageProjectionDefinition)
            .then((handle) => {
            this.usageReader = handle;
        })
            .catch((error) => {
            this.ctx.logger.error('team-orchestrator: token usage projection unavailable: %s', error);
        });
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
        const reader = this.usageReader;
        const record = this.dispatchRecords.find(entry => entry.childId === info.id);
        const session = this.childSessions.get(info.id);
        this.childSessions.delete(info.id);
        if (reader === undefined || record === undefined || session === undefined || record.usage !== undefined)
            return;
        record.usage = { ...reader.stateOf(session).totals };
    }
    /** Validate declared routes, deferring until every provider adapter registers. */
    async initRouteValidation() {
        const deferred = await validateRoleRoutes(this.ctx.llm, this.roles);
        if (deferred.length === 0)
            return;
        const disposeRetry = this.ctx.effect(() => this.ctx.on('llm/adapters-updated', () => {
            void validateRoleRoutes(this.ctx.llm, this.roles)
                .then(async (stillDeferred) => {
                if (stillDeferred.length === 0)
                    await disposeRetry();
            })
                .catch((error) => {
                this.ctx.logger.error('team-orchestrator: declared route rejected by the LLM runtime: %s', error);
            });
        }));
    }
    /** Mount `team_dispatch` and the captain section once the provider registers. */
    initDelegationTool() {
        let mounted = false;
        const tryMount = (provider) => {
            if (provider.name !== this.config.provider || mounted)
                return;
            const maxDepth = this.ctx.subagents.resolveMaxDepth(this.config.maxDepth);
            if (maxDepth !== undefined && !provider.capabilities.depthLimit) {
                throw new Error(`team-orchestrator: provider "${provider.name}" cannot enforce maxDepth`
                    + ' (no depthLimit capability) — set maxDepth: \'provider-managed\' to leave the recursion budget to the provider');
            }
            const definition = defineTeamDispatchTool({
                provider,
                subagents: this.ctx.subagents,
                ...maxDepth === undefined ? {} : { maxDepth },
                team: {
                    kinds: this.kinds,
                    roleFor: kind => this.roleFor(kind),
                    roleForKinds: () => this.kinds.map(kind => this.roleFor(kind)),
                    admitDispatch: () => { this.admitDispatch(); },
                    releaseDispatch: () => { this.releaseDispatch(); },
                    recordDispatch: (entry) => { this.recordDispatch(entry); },
                    markSettled: (childId) => { this.markSettled(childId); },
                    recentLabelsFor: (kind, excludeChildId) => this.recentLabelsFor(kind, excludeChildId),
                },
                llm: this.ctx.llm,
            });
            const statusDefinition = defineTeamStatusTool({
                kinds: this.kinds,
                roleFor: kind => this.roleFor(kind),
                runningDispatches: () => this.runningDispatches,
                maxConcurrency: () => this.maxConcurrency,
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
                name: 'team-orchestrator:captain',
                order: this.ctx.systemPrompt.getSectionOrder('TOOL_TEAM_DISPATCH'),
                text: (context) => {
                    if (this.ctx.tools.get(definition.name, context.scope) !== definition)
                        return '';
                    return captainSectionText(this.kinds, kind => this.roleFor(kind));
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
     * Resolve one task kind to its routed role.
     * @param kind - task kind requested by a caller.
     * @returns the routed role.
     */
    roleFor(kind) {
        return resolveTaskKind(this.roles, this.config.taskRouting, kind);
    }
    /** Declared task kinds, in configuration order. */
    get kinds() {
        return Object.keys(this.config.taskRouting);
    }
    /** Maximum concurrently running dispatched children. */
    get maxConcurrency() {
        return this.config.concurrency;
    }
    /** Whether the captain may request a route outside the declared table. */
    get captainMayOverride() {
        return this.config.allowCaptainOverride;
    }
    /**
     * Take one dispatch concurrency slot.
     * @throws when the configured cap is already running.
     */
    admitDispatch() {
        if (this.activeDispatches >= this.config.concurrency) {
            throw new Error(`team-orchestrator: ${this.activeDispatches} dispatches already running`
                + ` (concurrency ${this.config.concurrency}); wait for a completion notice before dispatching again`);
        }
        this.activeDispatches += 1;
    }
    /** Return one dispatch concurrency slot after the dispatched child settles. */
    releaseDispatch() {
        this.activeDispatches -= 1;
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
     * Recent labels already dispatched for one kind, newest first.
     * @param kind - the task kind to look up.
     * @param excludeChildId - one child id to skip, conventionally the dispatch being answered.
     * @returns up to three labels of prior dispatches of this kind.
     */
    recentLabelsFor(kind, excludeChildId) {
        return this.dispatchRecords
            .filter(record => record.kind === kind && record.childId !== excludeChildId)
            .map(record => record.label)
            .slice(0, 3);
    }
    /** Dispatches currently running against the concurrency cap. */
    get runningDispatches() {
        return this.activeDispatches;
    }
    /** The dispatch registry snapshot, newest first. */
    get registry() {
        return this.dispatchRecords;
    }
}
export const name = 'team-orchestrator';
export default TeamOrchestrator;
//# sourceMappingURL=index.js.map