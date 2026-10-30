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

import z from '@deepseek-ai/schemastery'

/** The stronger route a role escalates to when its primary child fails. */
export interface FallbackConfig {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Adapter-owned reasoning effort id for this exact route. */
  readonly reasoningEffort: string
}

/**
 * One declared team role and its pinned child LLM route.
 */
export interface RoleConfig {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Adapter-owned reasoning effort id for this exact route. */
  readonly reasoningEffort: string
  /** One-line role discipline prepended to delegated prompts. */
  readonly brief?: string
  /** Agent preset id the role's children join; requires the agent-presets service and a provider with the agentPreset capability. */
  readonly preset?: string
  /** Output-token ceiling per child request; caps runaway reasoning. */
  readonly maxTokens?: number
  /**
   * Stronger route this role escalates to when its primary child settles
   * without completing. Absent (or explicitly null) when the role declares no
   * fallback; a schemastery nested object cannot express "absent" because it
   * defaults to `{}` and then rejects its own required children.
   */
  readonly fallback?: FallbackConfig | null
}

/**
 * One selectable team mode: the complete team a dispatch runs in. Modes own
 * their role set, routing, concurrency cap, and depth cap, so a cheap mode and
 * a strict mode differ in who exists, which model each role runs on, and how
 * much work is admitted at once.
 */
export interface ModeConfig {
  /** Mode discipline shown to the captain; advisory guidance, not a runtime gate. */
  readonly brief?: string
  /** Declared roles by role id; every id must be non-empty. */
  readonly roles: Readonly<Record<string, RoleConfig>>
  /** Task-kind routing for this mode; every kind must be non-empty and name a role this mode declares. */
  readonly taskRouting: Readonly<Record<string, string>>
  /** Maximum concurrently running dispatched children of this mode. */
  readonly concurrency: number
  /** Explicit delegation-depth cap for this mode's children, or provider-managed. */
  readonly maxDepth: number | 'provider-managed'
}

/** The plugin's deployment configuration. */
export interface Config {
  /** Registered continuable subagent provider children dispatch through. */
  readonly provider: string
  /**
   * Mode a dispatch runs in when it omits `mode`. Optional when exactly one mode
   * is declared (that mode is the default); required naming a declared mode when
   * more than one is.
   */
  readonly defaultMode?: string
  /** Selectable team modes by mode id. */
  readonly modes: Readonly<Record<string, ModeConfig>>
  /** Reserved: whether the captain may request a route outside the declared table. */
  readonly allowCaptainOverride: boolean
}

/** Schemastery schema for one role's stronger escalation route. */
const FallbackSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string().min(1).required(),
})

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
})

/** Schemastery schema for one mode. */
const ModeSchema = z.object({
  brief: z.string(),
  roles: z.dict(RoleSchema).required(),
  taskRouting: z.dict(z.string().min(1)).required(),
  concurrency: z.natural().default(3),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default('provider-managed'),
})

/** Schemastery schema for {@link Config}; mount rejects on violation. */
export const ConfigSchema: z<Config> = z.object({
  provider: z.string().min(1).default('spawn'),
  defaultMode: z.string().min(1),
  modes: z.dict(ModeSchema).required(),
  allowCaptainOverride: z.boolean().default(false),
})
