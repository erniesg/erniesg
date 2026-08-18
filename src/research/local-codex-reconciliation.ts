import { createHash, randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { posix } from 'node:path'
import sharp from 'sharp'
import {
  hashTraceValue,
  parseReconstructionAttemptTrace,
  type ReconstructionAttemptTrace,
} from './reconstruction-attempt-trace'
import {
  PDF_EVIDENCE_OBSERVATION_CATEGORIES,
  readSourceEvidenceGraph,
  sourceEvidenceGraphSha256,
  type SourceEvidenceGraph,
} from './source-evidence-graph'

const RECEIPT_SCHEMA_VERSION = '1.0.0'
const RESPONSE_SCHEMA_VERSION = '1.0.0'
const SHA256 = /^[a-f0-9]{64}$/u
const API_KEY_FIELD =
  /(?:api.?key|access.?token|refresh.?token|authorization|bearer|credential|password|secret|cookie)/iu
const REDIRECT_FIELD = /redirect/iu
const API_KEY_VALUE = /(?:\bBearer\s+\S+|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,})/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const MAX_ID_LENGTH = 512
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_INTERRUPT_TIMEOUT_MS = 1_000
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_AGENT_RESPONSE_BYTES = 1024 * 1024
const MAX_TRACE_DECISIONS = 32
const MAX_TRACE_CANDIDATES = 128
const MAX_TRACE_SNIPPET_BYTES = 8 * 1024
const MAX_CROP_COUNT = 8
const MAX_CROP_BYTES = 512 * 1024
const MAX_CROP_AREA = 0.25
const MAX_SOCKET_MESSAGE_BYTES = 2 * 1024 * 1024
const PRIVATE_PAYLOAD_FIELD =
  /(?:path|file(?:name)?|directory|folder|uri|base64|bytes|credential|secret|token|password|cookie)/iu

const REDACTED_NOTIFICATION_METHODS = Object.freeze([
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'turn/diff/updated',
  'turn/plan/updated',
  'thread/tokenUsage/updated',
])

type JsonPrimitive = string | number | boolean | null
export type LocalCodexJsonValue =
  | JsonPrimitive
  | readonly LocalCodexJsonValue[]
  | { readonly [key: string]: LocalCodexJsonValue }

export type LocalCodexEndpoint = Readonly<{
  kind: 'loopback-websocket' | 'unix-socket'
  canonical: string
}>

export type LocalCodexJsonRpcRequest = Readonly<{
  id: number
  method: string
  params?: Readonly<Record<string, unknown>>
}>

export type LocalCodexJsonRpcNotification = Readonly<{
  method: string
  params: Readonly<Record<string, unknown>>
}>

export interface LocalCodexJsonRpcTransport {
  /** The endpoint actually used for the connection. */
  readonly endpoint: string
  /** A transport must never follow an HTTP/WebSocket redirect. */
  readonly redirected?: boolean
  readonly finalEndpoint?: string
  request(
    message: LocalCodexJsonRpcRequest,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<unknown>
  notify(
    message: LocalCodexJsonRpcNotification,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<void> | void
  nextMessage(options: Readonly<{ signal: AbortSignal }>): Promise<unknown>
  close?(): Promise<void> | void
}

export type LocalCodexTransportFactory = (
  endpoint: LocalCodexEndpoint,
  isolatedSessionSha256: string,
) => LocalCodexJsonRpcTransport | Promise<LocalCodexJsonRpcTransport>

export type LocalCodexToolIdentity = Readonly<{
  id: string
  version: string
  executableSha256?: string
}>

export type LocalCodexModelIdentity = Readonly<{
  providerId: string
  modelId: string
  modelVersion: string
  modelDigest?: string
  reasoningEffort?: string
}>

export type LocalCodexPromptIdentity = Readonly<{
  id: string
  version: string
  instructions: string
}>

export type LocalCodexReconciliationClientConfig = Readonly<{
  endpoint: string
  transportFactory: LocalCodexTransportFactory
  timeoutMs?: number
  interruptTimeoutMs?: number
  maxRequestBytes?: number
  expectedServerIdentitySha256?: string
  clientIdentity?: Readonly<{
    name: string
    title: string
    version: string
  }>
  toolIdentity: LocalCodexToolIdentity
  modelIdentity: LocalCodexModelIdentity
  promptIdentity: LocalCodexPromptIdentity
  renderArtifactResolver: LocalCodexRenderArtifactResolver
}>

export type LocalCodexRenderArtifactResolver = Readonly<{
  identity: Readonly<{
    id: string
    version: string
    configurationSha256: string
  }>
  resolve: (
    request: Readonly<{
      traceSha256: string
      kind: 'source-page-render' | 'epub-screenshot'
      logicalId: string
      artifact: Readonly<{ sha256: string; byteLength: number }>
    }>,
  ) => unknown | Promise<unknown>
}>

export type LocalCodexDecisionPoint = Readonly<{
  decisionId: string
  candidateIds: readonly string[]
}>

export type LocalCodexPriorComparisonEvidence = Readonly<{
  schemaVersion: '1.0.0'
  status: 'failed'
  sourcePdfSha256: string
  structSha256: string
  epubSha256: string
  renderReceiptSha256: string
  comparatorReceiptSha256: string
  failures: readonly Readonly<{
    idSha256: string
    check: import('./source-evidence-graph').PdfEvidenceObservationCategory
    sourceRegionIds: readonly string[]
    expectedSha256: string
    actualSha256: string
  }>[]
}>

export type LocalCodexRenderProvenance =
  | Readonly<{
      kind: 'source-pdf'
      sourcePdfSha256: string
      sourcePageRenderSha256: string
      failureId: string
    }>
  | Readonly<{
      kind: 'rendered-epub'
      epubSha256: string
      renderReceiptSha256: string
      spineHref: string
      anchorId: string
      domSha256: string
      screenshotSha256: string
      screenshotId: string
      failureId: string
    }>

export type LocalCodexRenderEvidence = Readonly<{
  id: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  dataBase64: string
  sha256: string
  page: number
  box: Readonly<{ x: number; y: number; width: number; height: number }>
  candidateIds: readonly string[]
  provenance: LocalCodexRenderProvenance
}>

export type LocalCodexReconciliationRequest = Readonly<{
  documentId: string
  attemptId: string
  evidenceGraph: SourceEvidenceGraph
  graphSha256: string
  candidateSetSha256: string
  decisions: readonly LocalCodexDecisionPoint[]
  comparisonEvidence: ReconstructionAttemptTrace
  renders: readonly LocalCodexRenderEvidence[]
}>

export type LocalCodexReconciliationSelection =
  | Readonly<{ decisionId: string; candidateId: string }>
  | Readonly<{ decisionId: string; abstain: true }>

export type LocalCodexReconciliationReceipt = Readonly<{
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION
  status: 'accepted'
  documentIdSha256: string
  attemptIdSha256: string
  isolatedSessionSha256: string
  graphSha256: string
  candidateSetSha256: string
  requestSha256: string
  responseSha256: string
  selectionSetSha256: string
  comparisonEvidenceSha256: string
  cropEvidenceSha256: string
  threadSha256: string
  turnSha256: string
  identities: Readonly<{
    endpointSha256: string
    serverSha256: string
    toolSha256: string
    modelSha256: string
    promptSha256: string
    renderArtifactResolverSha256: string
    observedModelSha256: string
  }>
  counts: Readonly<{
    decisionCount: number
    candidateCount: number
    renderCount: number
    sourceCropCount: number
    epubCropCount: number
  }>
}>

export type LocalCodexReconciliationResult = Readonly<{
  selections: readonly LocalCodexReconciliationSelection[]
  receipt: LocalCodexReconciliationReceipt
}>

type PreparedRequest = Readonly<{
  request: LocalCodexReconciliationRequest
  decisions: readonly LocalCodexDecisionPoint[]
  candidateIds: readonly string[]
  renders: readonly LocalCodexRenderEvidence[]
  comparisonEvidence: LocalCodexPriorComparisonEvidence
  priorTrace: ReconstructionAttemptTrace
  traceBundle: LocalCodexJsonValue
  isolatedSessionSha256: string
  requestSha256: string
  fingerprint: string
}>

type AttemptEntry = Readonly<{
  fingerprint: string
  promise: Promise<LocalCodexReconciliationResult>
}>

type Deadline = Readonly<{
  signal: AbortSignal
  reason: () => 'timeout' | 'aborted' | null
  dispose: () => void
}>

export class LocalCodexReconciliationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'LocalCodexReconciliationError'
    this.code = code
  }
}

