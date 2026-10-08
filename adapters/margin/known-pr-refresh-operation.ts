/** One explicit refresh of an already-known PR. No scheduler, retries or durable caller journal. */
import { z } from 'zod'
import { adapterSiteSchema } from '../../src/worker/margin/adapter'
import {
  adapterSelectorSchema,
  reportId,
} from '../../src/worker/margin/repository'
import {
  createApprovedWorkClient,
  type WorkTransport,
  type WorkReadResult,
  type ReportSubmitResult,
} from './service-client'
import { createKnownPRReader, type KnownPRReadResult } from './known-pr-reader'
import {
  planKnownPRRefresh,
  type KnownPRRefreshCommand,
  type KnownPRRefreshResult,
} from './known-pr-refresh'

// Closed copied envelope; each existing client remains its credential/protocol validator.
const configSchema = z
  .object({
    site: adapterSiteSchema,
    service: z
      .object({
        origin: z.string().min(1).max(2048),
        token: z.string().min(1).max(100),
      })
      .strict(),
    provider: z
      .object({
        token: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[\x21-\x7e]+$/),
      })
      .strict(),
  })
  .strict()
const selectorSchema = z
  .object({
    proposalId: reportId,
    eventId: adapterSelectorSchema,
    cursor: z
      .string()
      .min(1)
      .max(32_768)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
      .optional(),
  })
  .strict()
export type KnownPRRefreshOperationResult =
  | {
      phase: 'operation'
      status: 'refused' | 'not_evaluated'
      reason: 'config' | 'selector' | 'closed' | 'busy'
    }
  | { phase: 'work'; result: Exclude<WorkReadResult, { status: 'ready' }> }
  | {
      phase: 'selection'
      status: 'not_evaluated'
      reason: 'not_in_page'
      nextCursor: string | null
    }
  | {
      phase: 'selection'
      status: 'refused' | 'not_evaluated'
      reason: 'not_refreshable' | 'binding_mismatch' | 'version_exhausted'
    }
  | {
      phase: 'provider'
      result: Exclude<KnownPRReadResult, { status: 'ready' }>
    }
  | {
      phase: 'plan'
      result: Exclude<KnownPRRefreshResult, { status: 'planned' }>
    }
  | {
      phase: 'report'
      command: KnownPRRefreshCommand
      result: ReportSubmitResult
    }

/** Prospective explicit runner primitive. Caller owns event/command retention across
 * ephemeral jobs. Three serial existing per-call deadlines are not a whole-run bound. */
export function createKnownPRRefreshOperation(
  config: unknown,
  transports: {
    serviceTransport: WorkTransport
    providerTransport: WorkTransport
  },
) {
  let host: z.infer<typeof configSchema> | undefined
  let client: ReturnType<typeof createApprovedWorkClient> | undefined
  let reader: ReturnType<typeof createKnownPRReader> | undefined
  try {
    const parsed = configSchema.parse(config)
    const serviceTransport = transports.serviceTransport
    const providerTransport = transports.providerTransport
    if (
      typeof serviceTransport === 'function' &&
      typeof providerTransport === 'function'
    ) {
      client = createApprovedWorkClient(parsed.service, serviceTransport)
      reader = createKnownPRReader(parsed.provider, providerTransport)
      host = parsed
    }
  } catch {
    /* Invalid/accessor-throwing config is unavailable without dispatch. */
  }
  let disposed = false,
    active = false
  const failure = (
    reason: 'config' | 'selector' | 'closed' | 'busy',
  ): KnownPRRefreshOperationResult => ({
    phase: 'operation',
    status: reason === 'busy' ? 'not_evaluated' : 'refused',
    reason,
  })
  return {
    async refresh(input: unknown): Promise<KnownPRRefreshOperationResult> {
      if (disposed) return failure('closed')
      if (!host || !client || !reader) return failure('config')
      if (active) return failure('busy')
      // Acquire before host accessors: reentry cannot launch another operation.
      active = true
      try {
        let selected: z.infer<typeof selectorSchema>
        try {
          selected = selectorSchema.parse(input)
        } catch {
          return failure(disposed ? 'closed' : 'selector')
        }
        if (disposed) return failure('closed')
        const work = await client.readPage({
          limit: 50,
          cursor: selected.cursor,
        })
        if (work.status !== 'ready') return { phase: 'work', result: work }
        if (disposed) return failure('closed')
        const row = work.page.items.find(
          (item) => item.proposalId === selected.proposalId,
        )
        if (!row)
          return {
            phase: 'selection',
            status: 'not_evaluated',
            reason: 'not_in_page',
            nextCursor: work.page.nextCursor,
          }
        if (
          row.work !== 'refresh_pr' ||
          !row.execution.pr ||
          row.execution.stateVersion < 1
        )
          return {
            phase: 'selection',
            status: 'refused',
            reason: 'not_refreshable',
          }
        const pr = row.execution.pr
        if (
          row.site !== host.site ||
          pr.url !== `https://github.com/erniesg/erniesg/pull/${pr.number}`
        )
          return {
            phase: 'selection',
            status: 'refused',
            reason: 'binding_mismatch',
          }
        if (row.execution.stateVersion === Number.MAX_SAFE_INTEGER)
          return {
            phase: 'selection',
            status: 'not_evaluated',
            reason: 'version_exhausted',
          }
        const observed = await reader.readPR({ number: pr.number })
        if (observed.status !== 'ready')
          return { phase: 'provider', result: observed }
        if (disposed) return failure('closed')
        const plan = planKnownPRRefresh(
          { site: host.site },
          {
            binding: {
              work: 'refresh_pr',
              site: row.site,
              proposalId: row.proposalId,
              approvedRevision: row.approvedRevision,
              expectedStateVersion: row.execution.stateVersion,
              pr,
            },
            observation: observed.observation,
            eventId: selected.eventId,
          },
        )
        if (plan.status !== 'planned') return { phase: 'plan', result: plan }
        if (disposed) return failure('closed')
        // Client serializes a closed copy before dispatch. No command is exposed
        // until completion, so callers cannot alter an in-flight event/CAS tuple.
        const result = await client.reportExecution(plan.command)
        // Even disposal cannot erase an already dispatched report's uncertainty.
        return { phase: 'report', command: plan.command, result }
      } finally {
        active = false
      }
    },
    dispose() {
      disposed = true
      client?.dispose()
      reader?.dispose()
    },
  }
}
