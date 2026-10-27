import { Service } from "@deepseek-ai/cordis";
import { tokenUsageProjectionDefinition } from "@deepseek-ai/dsh-token-meter";
import z from "@deepseek-ai/schemastery";
import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { assertObjectJsonSchema, defineTool } from "@deepseek-ai/dsh-tools";
//#region lib/types/config.js
/**
* Plugin configuration: the declared role table and the task-kind routing that
* selects roles. Structure is validated here; cross-field referents (routing
* targets, live model routes) are validated by {@link ./roles.ts} and the
* service's init-time route check.
*
* @module @deepseek-ai/dsh-experimental-team-orchestrator/config
*/
/** Schemastery schema for {@link Config}; mount rejects on violation. */
const ConfigSchema = z.object({
	provider: z.string().min(1).default("spawn"),
	roles: z.dict(z.object({
		provider: z.string().min(1).required(),
		model: z.string().min(1).required(),
		reasoningEffort: z.string().min(1).required(),
		brief: z.string(),
		preset: z.string().min(1)
	})).required(),
	taskRouting: z.dict(z.string().min(1)).required(),
	concurrency: z.natural().default(3),
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")]).default("provider-managed"),
	allowCaptainOverride: z.boolean().default(false)
});
//#endregion
//#region lib/types/roles.js
/**
* Pure role-table resolution: config data in, resolved per-role child routes
* out. Owns the cross-field referent checks the schema cannot express (routing
* targets, non-empty tables) so misconfiguration rejects at the resolve step.
*
* @module @deepseek-ai/dsh-experimental-team-orchestrator/roles
*/
/**
* Resolve the declared role table. Rejects an empty table, an empty routing
* map, and any routing entry naming an undeclared role.
* @param config - validated plugin configuration.
* @returns roles by role id, keyed in declaration order.
*/
function resolveRoles(config) {
	const roleEntries = Object.entries(config.roles);
	if (roleEntries.length === 0) throw new Error("team-orchestrator: the roles table is empty; declare at least one role");
	const routingEntries = Object.entries(config.taskRouting);
	if (routingEntries.length === 0) throw new Error("team-orchestrator: taskRouting is empty; declare at least one task kind");
	const roles = /* @__PURE__ */ new Map();
	for (const [id, role] of roleEntries) {
		const reasoningEffort = ReasoningEffortId(role.reasoningEffort);
		roles.set(id, {
			id,
			route: {
				provider: role.provider,
				model: role.model,
				reasoningEffort
			},
			options: {
				provider: role.provider,
				model: role.model,
				reasoningEffort
			},
			...role.brief === void 0 ? {} : { brief: role.brief },
			...role.preset === void 0 ? {} : { preset: role.preset }
		});
	}
	for (const [kind, roleId] of routingEntries) if (!roles.has(roleId)) throw new Error(`team-orchestrator: task kind "${kind}" routes to undeclared role "${roleId}"; declared roles: ${roleEntries.map(([id]) => `"${id}"`).join(", ")}`);
	return roles;
}
/**
* Resolve one task kind to its role.
* @param roles - resolved role table.
* @param routing - the configuration's task-kind routing.
* @param kind - task kind requested by the caller.
* @returns the routed role.
*/
function resolveTaskKind(roles, routing, kind) {
	const roleId = routing[kind];
	if (roleId === void 0) throw new Error(`team-orchestrator: unknown task kind "${kind}"; declared kinds: ${Object.keys(routing).map((id) => `"${id}"`).join(", ")}`);
	const role = roles.get(roleId);
	if (role === void 0) throw new Error(`team-orchestrator: task kind "${kind}" routes to undeclared role "${roleId}"`);
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
async function validateRoleRoutes(llm, roles, signal) {
	const deferred = [];
	for (const role of roles.values()) try {
		await llm.resolveCallConfig({ ...role.route }, signal);
	} catch (error) {
		if (error instanceof LlmError && error.code === "NO_ADAPTER") {
			deferred.push(role.id);
			continue;
		}
		throw error;
	}
	return deferred;
}
//#endregion
//#region lib/types/dispatch.js
/**
* The model-facing `team_dispatch` tool: kind-routed delegation through the
* configured role table. The model declares what kind of task it is dispatching
* and writes the brief; the plugin owns which role and route runs it.
*
* @module @deepseek-ai/dsh-experimental-team-orchestrator/dispatch
*/
/**
* Validate tool-call arguments at the tool JSON boundary.
* @param value - raw parsed arguments.
* @returns the validated arguments.
*/
function assertDispatchArgs(value) {
	if (typeof value !== "object" || value === null) throw new Error("team_dispatch arguments must be an object");
	const args = value;
	for (const field of [
		"kind",
		"description",
		"prompt"
	]) {
		const current = args[field];
		if (typeof current !== "string" || current.length === 0) throw new Error(`team_dispatch \`${field}\` must be a non-empty string`);
	}
	if (args.cwd !== void 0 && typeof args.cwd !== "string") throw new Error("team_dispatch `cwd` must be a string");
	if (args.output_schema !== void 0) {
		if (typeof args.output_schema !== "object" || Array.isArray(args.output_schema)) throw new Error("team_dispatch `output_schema` must be an object");
		assertObjectJsonSchema(args.output_schema);
	}
}
/**
* Compose the child prompt: the role's discipline line, then the brief.
* @param role - the routed role.
* @param prompt - the dispatcher's task brief.
* @returns the composed child prompt.
*/
function composeDispatchPrompt(role, prompt) {
	return role.brief === void 0 ? prompt : `${role.brief}\n\n${prompt}`;
}
/**
* Build the `team_dispatch` tool definition. The executor validates the schema,
* so `execute` re-validates only as defense at the tool JSON boundary.
* @param deps - dispatch dependencies.
* @returns the tool definition.
*/
function defineTeamDispatchTool(deps) {
	if (!deps.provider.capabilities.agentOptions) throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support child agentOptions`);
	const presetNeedingRoles = [...deps.team.roleForKinds()].filter((role) => role.preset !== void 0);
	if (presetNeedingRoles.length > 0 && !deps.provider.capabilities.agentPreset) throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support child agent presets (roles with presets: ${presetNeedingRoles.map((role) => `"${role.id}"`).join(", ")})`);
	return defineTool({
		name: "team_dispatch",
		description: "Dispatch one team task to the role configured for its task kind. The role's model and reasoning effort are host-pinned; you choose only the kind and write the complete brief. This tool starts an independently managed subagent and immediately returns its id; the runtime notifies you when it finishes. Before re-dispatching the same kind, check the returned `recent` labels and state what differs from those attempts.",
		parameters: {
			kind: {
				type: "string",
				required: true,
				enum: [...deps.team.kinds],
				description: "Task kind; routes to its configured role and model route."
			},
			description: {
				type: "string",
				required: true,
				description: "A short (3-5 word) description of the delegated task, for display."
			},
			prompt: {
				type: "string",
				required: true,
				description: "Complete, self-contained brief for the role: exact file paths, full expected behavior, and acceptance criteria. The child does not see this conversation."
			},
			cwd: {
				type: "string",
				description: "Initial child working directory. Relative paths use your current directory; omitted inherits it."
			},
			...deps.provider.capabilities.outputSchema ? { output_schema: {
				type: "object",
				additionalProperties: true,
				description: "Optional object-rooted JSON Schema (type/properties/required/additionalProperties/items/enum/const/oneOf only) the child's final answer must satisfy; the validated object arrives with the completion notice."
			} } : {}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "dispatch"
					},
					subagentId: {
						type: "string",
						required: true
					},
					role: {
						type: "string",
						required: true
					},
					model: {
						type: "string",
						required: true
					},
					recent: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `dispatched to role "${value.role}" (${value.model}); started subagent ${value.subagentId}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			assertDispatchArgs(args);
			const parent = exec.agent;
			if (parent === void 0) throw new Error("team_dispatch requires a calling agent (exec.agent was undefined)");
			const role = deps.team.roleFor(args.kind);
			if (args.output_schema !== void 0 && !deps.provider.capabilities.outputSchema) throw new Error(`team-orchestrator: provider "${deps.provider.name}" does not support structured child output`);
			const composed = composeDispatchPrompt(role, args.prompt);
			deps.team.admitDispatch();
			try {
				await deps.llm.resolveCallConfig({ ...role.route }, exec.signal);
				const started = await deps.subagents.startActivation({
					provider: deps.provider.name,
					label: args.description,
					request: {
						...args.cwd === void 0 ? {} : { cwd: args.cwd },
						prompt: [{
							type: "text",
							text: composed
						}],
						parent,
						agentOptions: { ...role.options },
						...role.preset === void 0 ? {} : { agentPreset: role.preset },
						...deps.maxDepth === void 0 ? {} : { maxDepth: deps.maxDepth },
						...args.output_schema === void 0 ? {} : { outputSchema: args.output_schema }
					},
					signal: exec.signal,
					delivery: "parent"
				});
				started.result.catch(() => void 0).then(() => {
					deps.team.releaseDispatch();
					deps.team.markSettled(started.childId);
				});
				deps.team.recordDispatch({
					childId: started.childId,
					kind: args.kind,
					role: role.id,
					model: role.route.model,
					label: args.description
				});
				return {
					kind: "dispatch",
					subagentId: started.childId,
					role: role.id,
					model: role.route.model,
					recent: [...deps.team.recentLabelsFor(args.kind, started.childId)]
				};
			} catch (error) {
				deps.team.releaseDispatch();
				throw error;
			}
		}
	});
}
/**
* The captain prompt section text: the kind→role routing table and briefing
* discipline, rendered only where the tool is visible.
* @param kinds - declared task kinds in configuration order.
* @param roleFor - kind-to-role resolver.
* @returns the section text.
*/
function captainSectionText(kinds, roleFor) {
	return `Delegate team tasks with \`team_dispatch\` by task kind; each kind runs on its configured role and model route:
${kinds.map((kind) => {
		const role = roleFor(kind);
		const effort = role.route.reasoningEffort;
		return `- \`${kind}\` → role \`${role.id}\` (\`${role.route.model}\` at \`${effort}\` reasoning effort)`;
	}).join("\n")}\n\nWrite every brief complete and self-contained — exact file paths, full expected behavior, and acceptance criteria; the child does not see this conversation. Consult a high-effort planning role before dispatching open-ended work to a fast implementation role. Dispatch independent kinds together in one message; when only waiting for results remains, end your turn instead of polling. Check \`team_status\` before dispatching more work when completions seem overdue. Do not re-dispatch the same kind for the same goal: the dispatch result lists that kind's recent labels, and a retry must state what differs from those attempts.`;
}
//#endregion
//#region lib/types/status.js
/**
* The model-facing `team_status` tool: one snapshot of the dispatch registry —
* concurrency against the cap and per-role dispatch counts. Registry state is
* this process's in-memory record; it does not survive restarts and does not
* include token usage (deferred until a cross-session usage read exists).
*
* @module @deepseek-ai/dsh-experimental-team-orchestrator/status
*/
/** Sum captured usage snapshots; undefined when no record carries one. */
function sumUsage(records) {
	const captured = records.filter((record) => record.usage !== void 0);
	if (captured.length === 0) return void 0;
	const totals = {
		uncachedInputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
	for (const record of captured) {
		const usage = record.usage;
		if (usage === void 0) continue;
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
function roleStatusRows(deps) {
	const rows = /* @__PURE__ */ new Map();
	for (const kind of deps.kinds) {
		const role = deps.roleFor(kind);
		if (rows.has(role.id)) continue;
		rows.set(role.id, {
			row: {
				role: role.id,
				model: role.route.model,
				effort: role.route.reasoningEffort,
				dispatched: 0,
				running: 0,
				labels: []
			},
			records: []
		});
	}
	for (const record of deps.registry) {
		const entry = rows.get(record.role);
		if (entry === void 0) continue;
		const running = deps.settledChildIds.has(record.childId) ? 0 : 1;
		entry.records.push(record);
		entry.row = {
			...entry.row,
			dispatched: entry.row.dispatched + 1,
			running: entry.row.running + running,
			labels: [record.label, ...entry.row.labels]
		};
	}
	return [...rows.values()].map(({ row, records }) => {
		const usage = sumUsage(records);
		return usage === void 0 ? row : {
			...row,
			usage
		};
	});
}
/**
* Build the `team_status` tool definition.
* @param deps - status dependencies.
* @returns the tool definition.
*/
function defineTeamStatusTool(deps) {
	return defineTool({
		name: "team_status",
		description: "Report the team dispatch registry: concurrency against the cap, per-role dispatch counts, and summed provider-reported token usage of settled dispatches. Registry state is this process's record.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true,
						const: "status"
					},
					running: {
						type: "number",
						required: true
					},
					concurrency: {
						type: "number",
						required: true
					},
					roles: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								role: {
									type: "string",
									required: true
								},
								model: {
									type: "string",
									required: true
								},
								effort: {
									type: "string",
									required: true
								},
								dispatched: {
									type: "number",
									required: true
								},
								running: {
									type: "number",
									required: true
								},
								usage: {
									type: "object",
									additionalProperties: false,
									properties: {
										uncachedInputTokens: {
											type: "number",
											required: true
										},
										outputTokens: {
											type: "number",
											required: true
										},
										cacheReadTokens: {
											type: "number",
											required: true
										},
										cacheWriteTokens: {
											type: "number",
											required: true
										}
									}
								}
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const rows = value.roles.map((row) => {
					const usage = row.usage === void 0 ? "" : `; tokens in/out ${row.usage.uncachedInputTokens}/${row.usage.outputTokens}`;
					return `${row.role}: ${row.running} running / ${row.dispatched} dispatched (${row.model} at ${row.effort}${usage})`;
				});
				return [{
					type: "text",
					text: `dispatches ${value.running}/${value.concurrency} running\n${rows.join("\n")}`
				}];
			}
		},
		isConcurrencySafe: () => true,
		execute() {
			const roles = roleStatusRows(deps).map((row) => ({
				role: row.role,
				model: row.model,
				effort: row.effort,
				dispatched: row.dispatched,
				running: row.running,
				...row.usage === void 0 ? {} : { usage: row.usage }
			}));
			return Promise.resolve({
				kind: "status",
				running: deps.runningDispatches(),
				concurrency: deps.maxConcurrency(),
				roles
			});
		}
	});
}
//#endregion
//#region lib/types/index.js
/**
* Experimental team orchestrator: a configuration-declared role table resolves
* task kinds to per-role child LLM routes. Roles are host-pinned data — the
* model never names a route. The `team_dispatch` tool and the captain prompt
* section mount when the configured subagent provider registers.
*
* @module @deepseek-ai/dsh-experimental-team-orchestrator
*/
/**
* Owns the resolved role table and the `team_dispatch` delegation tool.
* Structural and referential validation rejects at mount; live route
* validation runs against the LLM runtime at init and, when a provider
* adapter has not registered yet, re-runs on `llm/adapters-updated` — the
* earliest resolvable point for each route. The tool and captain section mount
* when the configured subagent provider registers.
*/
var TeamOrchestrator = class extends Service {
	static inject = [
		"llm",
		"tools",
		"subagents",
		"systemPrompt",
		"sessionProjections",
		"agents"
	];
	static Config = ConfigSchema;
	config;
	roles;
	activeDispatches = 0;
	dispatchRecords = [];
	settledChildren = /* @__PURE__ */ new Set();
	childSessions = /* @__PURE__ */ new Map();
	usageReader;
	constructor(ctx, config) {
		super(ctx, "teamOrchestrator");
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
		const presetIds = [...new Set([...this.roles.values()].map((role) => role.preset).filter((preset) => preset !== void 0))];
		if (presetIds.length === 0) return;
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) throw new Error("team-orchestrator: role presets require the agent-presets service");
		for (const id of presetIds) await presets.resolve(id);
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
		this.ctx.sessionProjections.register(tokenUsageProjectionDefinition).then((handle) => {
			this.usageReader = handle;
		}).catch((error) => {
			this.ctx.logger.error("team-orchestrator: token usage projection unavailable: %s", error);
		});
		this.ctx.effect(() => this.ctx.on("subagent/start", (info) => {
			const session = this.ctx.agents.get(info.id)?.session;
			if (session !== void 0) this.childSessions.set(info.id, session);
		}));
		this.ctx.effect(() => this.ctx.on("subagent/end", (info) => {
			this.captureUsage(info);
		}));
	}
	/**
	* Read one settled child's usage totals onto its dispatch record.
	* @param info - the settled run's end payload.
	*/
	captureUsage(info) {
		const reader = this.usageReader;
		const record = this.dispatchRecords.find((entry) => entry.childId === info.id);
		const session = this.childSessions.get(info.id);
		this.childSessions.delete(info.id);
		if (reader === void 0 || record === void 0 || session === void 0 || record.usage !== void 0) return;
		record.usage = { ...reader.stateOf(session).totals };
	}
	/** Validate declared routes, deferring until every provider adapter registers. */
	async initRouteValidation() {
		if ((await validateRoleRoutes(this.ctx.llm, this.roles)).length === 0) return;
		const disposeRetry = this.ctx.effect(() => this.ctx.on("llm/adapters-updated", () => {
			validateRoleRoutes(this.ctx.llm, this.roles).then(async (stillDeferred) => {
				if (stillDeferred.length === 0) await disposeRetry();
			}).catch((error) => {
				this.ctx.logger.error("team-orchestrator: declared route rejected by the LLM runtime: %s", error);
			});
		}));
	}
	/** Mount `team_dispatch` and the captain section once the provider registers. */
	initDelegationTool() {
		let mounted = false;
		const tryMount = (provider) => {
			if (provider.name !== this.config.provider || mounted) return;
			const maxDepth = this.ctx.subagents.resolveMaxDepth(this.config.maxDepth);
			if (maxDepth !== void 0 && !provider.capabilities.depthLimit) throw new Error(`team-orchestrator: provider "${provider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
			const definition = defineTeamDispatchTool({
				provider,
				subagents: this.ctx.subagents,
				...maxDepth === void 0 ? {} : { maxDepth },
				team: {
					kinds: this.kinds,
					roleFor: (kind) => this.roleFor(kind),
					roleForKinds: () => this.kinds.map((kind) => this.roleFor(kind)),
					admitDispatch: () => {
						this.admitDispatch();
					},
					releaseDispatch: () => {
						this.releaseDispatch();
					},
					recordDispatch: (entry) => {
						this.recordDispatch(entry);
					},
					markSettled: (childId) => {
						this.markSettled(childId);
					},
					recentLabelsFor: (kind, excludeChildId) => this.recentLabelsFor(kind, excludeChildId)
				},
				llm: this.ctx.llm
			});
			const statusDefinition = defineTeamStatusTool({
				kinds: this.kinds,
				roleFor: (kind) => this.roleFor(kind),
				runningDispatches: () => this.runningDispatches,
				maxConcurrency: () => this.maxConcurrency,
				registry: this.dispatchRecords,
				settledChildIds: this.settledChildren
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
				name: "team-orchestrator:captain",
				order: this.ctx.systemPrompt.getSectionOrder("TOOL_TEAM_DISPATCH"),
				text: (context) => {
					if (this.ctx.tools.get(definition.name, context.scope) !== definition) return "";
					return captainSectionText(this.kinds, (kind) => this.roleFor(kind));
				}
			});
			mounted = true;
			this.ctx.effect(() => () => {
				disposeSection();
				disposeTool();
				mounted = false;
			});
		};
		this.ctx.effect(() => this.ctx.on("subagent/provider-added", tryMount));
		const initial = this.ctx.subagents.getProvider(this.config.provider);
		if (initial !== void 0) tryMount(initial);
		else this.ctx.logger.info(`team-orchestrator: subagent provider "${this.config.provider}" not registered yet; the team_dispatch tool will register when it appears`);
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
		if (this.activeDispatches >= this.config.concurrency) throw new Error(`team-orchestrator: ${this.activeDispatches} dispatches already running (concurrency ${this.config.concurrency}); wait for a completion notice before dispatching again`);
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
		return this.dispatchRecords.filter((record) => record.kind === kind && record.childId !== excludeChildId).map((record) => record.label).slice(0, 3);
	}
	/** Dispatches currently running against the concurrency cap. */
	get runningDispatches() {
		return this.activeDispatches;
	}
	/** The dispatch registry snapshot, newest first. */
	get registry() {
		return this.dispatchRecords;
	}
};
const name = "team-orchestrator";
//#endregion
export { TeamOrchestrator, TeamOrchestrator as default, captainSectionText, composeDispatchPrompt, defineTeamDispatchTool, defineTeamStatusTool, name, resolveRoles, resolveTaskKind, roleStatusRows, validateRoleRoutes };
