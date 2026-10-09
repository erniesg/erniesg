/** Supplied-data conversion only. A draft confers no approval or provider freshness. */
import { z } from 'zod'
import { configuredChecksSchema } from './known-pr-reader'
import { adapterSiteSchema } from '../../src/worker/margin/adapter'
import {
  adapterExecutionReportSchema,
  adapterSelectorSchema,
  reportCommit,
  reportId,
  reportInteger,
  reportURL,
  type AdapterExecutionReport,
  type AdapterReportOutcome,
} from '../../src/worker/margin/repository'

const configSchema = z.object({ site: adapterSiteSchema }).strict()
const prSchema = z
  .object({
    number: reportInteger.positive(),
    url: reportURL,
    head: reportCommit,
  })
  .strict()
const inputSchema = z
  .object({
    binding: z
      .object({
        work: z.literal('refresh_pr'),
        site: adapterSiteSchema,
        proposalId: reportId,
        approvedRevision: reportInteger.positive(),
        expectedStateVersion: reportInteger.positive(),
        pr: prSchema,
      })
      .strict(),
    observation: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('unavailable'),
          reason: z.enum(['not_found', 'forbidden', 'transport', 'incomplete']),
        })
        .strict(),
      z
        .object({
          status: z.literal('observed'),
          repository: z.string().max(256),
          number: reportInteger.positive(),
          url: reportURL,
          head: reportCommit,
          state: z.enum(['open', 'closed']),
          merged: z.boolean(),
          mergeCommit: reportCommit.nullable(),
          checks: configuredChecksSchema.optional(),
        })
        .strict(),
    ]),
    eventId: adapterSelectorSchema,
  })
  .strict()

type RefreshOutcome = Extract<
  AdapterReportOutcome,
  { state: 'pr_open' | 'merged' | 'closed' }
>
export type KnownPRRefreshCommand = Omit<AdapterExecutionReport, 'outcome'> & {
  outcome: RefreshOutcome
}
export type KnownPRRefreshResult =
  | {
      status: 'planned'
      provenance: 'supplied-unverified'
      command: KnownPRRefreshCommand
    }
  | {
      status: 'refused'
      reason:
        | 'invalid_config'
        | 'invalid_input'
        | 'binding_mismatch'
        | 'inconsistent_observation'
        | 'bounds'
    }
  | {
      status: 'not_evaluated'
      reason:
        | 'version_exhausted'
        | 'not_found'
        | 'forbidden'
        | 'transport'
        | 'incomplete'
    }

const envelopeBytes = 32 * 1024
const withinBounds = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= envelopeBytes

/** The future runner must select/project one current /work refresh_pr row and
 * independently obtain the observation. This function neither reads nor submits. */
export function planKnownPRRefresh(
  config: unknown,
  input: unknown,
): KnownPRRefreshResult {
  let host: z.infer<typeof configSchema>
  try {
    host = configSchema.parse(config)
  } catch {
    return { status: 'refused', reason: 'invalid_config' }
  }
  try {
    // Parsing copies only closed scalar shapes; raw inputs are never serialized.
    const parsed = inputSchema.parse(input)
    if (!withinBounds({ config: host, input: parsed }))
      return { status: 'refused', reason: 'bounds' }
    const { binding: b, observation: o, eventId } = parsed
    const url = `https://github.com/erniesg/erniesg/pull/${b.pr.number}`
    if (b.site !== host.site || b.pr.url !== url)
      return { status: 'refused', reason: 'binding_mismatch' }
    if (b.expectedStateVersion === Number.MAX_SAFE_INTEGER)
      return { status: 'not_evaluated', reason: 'version_exhausted' }
    if (o.status === 'unavailable')
      return { status: 'not_evaluated', reason: o.reason }
    if (
      o.repository !== 'erniesg/erniesg' ||
      o.number !== b.pr.number ||
      o.url !== url
    )
      return { status: 'refused', reason: 'binding_mismatch' }
    if (
      o.state === 'open'
        ? o.merged || o.mergeCommit !== null
        : o.merged !== (o.mergeCommit !== null)
    )
      return { status: 'refused', reason: 'inconsistent_observation' }
    if (o.checks && (o.state !== 'open' || o.checks.head !== o.head))
      return { status: 'refused', reason: 'binding_mismatch' }
    const pr = { number: b.pr.number, url: b.pr.url, head: o.head }
    const outcome: RefreshOutcome =
      o.state === 'open'
        ? {
            state: 'pr_open',
            pr,
            checks: o.checks?.state ?? 'not_evaluated',
            detail: o.checks
              ? `Configured head-job profile ${o.checks.profile}: ${o.checks.reason}; reported snapshot, not merge eligibility.`
              : null,
          }
        : o.merged && o.mergeCommit !== null
          ? { state: 'merged', pr, mergeCommit: o.mergeCommit }
          : { state: 'closed', pr }
    const command = adapterExecutionReportSchema.parse({
      eventId,
      proposalId: b.proposalId,
      approvedRevision: b.approvedRevision,
      expectedStateVersion: b.expectedStateVersion,
      outcome,
    })
    // Narrow the shared command type without granting new report outcomes.
    if (!('pr' in command.outcome))
      return { status: 'refused', reason: 'invalid_input' }
    const result: KnownPRRefreshResult = {
      status: 'planned',
      provenance: 'supplied-unverified',
      command: { ...command, outcome: command.outcome },
    }
    return withinBounds(result)
      ? result
      : { status: 'refused', reason: 'bounds' }
  } catch {
    return { status: 'refused', reason: 'invalid_input' }
  }
}
