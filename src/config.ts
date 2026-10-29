/**
 * Plugin configuration: the declared role table and the task-kind routing that
 * selects roles. Structure is validated here; cross-field referents (routing
 * targets, live model routes) are validated by {@link ./roles.ts} and the
 * service's init-time route check.
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

/** One declared team role and its pinned child LLM route. */
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
  /** Stronger route this role escalates to when its primary child settles without completing. */
  readonly fallback?: FallbackConfig
}

/** The plugin's deployment configuration. */
export interface Config {
  /** Registered continuable subagent provider children dispatch through. */
  readonly provider: string
  /** Declared roles by role id; every id must be non-empty. */
  readonly roles: Readonly<Record<string, RoleConfig>>
  /** Task-kind routing; every kind must be non-empty and name a declared role. */
  readonly taskRouting: Readonly<Record<string, string>>
  /** Maximum concurrently running dispatched children. */
  readonly concurrency: number
  /** Explicit delegation-depth cap for dispatched children, or provider-managed. */
  readonly maxDepth: number | 'provider-managed'
  /** Reserved: whether the captain may request a route outside the declared table. */
  readonly allowCaptainOverride: boolean
}

/** Schemastery schema for {@link Config}; mount rejects on violation. */
export const ConfigSchema: z<Config> = z.object({
  provider: z.string().min(1).default('spawn'),
  roles: z.dict(z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
    reasoningEffort: z.string().min(1).required(),
    brief: z.string(),
    preset: z.string().min(1),
    maxTokens: z.natural().min(1),
    fallback: z.object({
      provider: z.string().min(1).required(),
      model: z.string().min(1).required(),
      reasoningEffort: z.string().min(1).required(),
    }),
  })).required(),
  taskRouting: z.dict(z.string().min(1)).required(),
  concurrency: z.natural().default(3),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]).default('provider-managed'),
  allowCaptainOverride: z.boolean().default(false),
})
