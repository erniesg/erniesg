/** Supplied-data planner controls. No provider, client submission or credentials. */
import { describe, expect, it } from 'vitest'
import { adapterExecutionReportSchema } from '../../src/worker/margin/repository'
import { planKnownPRRefresh } from './known-pr-refresh'

const config = { site: 'https://ernie.sg' }
const url = 'https://github.com/erniesg/erniesg/pull/42'
function input() {
  return {
    binding: {
      work: 'refresh_pr',
      site: config.site,
      proposalId: 'private-fixture',
      approvedRevision: 3,
      expectedStateVersion: 7,
      pr: { number: 42, url, head: 'a'.repeat(40) },
    },
    observation: {
      status: 'observed',
      repository: 'erniesg/erniesg',
      number: 42,
      url,
      head: 'b'.repeat(40),
      state: 'open',
      merged: false,
      mergeCommit: null as string | null,
    },
    eventId: 'AAAAAAAAAAAAAAAAAAAAAA',
  }
}

describe('known PR refresh behavioral pilots', () => {
  it('binds changed open head to the exact caller event and CAS without sharing objects', () => {
    const supplied = input()
    const result = planKnownPRRefresh(config, supplied)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('expected private draft')
    expect(result).toEqual({
      status: 'planned',
      provenance: 'supplied-unverified',
      command: {
        eventId: 'AAAAAAAAAAAAAAAAAAAAAA',
        proposalId: 'private-fixture',
        approvedRevision: 3,
        expectedStateVersion: 7,
        outcome: {
          state: 'pr_open',
          pr: { number: 42, url, head: 'b'.repeat(40) },
          checks: 'not_evaluated',
          detail: null,
        },
      },
    })
    expect(adapterExecutionReportSchema.parse(result.command)).toEqual(
      result.command,
    )
    supplied.observation.head = 'c'.repeat(40)
    supplied.binding.proposalId = 'changed'
    expect(result.command.proposalId).toBe('private-fixture')
    expect(result.command.outcome.pr.head).toBe('b'.repeat(40))
    result.command.outcome.pr.number = 99
    expect(supplied.binding.pr.number).toBe(42)
    expect(supplied.observation.number).toBe(42)
  })

  it('distinguishes merged and unmerged closure and refuses contradictory evidence', () => {
    for (const merged of [false, true]) {
      const supplied = input()
      supplied.observation.state = 'closed'
      supplied.observation.merged = merged
      supplied.observation.mergeCommit = merged ? 'c'.repeat(40) : null
      const result = planKnownPRRefresh(config, supplied)
      expect(result.status).toBe('planned')
      if (result.status !== 'planned') throw Error('expected private draft')
      expect(result.command.outcome).toEqual(
        merged
          ? {
              state: 'merged',
              pr: { number: 42, url, head: 'b'.repeat(40) },
              mergeCommit: 'c'.repeat(40),
            }
          : { state: 'closed', pr: { number: 42, url, head: 'b'.repeat(40) } },
      )
      expect(
        adapterExecutionReportSchema.safeParse(result.command).success,
      ).toBe(true)
    }
    const supplied = input()
    supplied.observation.merged = true
    supplied.observation.mergeCommit = 'c'.repeat(40)
    expect(planKnownPRRefresh(config, supplied)).toEqual({
      status: 'refused',
      reason: 'inconsistent_observation',
    })
  })

  it('rejects site or retained PR identity mismatch without a command', () => {
    const changes = [
      (v: ReturnType<typeof input>) => {
        v.binding.site = 'https://other.example'
      },
      (v: ReturnType<typeof input>) => {
        v.observation.number = 43
      },
      (v: ReturnType<typeof input>) => {
        v.observation.url = url + '?view=1'
      },
      (v: ReturnType<typeof input>) => {
        v.binding.pr.url = 'https://github.com/other/repo/pull/42'
      },
    ]
    for (const change of changes) {
      const supplied = input()
      change(supplied)
      expect(planKnownPRRefresh(config, supplied)).toEqual({
        status: 'refused',
        reason: 'binding_mismatch',
      })
    }
  })

  it('does not turn unavailable PR lookup or an exhausted version into an apply failure', () => {
    for (const reason of [
      'not_found',
      'forbidden',
      'transport',
      'incomplete',
    ]) {
      const supplied = {
        ...input(),
        observation: { status: 'unavailable', reason },
      }
      expect(planKnownPRRefresh(config, supplied)).toEqual({
        status: 'not_evaluated',
        reason,
      })
    }
    const supplied = input()
    supplied.binding.expectedStateVersion = Number.MAX_SAFE_INTEGER
    expect(planKnownPRRefresh(config, supplied)).toEqual({
      status: 'not_evaluated',
      reason: 'version_exhausted',
    })
  })

  it('rejects non-refresh routing, malformed caller identity and oversized inputs', () => {
    for (const work of ['apply', 'reconcile_only', 'unknown']) {
      const supplied = input()
      supplied.binding.work = work
      expect(planKnownPRRefresh(config, supplied)).toEqual({
        status: 'refused',
        reason: 'invalid_input',
      })
    }
    for (const eventId of ['', 'not-canonical', 'A'.repeat(32_769)]) {
      expect(planKnownPRRefresh(config, { ...input(), eventId })).toEqual({
        status: 'refused',
        reason: 'invalid_input',
      })
    }
    expect(
      planKnownPRRefresh(config, { ...input(), authenticated: true }),
    ).toEqual({ status: 'refused', reason: 'invalid_input' })
  })
})

