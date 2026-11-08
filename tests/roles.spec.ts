/** Unit behavior of mode resolution, in-mode routing, and live route validation. */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { Config, ModeConfig } from '../src/config.ts'
import { flattenRoles, resolveMode, resolveModes, resolveTaskKind, validateRoleRoutes } from '../src/roles.ts'

function fastMode(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    concurrency: 3,
    maxDepth: 'provider-managed',
    roles: {
      planner: { provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high' },
      coder: { provider: 'other', model: 'm-fast', reasoningEffort: 'low', brief: 'execute the brief verbatim', preset: 'minimal' },
    },
    taskRouting: { plan: 'planner', implement: 'coder' },
    ...overrides,
  }
}

function strictMode(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    brief: 'Every implementation is followed by a review dispatch.',
    concurrency: 1,
    maxDepth: 'provider-managed',
    roles: {
      planner: { provider: 'deepseek-official', model: 'm-max', reasoningEffort: 'max' },
      challenger: { provider: 'deepseek-official', model: 'm-max', reasoningEffort: 'high' },
    },
    taskRouting: { plan: 'planner', review: 'challenger' },
    ...overrides,
  }
}

function config(overrides?: Partial<Config>): Config {
  return {
    provider: 'spawn',
    modes: { fast: fastMode() },
    allowCaptainOverride: false,
    ...overrides,
  }
}

describe('resolveMode', () => {
  it('builds each role\'s child route and keeps its brief, preset, kind order, and budget', () => {
    const mode = resolveMode('fast', fastMode())
    expect(mode.id).toBe('fast')
    expect(mode.kinds).toEqual(['plan', 'implement'])
    expect(mode.concurrency).toBe(3)
    expect(mode.maxDepth).toBe('provider-managed')
    expect(mode.brief).toBeUndefined()
    expect(mode.roles.get('planner')?.options).toEqual({
      provider: 'deepseek-official', model: 'm-strong', reasoningEffort: 'high',
    })
    expect(mode.roles.get('coder')?.brief).toBe('execute the brief verbatim')
    expect(mode.roles.get('coder')?.preset).toBe('minimal')
    expect(mode.roles.get('planner')?.brief).toBeUndefined()
    expect(mode.roles.get('planner')?.preset).toBeUndefined()
  })

  it('keeps the mode brief and routes a kind through this mode\'s own table', () => {
    const mode = resolveMode('strict', strictMode())
    expect(mode.brief).toBe('Every implementation is followed by a review dispatch.')
    expect(mode.concurrency).toBe(1)
    expect(mode.roleFor('review').id).toBe('challenger')
  })

  it('rejects an empty role table, naming the mode', () => {
    expect(() => resolveMode('fast', fastMode({ roles: {} })))
      .toThrow('mode "fast": the roles table is empty; declare at least one role')
  })

  it('rejects an empty routing map, naming the mode', () => {
    expect(() => resolveMode('fast', fastMode({ taskRouting: {} })))
      .toThrow('mode "fast": taskRouting is empty; declare at least one task kind')
  })

  it('rejects routing that names a role this mode does not declare', () => {
    expect(() => resolveMode('strict', strictMode({ taskRouting: { plan: 'planner', implement: 'coder' } })))
      .toThrow('mode "strict": task kind "implement" routes to undeclared role "coder"')
  })

  it('rejects a fallback identical to its primary route, naming the mode and role', () => {
    const roles = {
      coder: {
        provider: 'p',
        model: 'm',
        reasoningEffort: 'low',
        fallback: { provider: 'p', model: 'm', reasoningEffort: 'low' },
      },
    }
    expect(() => resolveMode('fast', fastMode({ roles, taskRouting: { implement: 'coder' } })))
      .toThrow('mode "fast": role "coder" declares a fallback identical to its primary route')
  })
})

describe('resolveModes', () => {
  it('treats the single declared mode as the default when defaultMode is omitted', () => {
    const team = resolveModes(config())
    expect([...team.modes.keys()]).toEqual(['fast'])
    expect(team.defaultMode.id).toBe('fast')
    expect(team.kinds).toEqual(['plan', 'implement'])
  })

  it('honors an explicit defaultMode and unions kinds in mode-then-declaration order', () => {
    const team = resolveModes(config({ defaultMode: 'strict', modes: { fast: fastMode(), strict: strictMode() } }))
    expect(team.defaultMode.id).toBe('strict')
    expect(team.kinds).toEqual(['plan', 'implement', 'review'])
  })

  it('rejects an empty modes table', () => {
    expect(() => resolveModes(config({ modes: {} })))
      .toThrow('the modes table is empty; declare at least one mode')
  })

  it('rejects several modes without a default instead of guessing', () => {
    expect(() => resolveModes(config({ modes: { fast: fastMode(), strict: strictMode() } })))
      .toThrow('2 modes are declared; set defaultMode to one of "fast", "strict"')
  })

  it('rejects a defaultMode that names no declared mode', () => {
    expect(() => resolveModes(config({ defaultMode: 'turbo', modes: { fast: fastMode() } })))
      .toThrow('defaultMode "turbo" is not a declared mode; declared modes: "fast"')
  })
})