function invalid(code: string): never {
  throw new LocalCodexReconciliationError(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function boundedId(value: unknown, code: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    invalid(code)
  }
  return value
}

function digest(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('LOCAL_CODEX_NON_CANONICAL_VALUE')
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object') invalid('LOCAL_CODEX_NON_CANONICAL_VALUE')
  if (seen.has(value)) invalid('LOCAL_CODEX_NON_CANONICAL_VALUE')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalid('LOCAL_CODEX_NON_CANONICAL_VALUE')
    }
    const typed = value as Record<string, unknown>
    return `{${Object.keys(typed)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(typed[key], seen)}`)
      .join(',')}}`
  } finally {
    seen.delete(value)
  }
}

function canonicalSha256(value: unknown) {
  return digest(canonicalJson(value))
}

function sha256(value: unknown, code: string) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(code)
  return value
}

function finiteInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
) {
  const resolved = value === undefined ? fallback : value
  if (
    typeof resolved !== 'number' ||
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    invalid(code)
  }
  return resolved
}

function assertSafeConfiguration(value: unknown, path = 'config') {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (API_KEY_VALUE.test(value)) invalid('LOCAL_CODEX_API_KEY_FORBIDDEN')
    return
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'function'
  ) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeConfiguration(item, `${path}[${index}]`),
    )
    return
  }
  if (!record(value)) invalid('LOCAL_CODEX_INVALID_CONFIGURATION')
  for (const [key, item] of Object.entries(value)) {
    if (API_KEY_FIELD.test(key)) invalid('LOCAL_CODEX_API_KEY_FORBIDDEN')
    if (REDIRECT_FIELD.test(key)) invalid('LOCAL_CODEX_REDIRECT_FORBIDDEN')
    assertSafeConfiguration(item, `${path}.${key}`)
  }
}

function unixEndpoint(endpoint: string): LocalCodexEndpoint {
  if (!endpoint.startsWith('unix:///'))
    invalid('LOCAL_CODEX_ENDPOINT_FORBIDDEN')
  const path = endpoint.slice('unix://'.length)
  if (
    path.length <= 1 ||
    path.startsWith('//') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('%') ||
    path.includes('\\') ||
    CONTROL_CHARACTER.test(path) ||
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path
  ) {
    invalid('LOCAL_CODEX_ENDPOINT_FORBIDDEN')
  }
  return Object.freeze({ kind: 'unix-socket', canonical: `unix://${path}` })
}

export function validateLocalCodexEndpoint(
  endpoint: unknown,
): LocalCodexEndpoint {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.length > 4096 ||
    CONTROL_CHARACTER.test(endpoint) ||
    endpoint.includes('\\')
  ) {
    invalid('LOCAL_CODEX_ENDPOINT_FORBIDDEN')
  }
  if (endpoint.startsWith('unix:')) return unixEndpoint(endpoint)

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    invalid('LOCAL_CODEX_ENDPOINT_FORBIDDEN')
  }
  if (
    parsed.protocol !== 'ws:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    invalid('LOCAL_CODEX_ENDPOINT_FORBIDDEN')
  }
  const hostname = parsed.hostname.toLowerCase()
  const ipv4 = hostname.match(
    /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/u,
  )
  const loopbackIpv4 =
    ipv4 !== null &&
    ipv4.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255)
  if (
    !loopbackIpv4 &&
    hostname !== '[::1]' &&
    hostname !== '::1' &&
    hostname !== 'localhost'
  ) {
    invalid('LOCAL_CODEX_ENDPOINT_FORBIDDEN')
  }
  return Object.freeze({
    kind: 'loopback-websocket',
    canonical: parsed.href,
  })
}

export const parseLocalCodexEndpoint = validateLocalCodexEndpoint

type PendingSocketRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  signal: AbortSignal
  abort: () => void
}

type PendingSocketMessage = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  signal: AbortSignal
  abort: () => void
}

class OwnerLocalUnixSocketTransport implements LocalCodexJsonRpcTransport {
  readonly endpoint: string
  private readonly socket: Socket
  private readonly pendingRequests = new Map<number, PendingSocketRequest>()
  private readonly messages: unknown[] = []
  private readonly messageWaiters: PendingSocketMessage[] = []
  private buffered = Buffer.alloc(0)
  private fragmented = Buffer.alloc(0)
  private fragmentedOpcode: number | null = null
  private stopped: Error | null = null

  constructor(endpoint: string, socket: Socket, initialData: Buffer) {
    this.endpoint = endpoint
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.once('error', (error) => this.stop(error))
    socket.once('close', () =>
      this.stop(new Error('LOCAL_CODEX_UNIX_SOCKET_CLOSED')),
    )
    if (initialData.byteLength > 0) this.receive(initialData)
  }

  private stop(error: Error) {
    if (this.stopped) return
    this.stopped = error
    for (const pending of this.pendingRequests.values()) {
      pending.signal.removeEventListener('abort', pending.abort)
      pending.reject(error)
    }
    this.pendingRequests.clear()
    for (const waiter of this.messageWaiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(error)
    }
  }

  private invalidFrame(message: string) {
    this.socket.destroy(new Error(message))
  }

  private receive(chunk: Buffer) {
    if (this.stopped) return
    this.buffered = Buffer.concat([this.buffered, chunk])
    if (this.buffered.byteLength > MAX_SOCKET_MESSAGE_BYTES * 2 + 16) {
      this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_MESSAGE_TOO_LARGE')
      return
    }
    for (;;) {
      if (this.buffered.byteLength < 2) return
      const first = this.buffered[0]!
      const second = this.buffered[1]!
      const final = (first & 0x80) !== 0
      const opcode = first & 0x0f
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
        this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_WEBSOCKET_FRAME')
        return
      }
      let headerLength = 2
      let payloadLength = second & 0x7f
      if (payloadLength === 126) {
        if (this.buffered.byteLength < 4) return
        payloadLength = this.buffered.readUInt16BE(2)
        headerLength = 4
      } else if (payloadLength === 127) {
        if (this.buffered.byteLength < 10) return
        const wideLength = this.buffered.readBigUInt64BE(2)
        if (wideLength > BigInt(MAX_SOCKET_MESSAGE_BYTES)) {
          this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_MESSAGE_TOO_LARGE')
          return
        }
        payloadLength = Number(wideLength)
        headerLength = 10
      }
      if (payloadLength > MAX_SOCKET_MESSAGE_BYTES) {
        this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_MESSAGE_TOO_LARGE')
        return
      }
      if (this.buffered.byteLength < headerLength + payloadLength) return
      const payload = this.buffered.subarray(
        headerLength,
        headerLength + payloadLength,
      )
      this.buffered = this.buffered.subarray(headerLength + payloadLength)
      if (opcode >= 0x8) {
        if (!final || payloadLength > 125) {
          this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_WEBSOCKET_FRAME')
          return
        }
        if (opcode === 0x8) {
          this.socket.destroy()
          return
        }
        if (opcode === 0x9) {
          this.socket.write(webSocketFrame(payload, 0x0a))
          continue
        }
        if (opcode === 0x0a) continue
        this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_WEBSOCKET_FRAME')
        return
      }
      if (opcode === 0x0) {
        if (this.fragmentedOpcode === null) {
          this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_WEBSOCKET_FRAME')
          return
        }
        this.fragmented = Buffer.concat([this.fragmented, payload])
      } else if (opcode === 0x1) {
        if (this.fragmentedOpcode !== null) {
          this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_WEBSOCKET_FRAME')
          return
        }
        this.fragmentedOpcode = opcode
        this.fragmented = Buffer.from(payload)
      } else {
        this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_WEBSOCKET_FRAME')
        return
      }
      if (this.fragmented.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
        this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_MESSAGE_TOO_LARGE')
        return
      }
      if (!final) continue
      const encoded = this.fragmented
      this.fragmented = Buffer.alloc(0)
      this.fragmentedOpcode = null
      let message: unknown
      try {
        message = JSON.parse(encoded.toString('utf8'))
      } catch {
        this.invalidFrame('LOCAL_CODEX_UNIX_SOCKET_INVALID_JSON')
        return
      }
      if (
        record(message) &&
        typeof message.id === 'number' &&
        Number.isSafeInteger(message.id) &&
        !Object.hasOwn(message, 'method')
      ) {
        const pending = this.pendingRequests.get(message.id)
        if (pending) {
          this.pendingRequests.delete(message.id)
          pending.signal.removeEventListener('abort', pending.abort)
          pending.resolve(message)
          continue
        }
      }
      const waiter = this.messageWaiters.shift()
      if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.abort)
        waiter.resolve(message)
      } else {
        this.messages.push(message)
      }
    }
  }

  private send(message: unknown, signal: AbortSignal) {
    if (this.stopped) return Promise.reject(this.stopped)
    if (signal.aborted)
      return Promise.reject(new Error('LOCAL_CODEX_ABORT_SIGNAL'))
    const encoded = Buffer.from(canonicalJson(message), 'utf8')
    if (encoded.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
      return Promise.reject(
        new Error('LOCAL_CODEX_UNIX_SOCKET_MESSAGE_TOO_LARGE'),
      )
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error('LOCAL_CODEX_ABORT_SIGNAL'))
      signal.addEventListener('abort', abort, { once: true })
      this.socket.write(webSocketFrame(encoded), (error) => {
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async request(
    message: LocalCodexJsonRpcRequest,
    { signal }: Readonly<{ signal: AbortSignal }>,
  ) {
    if (this.pendingRequests.has(message.id)) {
      throw new Error('LOCAL_CODEX_UNIX_SOCKET_DUPLICATE_REQUEST_ID')
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.pendingRequests.delete(message.id)
        reject(new Error('LOCAL_CODEX_ABORT_SIGNAL'))
      }
      const pending = { resolve, reject, signal, abort }
      this.pendingRequests.set(message.id, pending)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    try {
      await this.send(message, signal)
    } catch (error) {
      const pending = this.pendingRequests.get(message.id)
      if (pending) {
        this.pendingRequests.delete(message.id)
        pending.signal.removeEventListener('abort', pending.abort)
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
    return response
  }

  notify(
    message: LocalCodexJsonRpcNotification,
    { signal }: Readonly<{ signal: AbortSignal }>,
  ) {
    return this.send(message, signal)
  }

  nextMessage({ signal }: Readonly<{ signal: AbortSignal }>) {
    if (this.messages.length > 0) {
      return Promise.resolve(this.messages.shift())
    }
    if (this.stopped) return Promise.reject(this.stopped)
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        const index = this.messageWaiters.indexOf(waiter)
        if (index >= 0) this.messageWaiters.splice(index, 1)
        reject(new Error('LOCAL_CODEX_ABORT_SIGNAL'))
      }
      const waiter = { resolve, reject, signal, abort }
      this.messageWaiters.push(waiter)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }

  close() {
    this.socket.destroy()
  }
}

function webSocketFrame(payload: Buffer, opcode = 0x01) {
  const mask = randomBytes(4)
  const extendedLength =
    payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8
  const header = Buffer.alloc(2 + extendedLength + mask.byteLength)
  header[0] = 0x80 | opcode
  if (extendedLength === 0) header[1] = 0x80 | payload.byteLength
  else if (extendedLength === 2) {
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.byteLength, 2)
  } else {
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2)
  }
  mask.copy(header, 2 + extendedLength)
  const masked = Buffer.alloc(payload.byteLength)
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!
  }
  return Buffer.concat([header, masked])
}

