/**
 * Mount-path behavior: the schemastery config schema (as cordis validates it),
 * its defaults, and the handoff to mode resolution. The unit suites elsewhere
 * build `Config` literals directly, so this file is the only place the schema
 * itself runs — a schema that rejects a valid configuration unmounts the plugin.
 */
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { resolveModes } from '../src/roles.ts'

interface StandardResult {
  value?: unknown
  issues?: readonly { message: string }[]
}

interface StandardSchema {
  '~standard': {
    validate(value: unknown): StandardResult | Promise<StandardResult>
  }
}

const validate = (ConfigSchema as unknown as StandardSchema)['~standard'].validate

async function accepted(input: unknown): Promise<Config> {
  const result = await validate(input)
  if (result.issues !== undefined) {
    throw new Error(`unexpected rejection: ${result.issues.map(issue => issue.message).join('; ')}`)
  }
  return result.value as Config
}

async function rejected(input: unknown): Promise<string> {
  const result = await validate(input)
  if (result.issues === undefined) throw new Error('expected the schema to reject this configuration')
  return result.issues.map(issue => issue.message).join('; ')
}

/** The shipped `cordis.patch.yml` shape: two modes, several roles without a fallback. */
function shippedShape(): Record<string, unknown> {
  const weak = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
    brief: 'You are the implementation role.',
    maxTokens: 65536,
    fallback: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  }
  return {
    provider: 'spawn',
    defaultMode: 'fast',
    modes: {
      fast: {
        brief: 'Prefer the cheapest route that can deliver.',
        concurrency: 3,
        roles: { planner: weak, coder: weak, reviewer: weak },
        taskRouting: { plan: 'planner', implement: 'coder', review: 'reviewer' },
      },
      strict: {
        brief: 'Every implementation is followed by a review dispatch.',
        concurrency: 2,
        roles: {
          planner: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
          coder: weak,
          reviewer: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
          verifier: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
        },
        taskRouting: { plan: 'planner', implement: 'coder', review: 'reviewer', verify: 'verifier' },
      },
    },
  }
}

describe('ConfigSchema', () => {
  it('accepts the shipped default shape and hands it to mode resolution', async () => {
    const config = await accepted(shippedShape())
    expect(config.defaultMode).toBe('fast')
    expect(config.provider).toBe('spawn')
    expect(config.modes.fast?.concurrency).toBe(3)
    expect(config.modes.strict?.concurrency).toBe(2)
    expect(config.modes.fast?.maxDepth).toBe('provider-managed')
    expect(config.modes.strict?.maxDepth).toBe('provider-managed')
    const team = resolveModes(config)
    expect([...team.modes.keys()]).toEqual(['fast', 'strict'])
    expect(team.defaultMode.id).toBe('fast')
    expect(team.kinds).toEqual(['plan', 'implement', 'review', 'verify'])
    expect([...team.modes.get('strict')!.roles.keys()]).toEqual(['planner', 'coder', 'reviewer', 'verifier'])
  })

  it('accepts a role that declares no fallback', async () => {
    const config = await accepted({
      modes: {
        solo: {
          roles: {
            planner: { provider: 'p', model: 'm', reasoningEffort: 'low' },
            coder: { provider: 'p', model: 'm', reasoningEffort: 'low', fallback: { provider: 'p', model: 'x', reasoningEffort: 'high' } },
          },
          taskRouting: { plan: 'planner', implement: 'coder' },
        },
      },
    })
    const mode = resolveModes(config).defaultMode
    expect(mode.roles.get('planner')?.fallback).toBeUndefined()
    expect(mode.roles.get('coder')?.fallback?.route.model).toBe('x')
  })

  it('treats an explicit null fallback as undeclared', async () => {
    const config = await accepted({
      modes: {
        solo: {
          roles: { coder: { provider: 'p', model: 'm', reasoningEffort: 'low', fallback: null } },
          taskRouting: { implement: 'coder' },
        },
      },
    })
    expect(resolveModes(config).defaultMode.roles.get('coder')?.fallback).toBeUndefined()
  })

  it('rejects an incomplete fallback route', async () => {
    const message = await rejected({
      modes: {
        solo: {
          roles: { coder: { provider: 'p', model: 'm', reasoningEffort: 'low', fallback: { provider: 'p' } } },
          taskRouting: { implement: 'coder' },
        },
      },
    })
    expect(message).toContain('fallback')
  })

  it('rejects a role that omits a pinned route field', async () => {
    const message = await rejected({
      modes: {
        solo: {
          roles: { coder: { provider: 'p', reasoningEffort: 'low' } },
          taskRouting: { implement: 'coder' },
        },
      },
    })
    expect(message).toContain('model')
  })

  it('rejects a configuration with no modes table', async () => {
    expect(await rejected({ provider: 'spawn' })).toContain('modes')
  })

  it('preserves leftover 0.1 top-level fields so mode resolution can reject them', async () => {
    const input = {
      ...shippedShape(),
      roles: { ghost: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      concurrency: 9,
    }
    const config = await accepted(input)
    expect((config as unknown as Record<string, unknown>).concurrency).toBe(9)
    expect(() => resolveModes(config)).toThrow('0.1 top-level "roles", "concurrency"')
  })
})
