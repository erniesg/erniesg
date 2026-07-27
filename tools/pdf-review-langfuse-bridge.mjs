import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'

const host = '127.0.0.1'
const port = Number.parseInt(process.env.PDF_REVIEW_SINK_PORT ?? '4319', 10)
const logPath = resolve(
  process.env.PDF_REVIEW_LOG_PATH ??
    '/tmp/rucksack-pdf-review-feedback/events.jsonl',
)
const langfuseBaseUrl = (
  process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'
).replace(/\/+$/u, '')
const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim()
const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY?.trim()
const langfuseConfigured = Boolean(langfusePublicKey && langfuseSecretKey)
const maxBodyBytes = 64 * 1024

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': 'http://127.0.0.1:1234',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  response.end(`${JSON.stringify(body)}\n`)
}

function validEvent(value) {
  return (
    value &&
    value.schemaVersion === 1 &&
    value.eventType === 'pdf-epub-criterion-reviewed' &&
    typeof value.eventId === 'string' &&
    value.eventId.length <= 2_000 &&
    typeof value.corpusId === 'string' &&
    typeof value.sampleId === 'string' &&
    typeof value.criterionId === 'string' &&
    ['pass', 'fail', 'defer'].includes(value.verdict) &&
    typeof value.source?.expectedSha256 === 'string' &&
    typeof value.epub?.sha256 === 'string'
  )
}

function stableId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function langfuseAuthorization() {
  return `Basic ${Buffer.from(
    `${langfusePublicKey}:${langfuseSecretKey}`,
  ).toString('base64')}`
}

async function langfuseRequest(path, body) {
  const response = await fetch(`${langfuseBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: langfuseAuthorization(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`Langfuse ${path} returned ${response.status}`)
  }
}

async function mirrorToLangfuse(event) {
  if (!langfuseConfigured) return false
  const traceId = stableId(
    `${event.corpusId}:${event.sampleId}:${event.epub.sha256}`,
  )
  await langfuseRequest('/api/public/ingestion', {
    batch: [
      {
        id: randomUUID(),
        timestamp: event.occurredAt,
        type: 'trace-create',
        body: {
          id: traceId,
          name: 'pdf-epub-human-review',
          sessionId: event.corpusId,
          userId: event.reviewer ?? undefined,
          tags: [
            'pdf-to-epub',
            event.setId,
            event.epub.profileId,
            event.epub.mode,
          ],
          metadata: {
            sampleId: event.sampleId,
            sourceSha256: event.source.expectedSha256,
            epubSha256: event.epub.sha256,
            profileVersion: event.epub.profileVersion,
            readiness: event.machine.readiness,
            blockingDiagnosticCodes: event.machine.blockingDiagnosticCodes,
          },
        },
      },
    ],
  })
  await langfuseRequest('/api/public/scores', {
    id: stableId(event.eventId),
    traceId,
    name: `pdf_epub/${event.criterionId}`,
    value: event.verdict,
    dataType: 'CATEGORICAL',
    comment: JSON.stringify({
      severity: event.severity,
      location: event.location,
      notes: event.notes,
      eventId: event.eventId,
    }),
    metadata: {
      schemaVersion: event.schemaVersion,
      sourceIdentityVerified: event.source.identityVerified,
      diagnosticCodes: event.machine.diagnosticCodes,
    },
  })
  return true
}

await mkdir(dirname(logPath), { recursive: true })

const server = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    send(response, 204, {})
    return
  }
  if (request.method !== 'POST' || request.url !== '/events') {
    send(response, 404, { accepted: false })
    return
  }
  let size = 0
  const chunks = []
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > maxBodyBytes) request.destroy()
    else chunks.push(chunk)
  })
  request.on('end', () => {
    void (async () => {
      let event
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        send(response, 400, { accepted: false, error: 'invalid-json' })
        return
      }
      if (!validEvent(event)) {
        send(response, 422, { accepted: false, error: 'invalid-event' })
        return
      }
      await appendFile(logPath, `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      try {
        const mirrored = await mirrorToLangfuse(event)
        send(response, 202, { accepted: true, mirrored })
      } catch (error) {
        send(response, 202, {
          accepted: true,
          mirrored: false,
          mirrorError:
            error instanceof Error ? error.message : 'Langfuse mirror failed',
        })
      }
    })().catch((error) => {
      send(response, 500, {
        accepted: false,
        error: error instanceof Error ? error.message : 'sink-failed',
      })
    })
  })
})

server.listen(port, host, () => {
  process.stdout.write(
    [
      `PDF review sink listening on http://${host}:${port}/events`,
      `Local append-only log: ${logPath}`,
      langfuseConfigured
        ? `Langfuse mirror enabled: ${langfuseBaseUrl}`
        : 'Langfuse mirror disabled; set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY on this trusted process.',
    ].join('\n') + '\n',
  )
})