async function upgradeOwnerLocalWebSocket(socket: Socket) {
  const key = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  const request = [
    'GET / HTTP/1.1',
    'Host: localhost',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n')
  return new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(
      () => fail(new Error('LOCAL_CODEX_UNIX_SOCKET_UPGRADE_TIMEOUT')),
      5_000,
    )
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', fail)
      socket.off('close', closed)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const closed = () =>
      fail(new Error('LOCAL_CODEX_UNIX_SOCKET_UPGRADE_CLOSED'))
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.byteLength > 16 * 1024) {
        fail(new Error('LOCAL_CODEX_UNIX_SOCKET_INVALID_UPGRADE'))
        return
      }
      const boundary = buffered.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const header = buffered.subarray(0, boundary).toString('ascii')
      const lines = header.split('\r\n')
      const responseHeaders = new Map<string, string>()
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(':')
        if (separator <= 0) {
          fail(new Error('LOCAL_CODEX_UNIX_SOCKET_INVALID_UPGRADE'))
          return
        }
        responseHeaders.set(
          line.slice(0, separator).trim().toLowerCase(),
          line.slice(separator + 1).trim(),
        )
      }
      if (
        lines[0] !== 'HTTP/1.1 101 Switching Protocols' ||
        responseHeaders.get('upgrade')?.toLowerCase() !== 'websocket' ||
        !responseHeaders
          .get('connection')
          ?.toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .includes('upgrade') ||
        responseHeaders.get('sec-websocket-accept') !== expectedAccept ||
        responseHeaders.has('location') ||
        responseHeaders.has('sec-websocket-extensions') ||
        responseHeaders.has('sec-websocket-protocol')
      ) {
        fail(new Error('LOCAL_CODEX_UNIX_SOCKET_INVALID_UPGRADE'))
        return
      }
      cleanup()
      resolve(buffered.subarray(boundary + 4))
    }
    socket.on('data', onData)
    socket.once('error', fail)
    socket.once('close', closed)
    socket.write(request, 'ascii', (error) => {
      if (error) fail(error)
    })
  })
}

function sameSocketIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
) {
  return (
    Number(left.dev) === Number(right.dev) &&
    Number(left.ino) === Number(right.ino) &&
    left.isSocket() &&
    right.isSocket()
  )
}

/** Connects only to a stable, owner-only Unix socket; no network fallback. */
export const createOwnerLocalUnixSocketTransport: LocalCodexTransportFactory =
  async (endpoint) => {
    if (endpoint.kind !== 'unix-socket') {
      invalid('LOCAL_CODEX_UNIX_SOCKET_REQUIRED')
    }
    const path = endpoint.canonical.slice('unix://'.length)
    const before = await lstat(path)
    const ownerId = process.getuid?.()
    if (
      !before.isSocket() ||
      ownerId === undefined ||
      Number(before.uid) !== ownerId ||
      (Number(before.mode) & 0o077) !== 0
    ) {
      invalid('LOCAL_CODEX_UNIX_SOCKET_NOT_OWNER_ONLY')
    }
    const socket = createConnection({ path })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      const after = await lstat(path)
      if (!sameSocketIdentity(before, after)) {
        socket.destroy()
        invalid('LOCAL_CODEX_UNIX_SOCKET_IDENTITY_CHANGED')
      }
      const initialData = await upgradeOwnerLocalWebSocket(socket)
      return new OwnerLocalUnixSocketTransport(
        endpoint.canonical,
        socket,
        initialData,
      )
    } catch (error) {
      socket.destroy()
      throw error
    }
  }

function normalizeIdentity(config: LocalCodexReconciliationClientConfig) {
  const tool = {
    id: boundedId(config.toolIdentity?.id, 'LOCAL_CODEX_INVALID_TOOL_IDENTITY'),
    version: boundedId(
      config.toolIdentity?.version,
      'LOCAL_CODEX_INVALID_TOOL_IDENTITY',
    ),
    ...(config.toolIdentity?.executableSha256 === undefined
      ? {}
      : {
          executableSha256: sha256(
            config.toolIdentity.executableSha256,
            'LOCAL_CODEX_INVALID_TOOL_IDENTITY',
          ),
        }),
  }
  const model = {
    providerId: boundedId(
      config.modelIdentity?.providerId,
      'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
    ),
    modelId: boundedId(
      config.modelIdentity?.modelId,
      'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
    ),
    modelVersion: boundedId(
      config.modelIdentity?.modelVersion,
      'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
    ),
    ...(config.modelIdentity?.modelDigest === undefined
      ? {}
      : {
          modelDigest: sha256(
            config.modelIdentity.modelDigest,
            'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
          ),
        }),
    ...(config.modelIdentity?.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: boundedId(
            config.modelIdentity.reasoningEffort,
            'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
          ),
        }),
  }
  const prompt = {
    id: boundedId(
      config.promptIdentity?.id,
      'LOCAL_CODEX_INVALID_PROMPT_IDENTITY',
    ),
    version: boundedId(
      config.promptIdentity?.version,
      'LOCAL_CODEX_INVALID_PROMPT_IDENTITY',
    ),
    instructions: config.promptIdentity?.instructions,
  }
  if (
    typeof prompt.instructions !== 'string' ||
    prompt.instructions.length === 0 ||
    prompt.instructions.length > 64 * 1024 ||
    CONTROL_CHARACTER.test(prompt.instructions.replace(/[\n\r\t]/gu, ''))
  ) {
    invalid('LOCAL_CODEX_INVALID_PROMPT_IDENTITY')
  }
  return Object.freeze({ tool, model, prompt })
}

function normalizeClientIdentity(
  value: LocalCodexReconciliationClientConfig['clientIdentity'],
) {
  const identity = value ?? {
    name: 'erniesg_struct_reconciliation',
    title: 'Ernie SG STRUCT Reconciliation',
    version: RECEIPT_SCHEMA_VERSION,
  }
  return Object.freeze({
    name: boundedId(identity.name, 'LOCAL_CODEX_INVALID_CLIENT_IDENTITY'),
    title: boundedId(identity.title, 'LOCAL_CODEX_INVALID_CLIENT_IDENTITY'),
    version: boundedId(identity.version, 'LOCAL_CODEX_INVALID_CLIENT_IDENTITY'),
  })
}

const DROP_PRIVATE_VALUE = Symbol('drop-private-value')