describe('known PR refresh boundary controls', () => {
  it.each([
    ['open', true, null],
    ['open', false, 'c'.repeat(40)],
    ['open', true, 'c'.repeat(40)],
    ['closed', true, null],
    ['closed', false, 'c'.repeat(40)],
  ] as const)(
    'refuses inconsistent %s merged=%s merge=%s without a command',
    (state, merged, mergeCommit) => {
      const supplied = input()
      Object.assign(supplied.observation, { state, merged, mergeCommit })
      expect(planKnownPRRefresh(config, supplied)).toEqual({
        status: 'refused',
        reason: 'inconsistent_observation',
      })
    },
  )

  it.each([
    'https://github.com/erniesg/erniesg/pull/042',
    'https://github.com/erniesg/erniesg/pull/%34%32',
    'https://github.com/erniesg/erniesg/pull/42/',
    'https://github.com/erniesg/erniesg/pull/42?view=1',
    'https://github.com/erniesg/erniesg/pull/42#discussion',
    'https://github.com/erniesg/other/pull/42',
    'https://github.example/erniesg/erniesg/pull/42',
    'http://github.com/erniesg/erniesg/pull/42',
    'https://github.com:8443/erniesg/erniesg/pull/42',
  ])('rejects a consistently supplied but unsupported PR URL: %s', (alias) => {
    const supplied = input()
    supplied.binding.pr.url = supplied.observation.url = alias
    expect(planKnownPRRefresh(config, supplied)).toEqual({
      status: 'refused',
      reason: 'binding_mismatch',
    })
  })

  it.each([
    'https://user@github.com/erniesg/erniesg/pull/42',
    'https://github.com:443/erniesg/erniesg/pull/42',
    'https://GITHUB.COM/erniesg/erniesg/pull/42',
    'not a URL',
  ])(
    'rejects noncanonical or credential-bearing URLs without echoing input',
    (alias) => {
      const supplied = input()
      supplied.binding.pr.url = supplied.observation.url = alias
      expect(planKnownPRRefresh(config, supplied)).toEqual({
        status: 'refused',
        reason: 'invalid_input',
      })
    },
  )

  it('requires independent agreement of supplied repository, number and canonical URL', () => {
    const supplied = input()
    supplied.observation.repository = 'another/repository'
    expect(planKnownPRRefresh(config, supplied)).toEqual({
      status: 'refused',
      reason: 'binding_mismatch',
    })
    supplied.observation.repository = 'erniesg/erniesg'
    supplied.observation.number = 43
    supplied.observation.url = 'https://github.com/erniesg/erniesg/pull/43'
    expect(planKnownPRRefresh(config, supplied)).toEqual({
      status: 'refused',
      reason: 'binding_mismatch',
    })
  })

  it.each(['not_found', 'forbidden', 'transport', 'incomplete'])(
    'keeps unavailable %s distinct from closed, with no command/count',
    (reason) => {
      expect(
        planKnownPRRefresh(config, {
          ...input(),
          observation: { status: 'unavailable', reason },
        }),
      ).toEqual({ status: 'not_evaluated', reason })
    },
  )

  it('validates retained binding even when the observation is unavailable', () => {
    const supplied = input()
    supplied.binding.site = 'https://other.example'
    expect(
      planKnownPRRefresh(config, {
        ...supplied,
        observation: { status: 'unavailable', reason: 'not_found' },
      }),
    ).toEqual({ status: 'refused', reason: 'binding_mismatch' })
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid version %s without synthesizing a replacement',
    (version) => {
      const supplied = input()
      supplied.binding.expectedStateVersion = version
      expect(planKnownPRRefresh(config, supplied)).toEqual({
        status: 'refused',
        reason: 'invalid_input',
      })
    },
  )

  it('allows the last incrementable version and exact shared 64-character commit format', () => {
    const supplied = input()
    supplied.binding.expectedStateVersion = Number.MAX_SAFE_INTEGER - 1
    supplied.binding.approvedRevision = Number.MAX_SAFE_INTEGER
    supplied.binding.pr.head = 'a'.repeat(64)
    supplied.observation.head = 'b'.repeat(64)
    const result = planKnownPRRefresh(config, supplied)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('expected draft')
    expect(result.command.expectedStateVersion).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    )
    expect(result.command.approvedRevision).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.command.outcome.pr.head).toBe('b'.repeat(64))
    expect(adapterExecutionReportSchema.safeParse(result.command).success).toBe(
      true,
    )
  })

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retained number or revision %s',
    (value) => {
      for (const field of ['number', 'approvedRevision']) {
        const supplied = input()
        if (field === 'number') supplied.binding.pr.number = value
        else supplied.binding.approvedRevision = value
        expect(planKnownPRRefresh(config, supplied)).toEqual({
          status: 'refused',
          reason: 'invalid_input',
        })
      }
    },
  )

  it('does not accept an event with noncanonical pad bits or synthesize a valid ID', () => {
    expect(
      planKnownPRRefresh(config, {
        ...input(),
        eventId: 'AAAAAAAAAAAAAAAAAAAAAB',
      }),
    ).toEqual({ status: 'refused', reason: 'invalid_input' })
  })

  it('rejects malformed full commits at all three supplied commit positions', () => {
    for (const value of [
      '',
      'a'.repeat(39),
      'a'.repeat(41),
      'A'.repeat(40),
      'g'.repeat(40),
    ]) {
      for (const position of ['retained', 'head', 'merge']) {
        const supplied = input()
        if (position === 'retained') supplied.binding.pr.head = value
        else if (position === 'head') supplied.observation.head = value
        else
          Object.assign(supplied.observation, {
            state: 'closed',
            merged: true,
            mergeCommit: value,
          })
        expect(planKnownPRRefresh(config, supplied)).toEqual({
          status: 'refused',
          reason: 'invalid_input',
        })
      }
    }
  })

  it.each([
    null,
    [],
    {},
    { site: 'invalid' },
    { ...config, authenticated: true },
  ])('refuses malformed host configuration %j', (badConfig) => {
    expect(planKnownPRRefresh(badConfig, input())).toEqual({
      status: 'refused',
      reason: 'invalid_config',
    })
  })

  it('rejects absent/extra fields and arrays at every closed object boundary', () => {
    for (const position of ['root', 'binding', 'pr', 'observation'] as const) {
      for (const variant of ['missing', 'extra', 'array'] as const) {
        const supplied: any = input()
        const target =
          position === 'root'
            ? supplied
            : position === 'pr'
              ? supplied.binding.pr
              : supplied[position]
        if (variant === 'missing') delete target[Object.keys(target)[0]]
        else if (variant === 'extra') target.authenticated = true
        else if (position === 'root') {
          expect(planKnownPRRefresh(config, [supplied])).toEqual({
            status: 'refused',
            reason: 'invalid_input',
          })
          continue
        } else if (position === 'pr') supplied.binding.pr = []
        else supplied[position] = []
        expect(planKnownPRRefresh(config, supplied)).toEqual({
          status: 'refused',
          reason: 'invalid_input',
        })
      }
    }
    for (const observation of [
      null,
      { status: 'unavailable' },
      { status: 'unavailable', reason: 'other' },
      { status: 'unavailable', reason: 'not_found', merged: true },
    ]) {
      expect(planKnownPRRefresh(config, { ...input(), observation })).toEqual({
        status: 'refused',
        reason: 'invalid_input',
      })
    }
  })

  it('bounds scalars without padding valid protocol fields to an unreachable envelope size', () => {
    const supplied = input()
    supplied.binding.proposalId = '😀'.repeat(1024) // 2048 UTF16 units, 4096 actual UTF8 bytes.
    const result = planKnownPRRefresh(config, supplied)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('expected draft')
    expect(result.command.proposalId).toBe(supplied.binding.proposalId)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      32 * 1024,
    )
    supplied.binding.proposalId += 'x'
    expect(planKnownPRRefresh(config, supplied)).toEqual({
      status: 'refused',
      reason: 'invalid_input',
    })
    for (const position of ['proposalId', 'url', 'repository']) {
      const oversized = input()
      if (position === 'proposalId')
        oversized.binding.proposalId = 'x'.repeat(32 * 1024 + 1)
      else if (position === 'url')
        oversized.observation.url =
          'https://example.invalid/' + 'x'.repeat(32 * 1024 + 1)
      else oversized.observation.repository = 'x'.repeat(32 * 1024 + 1)
      expect(planKnownPRRefresh(config, oversized)).toEqual({
        status: 'refused',
        reason: 'invalid_input',
      })
    }
  })

  it('accepts an explicit projection from a known-PR conflict without taking apply/count fields', () => {
    const row = {
      site: config.site,
      proposalId: 'private-fixture',
      approvedRevision: 3,
      work: 'refresh_pr',
      execution: {
        state: 'conflict',
        stateVersion: 7,
        failedApplyCount: 3,
        pr: input().binding.pr,
        checks: 'not_evaluated',
        detail: 'supplied conflict',
      },
    }
    const supplied = input()
    supplied.binding = {
      work: row.work,
      site: row.site,
      proposalId: row.proposalId,
      approvedRevision: row.approvedRevision,
      expectedStateVersion: row.execution.stateVersion,
      pr: row.execution.pr,
    }
    const result = planKnownPRRefresh(config, supplied)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') throw Error('expected draft')
    expect(result.command.outcome.state).toBe('pr_open')
    expect(result.command).not.toHaveProperty('failedApplyCount')
    expect(row.execution.failedApplyCount).toBe(3)
    expect(
      planKnownPRRefresh(config, {
        ...supplied,
        binding: { ...supplied.binding, failedApplyCount: 3 },
      }),
    ).toEqual({ status: 'refused', reason: 'invalid_input' })
  })
})