describe('resolveTaskKind', () => {
  it('routes a declared kind to its role within the mode', () => {
    const mode = resolveMode('fast', fastMode())
    expect(resolveTaskKind(mode, 'implement').id).toBe('coder')
  })

  it('rejects a kind another mode routes but this one does not, listing this mode\'s kinds', () => {
    const mode = resolveMode('fast', fastMode())
    expect(() => resolveTaskKind(mode, 'review'))
      .toThrow('mode "fast": unknown task kind "review"; declared kinds: "plan", "implement"')
  })
})

describe('flattenRoles', () => {
  it('keys every mode\'s roles by mode/role in declaration order', () => {
    const team = resolveModes(config({ defaultMode: 'fast', modes: { fast: fastMode(), strict: strictMode() } }))
    const flat = flattenRoles(team)
    expect([...flat.keys()]).toEqual(['fast/planner', 'fast/coder', 'strict/planner', 'strict/challenger'])
    expect(flat.get('strict/challenger')?.route.model).toBe('m-max')
  })
})

describe('surfaced misconfiguration', () => {
  it('treats an explicit null fallback as undeclared', () => {
    const mode = resolveMode('fast', fastMode({
      roles: { coder: { provider: 'p', model: 'm', reasoningEffort: 'low', fallback: null } },
      taskRouting: { implement: 'coder' },
    }))
    expect(mode.roles.get('coder')?.fallback).toBeUndefined()
  })

  it('rejects a declared role that no routing entry names', () => {
    expect(() => resolveMode('fast', fastMode({ taskRouting: { plan: 'planner' } })))
      .toThrow('mode "fast": role "coder" declared but no taskRouting entry names it')
  })

  it('rejects empty and "/"-containing mode and role ids', () => {
    expect(() => resolveMode('', fastMode())).toThrow('a mode id must be non-empty')
    expect(() => resolveMode('a/b', fastMode())).toThrow('mode id "a/b" must not contain "/"')
    expect(() => resolveMode('fast', fastMode({
      roles: { 'b/c': { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      taskRouting: { implement: 'b/c' },
    }))).toThrow('role id "b/c" must not contain "/"')
  })

  it('rejects leftover 0.1 top-level team fields beside modes', () => {
    const legacy = {
      ...config(),
      roles: { ghost: { provider: 'p', model: 'm', reasoningEffort: 'low' } },
      maxDepth: 2,
    } as unknown as Config
    expect(() => resolveModes(legacy)).toThrow('0.1 top-level "roles", "maxDepth" are no longer read')
  })
})

describe('role inheritance', () => {
  it('inherits the parent route and optional fields when the child declares none', () => {
    const mode = resolveMode('fast', fastMode({
      roles: {
        worker: {
          provider: 'other', model: 'm-fast', reasoningEffort: 'low',
          brief: 'follow the brief', preset: 'minimal', maxTokens: 4096,
          fallback: { provider: 'p2', model: 'm-strong', reasoningEffort: 'max' },
        },
        coder: { extends: 'worker' },
      },
      taskRouting: { implement: 'coder' },
    }))
    const coder = mode.roles.get('coder')
    expect(coder?.route).toEqual({ provider: 'other', model: 'm-fast', reasoningEffort: 'low' })
    expect(coder?.options).toEqual({ maxTokens: 4096, provider: 'other', model: 'm-fast', reasoningEffort: 'low' })
    expect(coder?.brief).toBe('follow the brief')
    expect(coder?.preset).toBe('minimal')
    expect(coder?.fallback?.route).toEqual({ provider: 'p2', model: 'm-strong', reasoningEffort: 'max' })
  })

  it('overrides inherited fields field-by-field', () => {
    const mode = resolveMode('fast', fastMode({
      roles: {
        worker: {
          provider: 'other', model: 'm-fast', reasoningEffort: 'low', maxTokens: 4096,
          fallback: { provider: 'p2', model: 'm-strong', reasoningEffort: 'max' },
        },
        reviewer: {
          extends: 'worker', model: 'm-pro', reasoningEffort: 'high', maxTokens: 8192,
          brief: 'review findings only',
        },
      },
      taskRouting: { implement: 'worker', review: 'reviewer' },
    }))
    const reviewer = mode.roles.get('reviewer')
    expect(reviewer?.route).toEqual({ provider: 'other', model: 'm-pro', reasoningEffort: 'high' })
    expect(reviewer?.options).toEqual({ maxTokens: 8192, provider: 'other', model: 'm-pro', reasoningEffort: 'high' })
    expect(reviewer?.brief).toBe('review findings only')
    expect(reviewer?.fallback?.route.model).toBe('m-strong')
    expect(mode.roles.get('worker')?.brief).toBeUndefined()
  })

  it('resolves multi-level chains with the nearest declaration winning', () => {
    const mode = resolveMode('fast', fastMode({
      roles: {
        base: { provider: 'deepseek-official', model: 'm-base', reasoningEffort: 'off' },
        mid: { extends: 'base', reasoningEffort: 'high' },
        leaf: { extends: 'mid', model: 'm-leaf' },
      },
      taskRouting: { implement: 'leaf' },
    }))
    expect(mode.roles.get('leaf')?.route).toEqual({
      provider: 'deepseek-official', model: 'm-leaf', reasoningEffort: 'high',
    })
  })

  it('inherits the fallback through a missing declaration and through an explicit null', () => {
    const mode = resolveMode('fast', fastMode({
      roles: {
        base: {
          provider: 'p', model: 'm', reasoningEffort: 'low',
          fallback: { provider: 'p', model: 'm-strong', reasoningEffort: 'max' },
        },
        escalates: { extends: 'base' },
        plain: { extends: 'base', fallback: null },
      },
      taskRouting: { implement: 'escalates', plan: 'plain' },
    }))
    // The schema normalizes an explicit null to absent, so both children
    // inherit the chain's fallback; a role that must not escalate extends a
    // fallback-free parent instead.
    expect(mode.roles.get('escalates')?.fallback?.route.model).toBe('m-strong')
    expect(mode.roles.get('plain')?.fallback?.route.model).toBe('m-strong')
  })

  it('rejects an unknown inheritance parent and lists the mode\'s roles', () => {
    expect(() => resolveMode('fast', fastMode({
      roles: { coder: { extends: 'worker', provider: 'p', model: 'm', reasoningEffort: 'low' } },
      taskRouting: { implement: 'coder' },
    }))).toThrow('mode "fast": role "coder" extends undeclared role "worker"; declared roles: "coder"')
  })

  it('rejects an inheritance cycle, naming the mode', () => {
    expect(() => resolveMode('fast', fastMode({
      roles: {
        a: { extends: 'b', provider: 'p', model: 'm', reasoningEffort: 'low' },
        b: { extends: 'a' },
      },
      taskRouting: { implement: 'a' },
    }))).toThrow('mode "fast": role inheritance cycle "a" -> "b" -> "a"')
  })

  it('rejects a self-extending role', () => {
    expect(() => resolveMode('fast', fastMode({
      roles: { a: { extends: 'a', provider: 'p', model: 'm', reasoningEffort: 'low' } },
      taskRouting: { implement: 'a' },
    }))).toThrow('mode "fast": role inheritance cycle "a" -> "a"')
  })

  it('rejects a role left without route fields and names the missing ones', () => {
    expect(() => resolveMode('fast', fastMode({
      roles: { coder: { provider: 'p' } },
      taskRouting: { implement: 'coder' },
    }))).toThrow('mode "fast": role "coder" is incomplete after inheritance: missing model, reasoningEffort')
  })

  it('rejects an incomplete chain root before the child that extends it', () => {
    expect(() => resolveMode('fast', fastMode({
      roles: {
        worker: { model: 'm', reasoningEffort: 'low' },
        coder: { extends: 'worker' },
      },
      taskRouting: { implement: 'coder' },
    }))).toThrow('mode "fast": role "worker" is incomplete after inheritance: missing provider')
  })
})

describe('validateRoleRoutes', () => {
  it('passes when the runtime resolves every route of every mode', async () => {
    const seen: string[] = []
    const team = resolveModes(config({ defaultMode: 'fast', modes: { fast: fastMode(), strict: strictMode() } }))
    const deferred = await validateRoleRoutes({
      resolveCallConfig: async (call) => {
        seen.push(`${call.provider}/${call.model}/${call.reasoningEffort ?? ''}`)
        return { ...call }
      },
    }, flattenRoles(team))
    expect(deferred).toEqual([])
    expect(seen).toEqual([
      'deepseek-official/m-strong/high',
      'other/m-fast/low',
      'deepseek-official/m-max/max',
      'deepseek-official/m-max/high',
    ])
  })

  it('defers roles whose provider adapter is not registered yet, keyed by mode/role', async () => {
    const deferred = await validateRoleRoutes({
      resolveCallConfig: async (call) => {
        if (call.provider === 'other') {
          throw new LlmError('no adapter registered for provider "other"', 'NO_ADAPTER')
        }
        return { ...call }
      },
    }, flattenRoles(resolveModes(config())))
    expect(deferred).toEqual(['fast/coder'])
  })

  it('rejects a route the runtime deems invalid', async () => {
    const error = await validateRoleRoutes({
      resolveCallConfig: async (call) => {
        throw new LlmError(
          `provider "${call.provider}" model "${call.model}" does not support reasoning effort "${call.reasoningEffort ?? ''}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      },
    }, flattenRoles(resolveModes(config()))).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(LlmError)
    expect(error instanceof LlmError ? error.code : '').toBe('UNSUPPORTED_REASONING_EFFORT')
  })
})