function boundedEvidencePayload(
  value: unknown,
  key = '',
  depth = 0,
): LocalCodexJsonValue | typeof DROP_PRIVATE_VALUE {
  if (PRIVATE_PAYLOAD_FIELD.test(key)) return DROP_PRIVATE_VALUE
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('LOCAL_CODEX_INVALID_TRACE_EVIDENCE')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'string') {
    if (
      value.length > MAX_TRACE_SNIPPET_BYTES ||
      API_KEY_VALUE.test(value) ||
      /^(?:file:\/\/|\/|[A-Za-z]:[\\/])/u.test(value)
    ) {
      return DROP_PRIVATE_VALUE
    }
    return value
  }
  if (depth >= 8 || typeof value !== 'object' || value === undefined) {
    invalid('LOCAL_CODEX_INVALID_TRACE_EVIDENCE')
  }
  if (Array.isArray(value)) {
    if (value.length > 64) invalid('LOCAL_CODEX_INVALID_TRACE_EVIDENCE')
    return value
      .map((item) => boundedEvidencePayload(item, key, depth + 1))
      .filter(
        (item): item is LocalCodexJsonValue => item !== DROP_PRIVATE_VALUE,
      )
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('LOCAL_CODEX_INVALID_TRACE_EVIDENCE')
  }
  const result: Record<string, LocalCodexJsonValue> = {}
  for (const ownKey of Object.keys(value as Record<string, unknown>).sort()) {
    if (PRIVATE_PAYLOAD_FIELD.test(ownKey)) continue
    const item = boundedEvidencePayload(
      (value as Record<string, unknown>)[ownKey],
      ownKey,
      depth + 1,
    )
    if (item !== DROP_PRIVATE_VALUE) result[ownKey] = item
  }
  return result
}

function evidencePayload(value: unknown): LocalCodexJsonValue {
  const projected = boundedEvidencePayload(value)
  return projected === DROP_PRIVATE_VALUE ? null : projected
}

function normalizedCropBox(value: unknown) {
  if (!record(value) || !exactKeys(value, ['x', 'y', 'width', 'height'])) {
    invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  }
  const numbers = ['x', 'y', 'width', 'height'].map((key) => value[key])
  if (
    numbers.some((item) => typeof item !== 'number' || !Number.isFinite(item))
  ) {
    invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  }
  const [x, y, width, height] = numbers as number[]
  if (
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1 ||
    y + height > 1 ||
    width * height > MAX_CROP_AREA
  ) {
    invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  }
  return Object.freeze({ x, y, width, height })
}

function normalizeComparisonEvidence(
  value: unknown,
): ReconstructionAttemptTrace {
  let trace: ReconstructionAttemptTrace
  try {
    trace = parseReconstructionAttemptTrace(value)
  } catch {
    invalid('LOCAL_CODEX_INVALID_COMPARISON_EVIDENCE')
  }
  if (
    trace.terminalState !== 'failed' ||
    trace.comparator.status !== 'failed' ||
    trace.comparator.failures.length === 0 ||
    trace.comparator.failures.length > 32
  ) {
    invalid('LOCAL_CODEX_INVALID_COMPARISON_EVIDENCE')
  }
  return trace
}

function comparisonProjection(
  trace: ReconstructionAttemptTrace,
): LocalCodexPriorComparisonEvidence {
  const categories = new Set<string>(PDF_EVIDENCE_OBSERVATION_CATEGORIES)
  const failures = trace.comparator.failures.map((failure) => {
    const checkResult = trace.comparator.checkResults.find(
      (result) => result.failureId === failure.id,
    )
    if (
      !categories.has(failure.check) ||
      !failure.source ||
      failure.source.sourceRegionIds.length === 0 ||
      !checkResult ||
      checkResult.status !== 'failed'
    ) {
      invalid('LOCAL_CODEX_INVALID_COMPARISON_EVIDENCE')
    }
    return Object.freeze({
      idSha256: digest(failure.id),
      check:
        failure.check as LocalCodexPriorComparisonEvidence['failures'][number]['check'],
      sourceRegionIds: Object.freeze([...failure.source.sourceRegionIds]),
      expectedSha256: checkResult.expectedSha256,
      actualSha256: checkResult.actualSha256,
    })
  })
  return Object.freeze({
    schemaVersion: '1.0.0',
    status: 'failed',
    sourcePdfSha256: trace.evidenceGraph.sourcePdfSha256,
    structSha256: trace.structure.artifact.sha256,
    epubSha256: trace.epub.bytes.sha256,
    renderReceiptSha256: trace.renderedEpub.receiptSha256,
    comparatorReceiptSha256: hashTraceValue(trace.comparator),
    failures: Object.freeze(failures),
  })
}

