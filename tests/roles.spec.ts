/** Unit behavior of role-table resolution and live route validation. */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Config } from '../src/config.ts'
import { resolveRoles, resolveTaskKind, validateRoleRoutes } from '../src/roles.ts'

function config(overrides?: Partial<Config>): Config {
  return {
    provider: 'spawn',
    roles: {
      planner: { provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high' },
      coder: { provider: 'other', model: 'm-fast', reasoningEffort: 'low', brief: 'execute the brief verbatim', preset: 'minimal' },
    },
    taskRouting: { plan: 'planner', implement: 'coder' },
    concurrency: 3,
    maxDepth: 'provider-managed',
    allowCaptainOverride: false,
    ...overrides,
  }
}

describe('resolveRoles', () => {
  it('builds each role\'s child route and keeps its brief and preset', () => {
    const roles = resolveRoles(config())
    expect(roles.size).toBe(2)
    expect(roles.get('planner')?.options).toEqual({
      provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high',
    })
    expect(roles.get('coder')?.brief).toBe('execute the brief verbatim')
    expect(roles.get('coder')?.preset).toBe('minimal')
    expect(roles.get('planner')?.brief).toBeUndefined()
    expect(roles.get('planner')?.preset).toBeUndefined()
  })

  it('rejects an empty role table', () => {
    expect(() => resolveRoles(config({ roles: {} })))
      .toThrow('the roles table is empty')
  })

  it('rejects an empty routing map', () => {
    expect(() => resolveRoles(config({ taskRouting: {} })))
      .toThrow('taskRouting is empty')
  })

  it('rejects routing that names an undeclared role', () => {
    expect(() => resolveRoles(config({ taskRouting: { plan: 'ghost' } })))
      .toThrow('task kind "plan" routes to undeclared role "ghost"')
  })
})

describe('resolveTaskKind', () => {
  it('routes a declared kind to its role', () => {
    const roles = resolveRoles(config())
    expect(resolveTaskKind(roles, config().taskRouting, 'implement').id).toBe('coder')
  })

  it('rejects an unknown kind and lists the declared ones', () => {
    const cfg = config()
    expect(() => resolveTaskKind(resolveRoles(cfg), cfg.taskRouting, 'deploy'))
      .toThrow('unknown task kind "deploy"; declared kinds: "plan", "implement"')
  })
})

describe('validateRoleRoutes', () => {
  it('passes when the runtime resolves every route', async () => {
    const seen: string[] = []
    const deferred = await validateRoleRoutes({
      resolveCallConfig: async (call) => {
        seen.push(`${call.provider}/${call.model}/${call.reasoningEffort ?? ''}`)
        return { ...call }
      },
    }, resolveRoles(config()))
    expect(deferred).toEqual([])
    expect(seen).toEqual(['deepseek-official/m-strong/high', 'other/m-fast/low'])
  })

  it('defers roles whose provider adapter is not registered yet', async () => {
    const deferred = await validateRoleRoutes({
      resolveCallConfig: async (call) => {
        if (call.provider === 'other') {
          throw new LlmError('no adapter registered for provider "other"', 'NO_ADAPTER')
        }
        return { ...call }
      },
    }, resolveRoles(config()))
    expect(deferred).toEqual(['coder'])
  })

  it('rejects a route the runtime deems invalid', async () => {
    const error = await validateRoleRoutes({
      resolveCallConfig: async (call) => {
        throw new LlmError(
          `provider "${call.provider}" model "${call.model}" does not support reasoning effort "${call.reasoningEffort ?? ''}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      },
    }, resolveRoles(config())).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmError)
    expect(error instanceof LlmError ? error.code : '').toBe('UNSUPPORTED_REASONING_EFFORT')
  })
})