describe('configured check observation projection', () => {
  const profile =
    'a18da97e6446100605fc3b3accb53ffed12f1597d5a5433577aead8086a01859'
  it('projects only a bound closed profile and preserves caller CAS and unverified provenance', () => {
    for (const [state, reason] of [
      ['passed', 'complete'],
      ['failed', 'failed'],
      ['pending', 'pending'],
      ['not_evaluated', 'provider_refused'],
    ] as const) {
      const v = input()
      const observation = {
        ...v.observation,
        checks: { profile, head: v.observation.head, state, reason },
      }
      const r = planKnownPRRefresh(config, { ...v, observation })
      expect(r.status).toBe('planned')
      if (r.status !== 'planned') throw Error('planned')
      expect(r.provenance).toBe('supplied-unverified')
      expect(r.command.expectedStateVersion).toBe(7)
      expect(r.command.outcome).toMatchObject({
        checks: state,
        pr: { head: v.observation.head },
      })
      if (r.command.outcome.state !== 'pr_open') throw Error('open')
      expect(r.command.outcome.detail).toContain('not merge eligibility')
      expect(r.command.outcome.detail).toContain(reason)
    }
  })
  it('rejects profile/head/reason forgery and extra fields across the entire optional projection', () => {
    const v = input()
    const checks = {
      profile,
      head: v.observation.head,
      state: 'passed',
      reason: 'complete',
    }
    for (const delta of [
      { profile: 'wrong' },
      { head: 'c'.repeat(40) },
      { reason: 'timeout' },
      { state: 'failed' },
      { complete: true },
    ]) {
      expect(
        planKnownPRRefresh(config, {
          ...v,
          observation: { ...v.observation, checks: { ...checks, ...delta } },
        }).status,
      ).toBe('refused')
    }
  })
})