function normalizeRenderProvenance(
  value: unknown,
): LocalCodexRenderProvenance {
  if (!record(value) || typeof value.kind !== 'string') {
    invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  }
  if (
    value.kind === 'source-pdf' &&
    exactKeys(value, [
      'kind',
      'sourcePdfSha256',
      'sourcePageRenderSha256',
      'failureId',
    ])
  ) {
    return Object.freeze({
      kind: 'source-pdf',
      sourcePdfSha256: sha256(
        value.sourcePdfSha256,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      sourcePageRenderSha256: sha256(
        value.sourcePageRenderSha256,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      failureId: boundedId(
        value.failureId,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
    })
  }
  if (
    value.kind === 'rendered-epub' &&
    exactKeys(value, [
      'kind',
      'epubSha256',
      'renderReceiptSha256',
      'spineHref',
      'anchorId',
      'domSha256',
      'screenshotSha256',
      'screenshotId',
      'failureId',
    ])
  ) {
    return Object.freeze({
      kind: 'rendered-epub',
      epubSha256: sha256(
        value.epubSha256,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      renderReceiptSha256: sha256(
        value.renderReceiptSha256,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      spineHref: boundedId(
        value.spineHref,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      anchorId: boundedId(
        value.anchorId,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      domSha256: sha256(
        value.domSha256,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      screenshotSha256: sha256(
        value.screenshotSha256,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      screenshotId: boundedId(
        value.screenshotId,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
      failureId: boundedId(
        value.failureId,
        'LOCAL_CODEX_INVALID_RENDER_EVIDENCE',
      ),
    })
  }
  invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
}

function normalizeRenders(value: unknown): readonly LocalCodexRenderEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_CROP_COUNT) {
    invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  }
  const ids = new Set<string>()
  const renders = value.map((item) => {
    if (
      !record(item) ||
      !exactKeys(item, [
        'id',
        'mimeType',
        'dataBase64',
        'sha256',
        'page',
        'box',
        'candidateIds',
        'provenance',
      ])
    ) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    const id = boundedId(item.id, 'LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    if (ids.has(id)) invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    ids.add(id)
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(String(item.mimeType))
    ) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    if (
      typeof item.dataBase64 !== 'string' ||
      item.dataBase64.length === 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(item.dataBase64)
    ) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    const bytes = Buffer.from(item.dataBase64, 'base64')
    if (
      bytes.length === 0 ||
      bytes.length > MAX_CROP_BYTES ||
      bytes.toString('base64') !== item.dataBase64 ||
      digest(bytes) !== item.sha256
    ) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    if (!Number.isSafeInteger(item.page) || (item.page as number) < 1) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    if (!Array.isArray(item.candidateIds) || item.candidateIds.length === 0) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    const candidateIds = item.candidateIds.map((candidateId) =>
      boundedId(candidateId, 'LOCAL_CODEX_INVALID_RENDER_EVIDENCE'),
    )
    if (new Set(candidateIds).size !== candidateIds.length) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    return Object.freeze({
      id,
      mimeType: item.mimeType as LocalCodexRenderEvidence['mimeType'],
      dataBase64: item.dataBase64,
      sha256: item.sha256,
      page: item.page as number,
      box: normalizedCropBox(item.box),
      candidateIds: Object.freeze(candidateIds),
      provenance: normalizeRenderProvenance(item.provenance),
    })
  })
  return Object.freeze(renders)
}

function normalizedResolver(
  value: LocalCodexRenderArtifactResolver | undefined,
) {
  if (
    !record(value) ||
    !record(value.identity) ||
    !exactKeys(value.identity, ['id', 'version', 'configurationSha256']) ||
    typeof value.resolve !== 'function'
  ) {
    invalid('LOCAL_CODEX_RENDER_ARTIFACT_RESOLVER_REQUIRED')
  }
  return Object.freeze({
    authority: value,
    identity: Object.freeze({
      id: boundedId(
        value.identity.id,
        'LOCAL_CODEX_RENDER_ARTIFACT_RESOLVER_REQUIRED',
      ),
      version: boundedId(
        value.identity.version,
        'LOCAL_CODEX_RENDER_ARTIFACT_RESOLVER_REQUIRED',
      ),
      configurationSha256: sha256(
        value.identity.configurationSha256,
        'LOCAL_CODEX_RENDER_ARTIFACT_RESOLVER_REQUIRED',
      ),
    }),
  })
}

function sameCropBox(
  left: LocalCodexRenderEvidence['box'],
  right: { x: number; y: number; width: number; height: number },
) {
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(left[key] - right[key]) <= 1e-9,
  )
}

async function encodedCrop(
  bytes: Uint8Array,
  dimensions: { width: number; height: number },
  box: LocalCodexRenderEvidence['box'],
  mimeType: LocalCodexRenderEvidence['mimeType'],
) {
  const left = Math.floor(box.x * dimensions.width + 1e-9)
  const top = Math.floor(box.y * dimensions.height + 1e-9)
  const right = Math.ceil((box.x + box.width) * dimensions.width - 1e-9)
  const bottom = Math.ceil((box.y + box.height) * dimensions.height - 1e-9)
  if (
    left < 0 ||
    top < 0 ||
    right > dimensions.width ||
    bottom > dimensions.height ||
    right <= left ||
    bottom <= top
  ) {
    invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
  }
  let pipeline = sharp(bytes, { failOn: 'error' }).extract({
    left,
    top,
    width: right - left,
    height: bottom - top,
  })
  pipeline =
    mimeType === 'image/png'
      ? pipeline.png()
      : mimeType === 'image/jpeg'
        ? pipeline.jpeg()
        : pipeline.webp()
  return new Uint8Array(await pipeline.toBuffer())
}

async function verifyBoundRenderCrops(
  prepared: PreparedRequest,
  resolver: ReturnType<typeof normalizedResolver>,
) {
  const trace = prepared.priorTrace
  for (const render of prepared.renders) {
    const provenance = render.provenance
    const failure = trace.comparator.failures.find(
      ({ id }) => id === provenance.failureId,
    )
    if (!failure || !failure.source) {
      invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
    }
    let artifact: { sha256: string; byteLength: number }
    let logicalId: string
    let kind: 'source-page-render' | 'epub-screenshot'
    let dimensions: { width: number; height: number }
    if (provenance.kind === 'source-pdf') {
      const page = trace.sourcePdf.pageRenders.find(
        (candidate) => candidate.page === render.page,
      )
      if (
        !page ||
        page.sourcePdfSha256 !== trace.evidenceGraph.sourcePdfSha256 ||
        page.image.sha256 !== provenance.sourcePageRenderSha256 ||
        !failure.source.boxes.some(
          (box) => box.page === render.page && sameCropBox(render.box, box),
        )
      ) {
        invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
      }
      artifact = page.image
      logicalId = `source-page-${page.page}`
      kind = 'source-page-render'
      dimensions = { width: page.width, height: page.height }
    } else {
      const screenshot = trace.renderedEpub.screenshots.find(
        ({ id }) => id === provenance.screenshotId,
      )
      const output = failure.output.find(
        (candidate) =>
          candidate.spineHref === provenance.spineHref &&
          candidate.anchorId === provenance.anchorId &&
          candidate.rendered?.screenshotId === provenance.screenshotId,
      )
      const dom = trace.renderedEpub.domSnapshots.find(
        ({ spineHref }) => spineHref === provenance.spineHref,
      )
      const locator = output?.rendered
      const normalized = locator
        ? {
            x: locator.rect.x / locator.viewport.width,
            y: locator.rect.y / locator.viewport.height,
            width: locator.rect.width / locator.viewport.width,
            height: locator.rect.height / locator.viewport.height,
          }
        : null
      if (
        !screenshot ||
        !output ||
        !dom ||
        !locator ||
        !normalized ||
        !sameCropBox(render.box, normalized) ||
        screenshot.image.sha256 !== provenance.screenshotSha256 ||
        screenshot.domSha256 !== provenance.domSha256 ||
        dom.dom.sha256 !== provenance.domSha256 ||
        !dom.anchors.includes(provenance.anchorId)
      ) {
        invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
      }
      artifact = screenshot.image
      logicalId = screenshot.id
      kind = 'epub-screenshot'
      dimensions = { width: screenshot.width, height: screenshot.height }
    }
    const request = {
      traceSha256: trace.traceSha256,
      kind,
      logicalId,
      artifact,
    } as const
    const resolved = await Promise.resolve(resolver.authority.resolve(request))
    if (
      !(resolved instanceof Uint8Array) ||
      resolved.byteLength !== artifact.byteLength ||
      digest(resolved) !== artifact.sha256
    ) {
      invalid('LOCAL_CODEX_RENDER_ARTIFACT_RESOLUTION_FAILED')
    }
    const expectedCrop = await encodedCrop(
      resolved,
      dimensions,
      render.box,
      render.mimeType,
    )
    if (
      expectedCrop.byteLength === 0 ||
      digest(expectedCrop) !== render.sha256 ||
      Buffer.from(expectedCrop).toString('base64') !== render.dataBase64
    ) {
      invalid('LOCAL_CODEX_RENDER_CROP_MISMATCH')
    }
  }
}

function evidenceTraceBundle(
  reader: ReturnType<typeof readSourceEvidenceGraph>,
  decisions: readonly LocalCodexDecisionPoint[],
): LocalCodexJsonValue {
  const graph = reader.graph
  const traceDecisions = decisions.map((decision) => ({
    decisionId: decision.decisionId,
    candidates: decision.candidateIds.map((candidateId) => {
      const candidate = reader.candidate(candidateId)!
      const sources = candidate.sourceIds.map((sourceId) => {
        const source = reader.sourceItem(sourceId)!
        return {
          idSha256: digest(source.id),
          kind: source.kind,
          ...(source.page === undefined ? {} : { page: source.page }),
          ...(source.box === undefined ? {} : { box: source.box }),
          ...(source.payload === undefined
            ? {}
            : { payload: evidencePayload(source.payload) }),
        }
      })
      const obligations = graph.obligations
        .filter(({ candidateIds }) => candidateIds.includes(candidateId))
        .map(({ id, kind, page, required, semantic }) => ({
          idSha256: digest(id),
          kind,
          ...(page === undefined ? {} : { page }),
          required,
          semantic,
        }))
      const disagreements = graph.disagreements
        .filter(({ candidateIds }) => candidateIds.includes(candidateId))
        .map(({ id, kind, reason }) => ({
          idSha256: digest(id),
          kind,
          reason,
        }))
      const artifacts = (candidate.artifactIds ?? []).map((artifactId) => {
        const artifact = reader.artifact(artifactId)!
        return {
          idSha256: digest(artifact.id),
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          sha256: artifact.sha256,
          ...(artifact.page === undefined ? {} : { page: artifact.page }),
          ...(artifact.box === undefined ? {} : { box: artifact.box }),
        }
      })
      const candidateTrace = {
        candidateId,
        kind: candidate.kind,
        providerIdSha256: digest(candidate.providerId),
        ...(candidate.page === undefined ? {} : { page: candidate.page }),
        boxes: candidate.boxes ?? [],
        ...(candidate.payload === undefined
          ? {}
          : { payload: evidencePayload(candidate.payload) }),
        sources,
        artifacts,
        obligations,
        disagreements,
      }
      if (
        Buffer.byteLength(canonicalJson(candidateTrace)) >
        MAX_TRACE_SNIPPET_BYTES
      ) {
        invalid('LOCAL_CODEX_TRACE_EVIDENCE_TOO_LARGE')
      }
      return candidateTrace
    }),
  }))
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    sourceSha256: reader.source.sha256,
    pageCount: reader.source.pageCount,
    decisions: traceDecisions,
  }
}

function createDeadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController()
  let stoppedBecause: 'timeout' | 'aborted' | null = null
  const abortFromCaller = () => {
    if (stoppedBecause === null) stoppedBecause = 'aborted'
    controller.abort()
  }
  if (external?.aborted) abortFromCaller()
  else external?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    if (stoppedBecause === null) stoppedBecause = 'timeout'
    controller.abort()
  }, timeoutMs)
  return Object.freeze({
    signal: controller.signal,
    reason: () => stoppedBecause,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', abortFromCaller)
    },
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new Error('LOCAL_CODEX_ABORT_SIGNAL'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('LOCAL_CODEX_ABORT_SIGNAL'))
    signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

function unwrapResult(value: unknown) {
  if (!record(value)) return value
  if (Object.hasOwn(value, 'error')) invalid('LOCAL_CODEX_JSON_RPC_ERROR')
  return Object.hasOwn(value, 'result') ? value.result : value
}

function responseSchema(decisions: readonly LocalCodexDecisionPoint[]) {
  return {
    type: 'object',
    properties: {
      schemaVersion: { type: 'string', const: RESPONSE_SCHEMA_VERSION },
      graphSha256: { type: 'string', const: null },
      candidateSetSha256: { type: 'string', const: null },
      decisions: {
        type: 'array',
        minItems: decisions.length,
        maxItems: decisions.length,
        items: {
          anyOf: decisions.map((decision) => ({
            anyOf: [
              {
                type: 'object',
                properties: {
                  decisionId: {
                    type: 'string',
                    const: decision.decisionId,
                  },
                  candidateId: {
                    type: 'string',
                    enum: [...decision.candidateIds],
                  },
                },
                required: ['decisionId', 'candidateId'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  decisionId: {
                    type: 'string',
                    const: decision.decisionId,
                  },
                  abstain: { type: 'boolean', const: true },
                },
                required: ['decisionId', 'abstain'],
                additionalProperties: false,
              },
            ],
          })),
        },
      },
    },
    required: [
      'schemaVersion',
      'graphSha256',
      'candidateSetSha256',
      'decisions',
    ],
    additionalProperties: false,
  }
}

function strictSelections(
  value: unknown,
  prepared: PreparedRequest,
): readonly LocalCodexReconciliationSelection[] {
  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    invalid('LOCAL_CODEX_INVALID_RESPONSE')
  }
  if (
    !record(parsed) ||
    !exactKeys(parsed, [
      'schemaVersion',
      'graphSha256',
      'candidateSetSha256',
      'decisions',
    ]) ||
    parsed.schemaVersion !== RESPONSE_SCHEMA_VERSION ||
    parsed.graphSha256 !== prepared.request.graphSha256 ||
    parsed.candidateSetSha256 !== prepared.request.candidateSetSha256 ||
    !Array.isArray(parsed.decisions) ||
    parsed.decisions.length !== prepared.decisions.length
  ) {
    invalid('LOCAL_CODEX_INVALID_RESPONSE')
  }
  const allowed = new Map(
    prepared.decisions.map((decision) => [
      decision.decisionId,
      new Set(decision.candidateIds),
    ]),
  )
  const selected = new Set<string>()
  const selections = parsed.decisions.map((item) => {
    if (
      !record(item) ||
      (!exactKeys(item, ['decisionId', 'candidateId']) &&
        !exactKeys(item, ['decisionId', 'abstain']))
    ) {
      invalid('LOCAL_CODEX_INVALID_RESPONSE')
    }
    const decisionId = boundedId(
      item.decisionId,
      'LOCAL_CODEX_INVALID_RESPONSE',
    )
    if (selected.has(decisionId) || !allowed.has(decisionId)) {
      invalid('LOCAL_CODEX_INVALID_RESPONSE')
    }
    selected.add(decisionId)
    if (Object.hasOwn(item, 'abstain')) {
      if (item.abstain !== true) invalid('LOCAL_CODEX_INVALID_RESPONSE')
      return Object.freeze({ decisionId, abstain: true as const })
    }
    const candidateId = boundedId(
      item.candidateId,
      'LOCAL_CODEX_INVALID_RESPONSE',
    )
    if (!allowed.get(decisionId)?.has(candidateId)) {
      invalid('LOCAL_CODEX_INVALID_RESPONSE')
    }
    return Object.freeze({ decisionId, candidateId })
  })
  if (selected.size !== allowed.size) invalid('LOCAL_CODEX_INVALID_RESPONSE')
  return Object.freeze(selections)
}

function threadIdentity(value: unknown) {
  const result = unwrapResult(value)
  if (!record(result) || !record(result.thread)) {
    invalid('LOCAL_CODEX_INVALID_THREAD_RESPONSE')
  }
  const id = boundedId(result.thread.id, 'LOCAL_CODEX_INVALID_THREAD_RESPONSE')
  if (result.thread.sessionId !== undefined && result.thread.sessionId !== id) {
    invalid('LOCAL_CODEX_SESSION_NOT_ISOLATED')
  }
  if (
    result.thread.forkedFromId !== undefined &&
    result.thread.forkedFromId !== null
  ) {
    invalid('LOCAL_CODEX_SESSION_NOT_ISOLATED')
  }
  return {
    id,
    modelId: boundedId(
      result.model,
      'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
    ),
    providerId: boundedId(
      result.modelProvider,
      'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
    ),
  }
}

function turnIdentity(value: unknown) {
  const result = unwrapResult(value)
  if (!record(result) || !record(result.turn)) {
    invalid('LOCAL_CODEX_INVALID_TURN_RESPONSE')
  }
  return boundedId(result.turn.id, 'LOCAL_CODEX_INVALID_TURN_RESPONSE')
}

function messageIdsMatch(
  params: Record<string, unknown>,
  threadId: string,
  turnId: string,
) {
  if (params.threadId !== undefined && params.threadId !== threadId)
    return false
  if (params.turnId !== undefined && params.turnId !== turnId) return false
  if (
    record(params.turn) &&
    params.turn.id !== undefined &&
    params.turn.id !== turnId
  ) {
    return false
  }
  return true
}

function agentTextFromItems(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  let finalText: string | null = null
  for (const item of value) {
    if (!record(item) || item.type !== 'agentMessage') continue
    if (item.phase !== undefined && item.phase !== 'final_answer') continue
    if (
      typeof item.text !== 'string' ||
      item.text.length > MAX_AGENT_RESPONSE_BYTES
    ) {
      invalid('LOCAL_CODEX_INVALID_RESPONSE')
    }
    if (finalText !== null) invalid('LOCAL_CODEX_INVALID_RESPONSE')
    finalText = item.text
  }
  return finalText
}

async function waitForFinalResponse(
  transport: LocalCodexJsonRpcTransport,
  signal: AbortSignal,
  threadId: string,
  turnId: string,
  initialModelId: string,
) {
  let finalText: string | null = null
  let observedModelId = initialModelId
  for (;;) {
    const message = await abortable(
      Promise.resolve(transport.nextMessage({ signal })),
      signal,
    )
    if (!record(message) || typeof message.method !== 'string') {
      invalid('LOCAL_CODEX_INVALID_NOTIFICATION')
    }
    if (Object.hasOwn(message, 'id')) {
      invalid('LOCAL_CODEX_UNEXPECTED_SERVER_REQUEST')
    }
    if (!record(message.params)) invalid('LOCAL_CODEX_INVALID_NOTIFICATION')
    if (!messageIdsMatch(message.params, threadId, turnId)) {
      invalid('LOCAL_CODEX_SESSION_NOT_ISOLATED')
    }
    if (message.method === 'item/completed') {
      const item = message.params.item
      if (record(item) && item.type === 'agentMessage') {
        if (item.phase !== undefined && item.phase !== 'final_answer') continue
        if (
          typeof item.text !== 'string' ||
          item.text.length > MAX_AGENT_RESPONSE_BYTES ||
          finalText !== null
        ) {
          invalid('LOCAL_CODEX_INVALID_RESPONSE')
        }
        finalText = item.text
      }
      // Reasoning, command, tool, file, and log items are deliberately dropped.
      continue
    }
    if (message.method === 'model/rerouted') {
      observedModelId = boundedId(
        message.params.toModel,
        'LOCAL_CODEX_INVALID_MODEL_IDENTITY',
      )
      continue
    }
    if (message.method !== 'turn/completed') continue
    const turn = message.params.turn
    if (!record(turn) || turn.id !== turnId) {
      invalid('LOCAL_CODEX_INVALID_TURN_RESPONSE')
    }
    if (turn.status !== 'completed') invalid('LOCAL_CODEX_TURN_NOT_COMPLETED')
    const fromTurn = agentTextFromItems(turn.items)
    if (fromTurn !== null) {
      if (finalText !== null && fromTurn !== finalText) {
        invalid('LOCAL_CODEX_INVALID_RESPONSE')
      }
      finalText = fromTurn
    }
    if (finalText === null) invalid('LOCAL_CODEX_INVALID_RESPONSE')
    return { text: finalText, observedModelId }
  }
}

async function boundedBestEffort(
  operation: Promise<unknown>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

export class LocalCodexReconciliationClient {
  private readonly endpoint: LocalCodexEndpoint
  private readonly timeoutMs: number
  private readonly interruptTimeoutMs: number
  private readonly maxRequestBytes: number
  private readonly expectedServerIdentitySha256?: string
  private readonly clientIdentity: ReturnType<typeof normalizeClientIdentity>
  private readonly identities: ReturnType<typeof normalizeIdentity>
  private readonly renderArtifactResolver: ReturnType<typeof normalizedResolver>
  private readonly identitySha256s: Readonly<{
    endpointSha256: string
    toolSha256: string
    modelSha256: string
    promptSha256: string
    renderArtifactResolverSha256: string
  }>
  private readonly transportFactory: LocalCodexTransportFactory
  private readonly attempts = new Map<string, AttemptEntry>()
  private readonly usedTransports = new WeakSet<object>()
  private readonly threadOwners = new Map<string, string>()
  private nextRequestId = 1

  constructor(config: LocalCodexReconciliationClientConfig) {
    assertSafeConfiguration(config)
    if (typeof config.transportFactory !== 'function') {
      invalid('LOCAL_CODEX_INVALID_CONFIGURATION')
    }
    this.endpoint = validateLocalCodexEndpoint(config.endpoint)
    this.timeoutMs = finiteInteger(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      1,
      10 * 60_000,
      'LOCAL_CODEX_INVALID_TIMEOUT',
    )
    this.interruptTimeoutMs = finiteInteger(
      config.interruptTimeoutMs,
      DEFAULT_INTERRUPT_TIMEOUT_MS,
      1,
      30_000,
      'LOCAL_CODEX_INVALID_TIMEOUT',
    )
    this.maxRequestBytes = finiteInteger(
      config.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES,
      1024,
      8 * 1024 * 1024,
      'LOCAL_CODEX_INVALID_REQUEST_LIMIT',
    )
    this.expectedServerIdentitySha256 =
      config.expectedServerIdentitySha256 === undefined
        ? undefined
        : sha256(
            config.expectedServerIdentitySha256,
            'LOCAL_CODEX_INVALID_SERVER_IDENTITY',
          )
    this.clientIdentity = normalizeClientIdentity(config.clientIdentity)
    this.identities = normalizeIdentity(config)
    this.renderArtifactResolver = normalizedResolver(
      config.renderArtifactResolver,
    )
    this.transportFactory = config.transportFactory
    this.identitySha256s = Object.freeze({
      endpointSha256: canonicalSha256(this.endpoint),
      toolSha256: canonicalSha256(this.identities.tool),
      modelSha256: canonicalSha256(this.identities.model),
      promptSha256: canonicalSha256(this.identities.prompt),
      renderArtifactResolverSha256: canonicalSha256(
        this.renderArtifactResolver.identity,
      ),
    })
  }

  reconcile(
    request: LocalCodexReconciliationRequest,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<LocalCodexReconciliationResult> {
    let prepared: PreparedRequest
    try {
      prepared = this.prepare(request)
    } catch (error) {
      return Promise.reject(error)
    }
    const sessionKey = `${request.documentId}\0${request.attemptId}`
    const existing = this.attempts.get(sessionKey)
    if (existing) {
      if (existing.fingerprint !== prepared.fingerprint) {
        return Promise.reject(
          new LocalCodexReconciliationError('LOCAL_CODEX_IDEMPOTENCY_CONFLICT'),
        )
      }
      return existing.promise
    }
    const promise = this.run(prepared, options.signal)
    this.attempts.set(
      sessionKey,
      Object.freeze({ fingerprint: prepared.fingerprint, promise }),
    )
    return promise
  }

  private prepare(request: LocalCodexReconciliationRequest): PreparedRequest {
    if (!record(request)) invalid('LOCAL_CODEX_INVALID_REQUEST')
    const documentId = boundedId(
      request.documentId,
      'LOCAL_CODEX_INVALID_REQUEST',
    )
    const attemptId = boundedId(
      request.attemptId,
      'LOCAL_CODEX_INVALID_REQUEST',
    )
    const graphSha256 = sha256(
      request.graphSha256,
      'LOCAL_CODEX_GRAPH_HASH_MISMATCH',
    )
    const candidateSetSha256 = sha256(
      request.candidateSetSha256,
      'LOCAL_CODEX_CANDIDATE_SET_HASH_MISMATCH',
    )
    let reader: ReturnType<typeof readSourceEvidenceGraph>
    try {
      reader = readSourceEvidenceGraph(request.evidenceGraph)
    } catch {
      invalid('LOCAL_CODEX_INVALID_EVIDENCE_GRAPH')
    }
    if (
      reader.source.documentId !== documentId ||
      reader.graphSha256 !== graphSha256 ||
      sourceEvidenceGraphSha256(request.evidenceGraph) !== graphSha256
    ) {
      invalid('LOCAL_CODEX_GRAPH_HASH_MISMATCH')
    }
    if (
      !Array.isArray(request.decisions) ||
      request.decisions.length === 0 ||
      request.decisions.length > MAX_TRACE_DECISIONS
    ) {
      invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
    }
    const decisionIds = new Set<string>()
    const allCandidateIds = new Set<string>()
    const decisions = request.decisions.map((decision) => {
      if (
        !record(decision) ||
        !exactKeys(decision, ['decisionId', 'candidateIds'])
      ) {
        invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
      }
      const decisionId = boundedId(
        decision.decisionId,
        'LOCAL_CODEX_INVALID_CANDIDATE_SET',
      )
      if (
        decisionIds.has(decisionId) ||
        !Array.isArray(decision.candidateIds) ||
        decision.candidateIds.length === 0
      ) {
        invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
      }
      decisionIds.add(decisionId)
      const local = new Set<string>()
      const candidateIds = decision.candidateIds.map((candidate) => {
        const id = boundedId(candidate, 'LOCAL_CODEX_INVALID_CANDIDATE_SET')
        if (local.has(id)) {
          invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
        }
        local.add(id)
        allCandidateIds.add(id)
        try {
          if (!reader.candidate(id))
            invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
        } catch {
          invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
        }
        return id
      })
      return Object.freeze({
        decisionId,
        candidateIds: Object.freeze(candidateIds),
      })
    })
    const candidateIds = Object.freeze([...allCandidateIds])
    if (candidateIds.length > MAX_TRACE_CANDIDATES) {
      invalid('LOCAL_CODEX_INVALID_CANDIDATE_SET')
    }
    if (reader.candidateSetSha256(candidateIds) !== candidateSetSha256) {
      invalid('LOCAL_CODEX_CANDIDATE_SET_HASH_MISMATCH')
    }
    const priorTrace = normalizeComparisonEvidence(
      request.comparisonEvidence,
    )
    const comparisonEvidence = comparisonProjection(priorTrace)
    if (comparisonEvidence.sourcePdfSha256 !== reader.source.sha256) {
      invalid('LOCAL_CODEX_INVALID_COMPARISON_EVIDENCE')
    }
    const renders = normalizeRenders(request.renders)
    for (const render of renders) {
      const provenance = render.provenance
      if (
        render.page > reader.source.pageCount ||
        render.candidateIds.some((candidateId) => {
          if (!allCandidateIds.has(candidateId)) return true
          const candidate = reader.candidate(candidateId)
          return candidate?.page !== undefined && candidate.page !== render.page
        })
      ) {
        invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
      }
      if (
        (provenance.kind === 'source-pdf' &&
          (provenance.sourcePdfSha256 !== reader.source.sha256 ||
            !priorTrace.sourcePdf.pageRenders.some(
              ({ page, image }) =>
                page === render.page &&
                image.sha256 === provenance.sourcePageRenderSha256,
            ))) ||
        (provenance.kind === 'rendered-epub' &&
          (provenance.epubSha256 !== comparisonEvidence.epubSha256 ||
            provenance.renderReceiptSha256 !==
              comparisonEvidence.renderReceiptSha256 ||
            !priorTrace.renderedEpub.screenshots.some(
              ({ id, image }) =>
                id === provenance.screenshotId &&
                image.sha256 === provenance.screenshotSha256,
            )))
      ) {
        invalid('LOCAL_CODEX_INVALID_RENDER_EVIDENCE')
      }
    }
    if (
      !renders.some(({ provenance }) => provenance.kind === 'source-pdf') ||
      !renders.some(({ provenance }) => provenance.kind === 'rendered-epub')
    ) {
      invalid('LOCAL_CODEX_SOURCE_EPUB_CROPS_REQUIRED')
    }
    const traceBundle = evidenceTraceBundle(reader, decisions)
    const isolatedSessionSha256 = canonicalSha256({ documentId, attemptId })
    const requestBinding = {
      schemaVersion: RESPONSE_SCHEMA_VERSION,
      documentIdSha256: digest(documentId),
      attemptIdSha256: digest(attemptId),
      graphSha256,
      candidateSetSha256,
      decisions,
      comparisonEvidence,
      priorTraceSha256: priorTrace.traceSha256,
      renderIdentities: renders.map(
        ({
          id,
          mimeType,
          sha256: renderSha256,
          page,
          box,
          candidateIds: renderCandidateIds,
          provenance,
        }) => ({
          id,
          mimeType,
          sha256: renderSha256,
          page,
          box,
          candidateIds: renderCandidateIds,
          provenance,
        }),
      ),
      traceBundleSha256: canonicalSha256(traceBundle),
      identities: this.identitySha256s,
    }
    const requestSha256 = canonicalSha256(requestBinding)
    // Whole graphs, PDFs, paths, and provider outputs stay in the owner-local
    // resolver. The app-server receives only this bounded evidence trace and
    // explicitly scoped source crops.
    const requestBytes = Buffer.byteLength(
      canonicalJson({ requestBinding, traceBundle, renders }),
    )
    if (requestBytes > this.maxRequestBytes)
      invalid('LOCAL_CODEX_REQUEST_TOO_LARGE')
    return Object.freeze({
      request,
      decisions: Object.freeze(decisions),
      candidateIds,
      renders,
      comparisonEvidence,
      priorTrace,
      traceBundle,
      isolatedSessionSha256,
      requestSha256,
      fingerprint: canonicalSha256({ requestSha256, isolatedSessionSha256 }),
    })
  }

  private requestId() {
    const id = this.nextRequestId
    this.nextRequestId += 1
    return id
  }

  private async rpc(
    transport: LocalCodexJsonRpcTransport,
    signal: AbortSignal,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) {
    return abortable(
      Promise.resolve(
        transport.request({ id: this.requestId(), method, params }, { signal }),
      ),
      signal,
    )
  }

  private async run(
    prepared: PreparedRequest,
    externalSignal?: AbortSignal,
  ): Promise<LocalCodexReconciliationResult> {
    const deadline = createDeadline(this.timeoutMs, externalSignal)
    let transport: LocalCodexJsonRpcTransport | undefined
    let threadId: string | undefined
    let turnId: string | undefined
    let completed = false
    try {
      await abortable(
        verifyBoundRenderCrops(prepared, this.renderArtifactResolver),
        deadline.signal,
      )
      transport = await abortable(
        Promise.resolve(
          this.transportFactory(this.endpoint, prepared.isolatedSessionSha256),
        ),
        deadline.signal,
      )
      if (!record(transport) || this.usedTransports.has(transport)) {
        invalid('LOCAL_CODEX_SESSION_NOT_ISOLATED')
      }
      this.usedTransports.add(transport)
      const actualEndpoint = validateLocalCodexEndpoint(transport.endpoint)
      const finalEndpoint = validateLocalCodexEndpoint(
        transport.finalEndpoint ?? transport.endpoint,
      )
      if (
        transport.redirected === true ||
        actualEndpoint.canonical !== this.endpoint.canonical ||
        finalEndpoint.canonical !== this.endpoint.canonical
      ) {
        invalid('LOCAL_CODEX_REDIRECT_FORBIDDEN')
      }

      const initialize = unwrapResult(
        await this.rpc(transport, deadline.signal, 'initialize', {
          clientInfo: this.clientIdentity,
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: REDACTED_NOTIFICATION_METHODS,
          },
        }),
      )
      const serverSha256 = canonicalSha256(initialize)
      if (
        this.expectedServerIdentitySha256 !== undefined &&
        this.expectedServerIdentitySha256 !== serverSha256
      ) {
        invalid('LOCAL_CODEX_SERVER_IDENTITY_MISMATCH')
      }
      await abortable(
        Promise.resolve(
          transport.notify(
            { method: 'initialized', params: {} },
            { signal: deadline.signal },
          ),
        ),
        deadline.signal,
      )

      const startedThread = threadIdentity(
        await this.rpc(transport, deadline.signal, 'thread/start', {
          model: this.identities.model.modelId,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: true,
          serviceName: 'erniesg_struct_reconciliation',
        }),
      )
      threadId = startedThread.id
      if (
        startedThread.modelId !== this.identities.model.modelId ||
        startedThread.providerId !== this.identities.model.providerId
      ) {
        invalid('LOCAL_CODEX_MODEL_IDENTITY_MISMATCH')
      }
      const existingOwner = this.threadOwners.get(threadId)
      if (
        existingOwner !== undefined &&
        existingOwner !== prepared.isolatedSessionSha256
      ) {
        invalid('LOCAL_CODEX_SESSION_NOT_ISOLATED')
      }
      this.threadOwners.set(threadId, prepared.isolatedSessionSha256)

      const schema = responseSchema(prepared.decisions)
      ;(schema.properties.graphSha256 as { const: string | null }).const =
        prepared.request.graphSha256
      ;(
        schema.properties.candidateSetSha256 as { const: string | null }
      ).const = prepared.request.candidateSetSha256
      const promptPayload = {
        schemaVersion: RESPONSE_SCHEMA_VERSION,
        documentIdSha256: digest(prepared.request.documentId),
        attemptIdSha256: digest(prepared.request.attemptId),
        graphSha256: prepared.request.graphSha256,
        candidateSetSha256: prepared.request.candidateSetSha256,
        comparisonEvidence: prepared.comparisonEvidence,
        trace: prepared.traceBundle,
        cropOrder: prepared.renders.map(
          ({
            id,
            sha256: renderSha256,
            page,
            box,
            candidateIds,
            provenance,
          }) => ({
            id,
            sha256: renderSha256,
            page,
            box,
            candidateIds,
            provenance,
          }),
        ),
      }
      const text = [
        this.identities.prompt.instructions,
        'Select exactly one supplied candidate or abstain for every decision.',
        'Use only the bounded source trace and crops in this owner-local task. Return schema-bound candidate IDs or abstentions only. Do not emit reasoning, new text, labels, bounds, destinations, assets, or claims. Do not use tools.',
        JSON.stringify(promptPayload),
      ].join('\n\n')
      const input: Array<Record<string, unknown>> = [
        { type: 'text', text, text_elements: [] },
        ...prepared.renders.map(({ mimeType, dataBase64 }) => ({
          type: 'image',
          url: `data:${mimeType};base64,${dataBase64}`,
        })),
      ]
      turnId = turnIdentity(
        await this.rpc(transport, deadline.signal, 'turn/start', {
          threadId,
          input,
          model: this.identities.model.modelId,
          ...(this.identities.model.reasoningEffort === undefined
            ? {}
            : { effort: this.identities.model.reasoningEffort }),
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'readOnly',
            networkAccess: false,
          },
          outputSchema: schema,
        }),
      )

      const observed = await waitForFinalResponse(
        transport,
        deadline.signal,
        threadId,
        turnId,
        startedThread.modelId,
      )
      if (observed.observedModelId !== this.identities.model.modelId) {
        invalid('LOCAL_CODEX_MODEL_IDENTITY_MISMATCH')
      }
      const selections = strictSelections(observed.text, prepared)
      completed = true
      const responseBinding = {
        schemaVersion: RESPONSE_SCHEMA_VERSION,
        graphSha256: prepared.request.graphSha256,
        candidateSetSha256: prepared.request.candidateSetSha256,
        decisions: selections,
      }
      const receipt: LocalCodexReconciliationReceipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        status: 'accepted',
        documentIdSha256: digest(prepared.request.documentId),
        attemptIdSha256: digest(prepared.request.attemptId),
        isolatedSessionSha256: prepared.isolatedSessionSha256,
        graphSha256: prepared.request.graphSha256,
        candidateSetSha256: prepared.request.candidateSetSha256,
        requestSha256: prepared.requestSha256,
        responseSha256: canonicalSha256(responseBinding),
        selectionSetSha256: canonicalSha256(selections),
        comparisonEvidenceSha256: prepared.priorTrace.traceSha256,
        cropEvidenceSha256: canonicalSha256(
          prepared.renders.map(
            ({ dataBase64: _dataBase64, ...identity }) => identity,
          ),
        ),
        threadSha256: digest(threadId),
        turnSha256: digest(turnId),
        identities: {
          ...this.identitySha256s,
          serverSha256,
          observedModelSha256: canonicalSha256({
            providerId: startedThread.providerId,
            modelId: observed.observedModelId,
          }),
        },
        counts: {
          decisionCount: prepared.decisions.length,
          candidateCount: prepared.candidateIds.length,
          renderCount: prepared.renders.length,
          sourceCropCount: prepared.renders.filter(
            ({ provenance }) => provenance.kind === 'source-pdf',
          ).length,
          epubCropCount: prepared.renders.filter(
            ({ provenance }) => provenance.kind === 'rendered-epub',
          ).length,
        },
      }
      return deepFreeze({ selections, receipt })
    } catch (error) {
      if (transport && threadId && turnId && !completed) {
        await boundedBestEffort(
          Promise.resolve(
            transport.request(
              {
                id: this.requestId(),
                method: 'turn/interrupt',
                params: { threadId, turnId },
              },
              { signal: new AbortController().signal },
            ),
          ),
          this.interruptTimeoutMs,
        )
      }
      if (deadline.reason() === 'timeout') invalid('LOCAL_CODEX_TIMEOUT')
      if (deadline.reason() === 'aborted') invalid('LOCAL_CODEX_ABORTED')
      throw error
    } finally {
      deadline.dispose()
      if (transport?.close) {
        await boundedBestEffort(
          Promise.resolve(transport.close()),
          this.interruptTimeoutMs,
        )
      }
    }
  }
}

export function createLocalCodexReconciliationClient(
  config: LocalCodexReconciliationClientConfig,
) {
  return new LocalCodexReconciliationClient(config)
}
