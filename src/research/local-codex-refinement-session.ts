import {
  createLocalCodexReconciliationClient,
  validateLocalCodexEndpoint,
  type LocalCodexJsonRpcNotification,
  type LocalCodexJsonRpcRequest,
  type LocalCodexJsonRpcTransport,
  type LocalCodexReconciliationClientConfig,
  type LocalCodexReconciliationRequest,
  type LocalCodexReconciliationResult,
} from './local-codex-reconciliation'
import { hashTraceValue } from './reconstruction-attempt-trace'

export const LOCAL_CODEX_REFINEMENT_SESSION_SCHEMA_VERSION = '1.0.0' as const

export type LocalCodexRefinementSession = {
  schemaVersion: typeof LOCAL_CODEX_REFINEMENT_SESSION_SCHEMA_VERSION
  sessionSha256: string
  reconcile: (
    request: LocalCodexReconciliationRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<LocalCodexReconciliationResult>
  close: () => Promise<void>
}

type CachedRequest = {
  fingerprint: string
  promise: Promise<LocalCodexReconciliationResult>
}

function invalid(code: string): never {
  throw new Error(code)
}

/**
 * Reuse exactly one app-server connection and thread across bounded repair
 * turns. Each turn still passes through the strict #198 request/crop/response
 * validator; only initialize/thread-start are cached by this session boundary.
 */
export async function createLocalCodexRefinementSession(input: {
  config: LocalCodexReconciliationClientConfig
  documentId: string
  runId: string
  maxTurns?: number
}): Promise<LocalCodexRefinementSession> {
  const sessionSha256 = hashTraceValue({
    schemaVersion: LOCAL_CODEX_REFINEMENT_SESSION_SCHEMA_VERSION,
    documentId: input.documentId,
    runId: input.runId,
  })
  const endpoint = validateLocalCodexEndpoint(input.config.endpoint)
  const raw = await Promise.resolve(
    input.config.transportFactory(endpoint, sessionSha256),
  )
  if (!raw || typeof raw !== 'object') {
    invalid('LOCAL_CODEX_REFINEMENT_SESSION_OPEN_FAILED')
  }
  let initialize: Promise<unknown> | undefined
  let thread: Promise<unknown> | undefined
  let closed = false
  let initialized = false
  let nextId = 1
  let turnCount = 0
  const maxTurns = input.maxTurns ?? 3
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 3) {
    invalid('LOCAL_CODEX_REFINEMENT_SESSION_INVALID_TURN_LIMIT')
  }
  const requests = new Map<string, CachedRequest>()
  const proxy: LocalCodexJsonRpcTransport = {
    get endpoint() {
      return raw.endpoint
    },
    get redirected() {
      return raw.redirected
    },
    get finalEndpoint() {
      return raw.finalEndpoint
    },
    request(message, options) {
      if (closed) {
        return Promise.reject(
          new Error('LOCAL_CODEX_REFINEMENT_SESSION_CLOSED'),
        )
      }
      const forwarded: LocalCodexJsonRpcRequest = {
        ...message,
        id: nextId,
      }
      nextId += 1
      if (message.method === 'initialize') {
        initialize ??= Promise.resolve(raw.request(forwarded, options))
        return initialize
      }
      if (message.method === 'thread/start') {
        thread ??= Promise.resolve(raw.request(forwarded, options))
        return thread
      }
      return raw.request(forwarded, options)
    },
    notify(message, options) {
      if (closed) {
        return Promise.reject(
          new Error('LOCAL_CODEX_REFINEMENT_SESSION_CLOSED'),
        )
      }
      if (message.method === 'initialized') {
        if (initialized) return
        initialized = true
      }
      const forwarded: LocalCodexJsonRpcNotification = {
        method: message.method,
        params: message.params,
      }
      return raw.notify(forwarded, options)
    },
    nextMessage(options) {
      if (closed) {
        return Promise.reject(
          new Error('LOCAL_CODEX_REFINEMENT_SESSION_CLOSED'),
        )
      }
      return raw.nextMessage(options)
    },
    close() {
      // Per-turn clients must not close the one owner-local task. The explicit
      // session close below owns the real transport lifecycle.
    },
  }

  const reconcile = (
    request: LocalCodexReconciliationRequest,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ) => {
    if (closed) {
      return Promise.reject(new Error('LOCAL_CODEX_REFINEMENT_SESSION_CLOSED'))
    }
    if (request.documentId !== input.documentId) {
      return Promise.reject(
        new Error('LOCAL_CODEX_REFINEMENT_SESSION_DOCUMENT_MISMATCH'),
      )
    }
    const key = `${request.documentId}\0${request.attemptId}`
    const fingerprint = hashTraceValue(request)
    const existing = requests.get(key)
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(
            new Error('LOCAL_CODEX_REFINEMENT_SESSION_IDEMPOTENCY_CONFLICT'),
          )
    }
    if (turnCount >= maxTurns) {
      return Promise.reject(
        new Error('LOCAL_CODEX_REFINEMENT_SESSION_TURN_LIMIT_EXHAUSTED'),
      )
    }
    const client = createLocalCodexReconciliationClient({
      ...input.config,
      transportFactory: () => proxy,
    })
    const promise = client.reconcile(request, options)
    turnCount += 1
    requests.set(key, { fingerprint, promise })
    return promise
  }

  return {
    schemaVersion: LOCAL_CODEX_REFINEMENT_SESSION_SCHEMA_VERSION,
    sessionSha256,
    reconcile,
    close: async () => {
      if (closed) return
      closed = true
      await Promise.resolve(raw.close?.())
    },
  }
}
