import { currentStructDemoCopy } from '../research/struct-demo-copy'
import { compileStructDemoEpubPreview } from './struct-demo-epub-preview'

const API = '/api/struct-demo'
const MAX_BYTES = 10 * 1024 * 1024
const MAX_EPUB_BYTES = 32 * 1024 * 1024
const SESSION_KEY = 'struct-demo-job'
const SESSION_SOURCE_KEY = 'struct-demo-source-sample'
const POLL_INTERVAL = 5_000
const POLL_DURATION = 65 * 60_000
const validJob = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const validEpub = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9 _().-]{0,199}\.epub$/i.test(value) &&
  !value.includes('..')

async function readBoundedEpub(response: Response, signal?: AbortSignal) {
  const advertised = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > MAX_EPUB_BYTES) {
    throw new Error('EPUB is too large')
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_EPUB_BYTES) throw new Error('EPUB is too large')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_EPUB_BYTES) throw new Error('EPUB is too large')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function previewUnavailable(root: EventTarget, requestId: string) {
  root.dispatchEvent(
    new CustomEvent('struct:preview-ready', {
      detail: { error: 'preview-unavailable', requestId },
    }),
  )
}

function validPreviewRoute(href: string, filename: string) {
  const match = href.match(
    /^\/api\/struct-demo\/jobs\/([A-Za-z0-9_-]{1,128})\/files\/([^/?#]+)$/,
  )
  if (!match || !validJob(match[1])) return false
  try {
    return decodeURIComponent(match[2]!) === filename && validEpub(filename)
  } catch {
    return false
  }
}

export async function loadStructDemoEpubPreview(
  root: EventTarget,
  href: string,
  filename: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  requestId = 'struct-preview-direct',
) {
  try {
    if (!validPreviewRoute(href, filename)) throw new Error('Invalid preview')
    const response = await fetcher(href, {
      credentials: 'same-origin',
      signal,
      redirect: 'error',
    })
    if (!response.ok || response.redirected)
      throw new Error('EPUB is unavailable')
    const preview = compileStructDemoEpubPreview(
      await readBoundedEpub(response, signal),
      filename,
    )
    if (signal?.aborted) return
    root.dispatchEvent(
      new CustomEvent('struct:preview-ready', {
        detail: { ...preview, requestId },
      }),
    )
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      return
    previewUnavailable(root, requestId)
  }
}

export function initializeStructDemos() {
  document
    .querySelectorAll<HTMLElement>('[data-struct-demo]')
    .forEach((root) => {
      if (root.dataset.initialized) return
      root.dataset.initialized = 'true'
      const form = root.querySelector<HTMLFormElement>('[data-struct-form]')!
      const input = form.querySelector<HTMLInputElement>('input')!
      const submit = form.querySelector<HTMLButtonElement>('button')!
      const status = root.querySelector<HTMLElement>('[data-struct-status]')!
      const quota = root.querySelector<HTMLElement>('[data-struct-quota]')!
      const downloads = root.querySelector<HTMLElement>(
        '[data-struct-downloads]',
      )!
      const retry = root.querySelector<HTMLButtonElement>(
        '[data-struct-retry]',
      )!
      const refresh = root.querySelector<HTMLButtonElement>(
        '[data-struct-refresh]',
      )!
      const sampleButtons = root.querySelectorAll<HTMLButtonElement>(
        '[data-struct-convert-sample]',
      )
      const copy = currentStructDemoCopy
      retry.textContent = copy().retry
      refresh.textContent = copy().refresh
      const abort = new AbortController()
      let previewAbort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let active = true
      let busy = false
      let allowed = false
      let maxBytes = MAX_BYTES
      let jobId: string | undefined
      let pollUntil = 0
      let previewSequence = 0
      let previewRequestId: string | undefined
      let pendingSourceSample: string | undefined
      const startPreview = (
        previewJobId?: string,
        sourceFile?: File,
        sourceSampleId?: string,
      ) => {
        pendingSourceSample = sourceSampleId
        previewAbort.abort()
        previewAbort = new AbortController()
        previewRequestId = `struct-preview-${Date.now().toString(36)}-${++previewSequence}`
        root.dispatchEvent(
          new CustomEvent('struct:preview-start', {
            detail: {
              requestId: previewRequestId,
              sourceFile,
              sourceSampleId,
              ...(previewJobId ? { jobId: previewJobId } : {}),
            },
          }),
        )
        return previewRequestId
      }
      const say = (message: string) => {
        if (active) status.textContent = message
      }
      const controls = () => {
        input.disabled = submit.disabled = !allowed || busy
        sampleButtons.forEach((button) => {
          button.disabled = !allowed || busy
        })
      }
      const storedJob = () => {
        try {
          return sessionStorage.getItem(SESSION_KEY)
        } catch {
          return null
        }
      }
      const store = (id?: string) => {
        try {
          if (id) sessionStorage.setItem(SESSION_KEY, id)
          else sessionStorage.removeItem(SESSION_KEY)
          if (id && pendingSourceSample === 'attention-is-all-you-need')
            sessionStorage.setItem(
              SESSION_SOURCE_KEY,
              JSON.stringify({ jobId: id, sampleId: pendingSourceSample }),
            )
          else sessionStorage.removeItem(SESSION_SOURCE_KEY)
        } catch {
          /* Storage is optional. */
        }
      }
      const resetLabel = (value: unknown) => {
        const date = typeof value === 'string' ? new Date(value) : null
        return date && Number.isFinite(date.getTime())
          ? copy().reset(
              date.toISOString().replace('T', ' ').replace('.000Z', ' UTC'),
            )
          : copy().nextReset
      }
      async function checkLimits() {
        refresh.hidden = true
        allowed = false
        controls()
        try {
          const response = await fetch(`${API}/limits`, {
            signal: abort.signal,
            credentials: 'same-origin',
          })
          if (!response.ok) throw new Error('Unavailable')
          const data = await response.json()
          if (!active) return
          if (
            data.available !== true ||
            !Number.isInteger(data.remaining) ||
            !Number.isInteger(data.globalRemaining) ||
            !Number.isInteger(data.dailyLimit) ||
            !Number.isFinite(data.maxBytes) ||
            data.maxBytes <= 0
          )
            throw new Error('Unavailable')
          maxBytes = Math.min(MAX_BYTES, data.maxBytes)
          allowed = data.remaining > 0 && data.globalRemaining > 0
          quota.textContent = allowed
            ? copy().remaining(data.remaining, data.dailyLimit)
            : `${copy().limit}${resetLabel(data.resetsAt)}${copy().samples}`
          refresh.hidden = allowed
        } catch {
          if (!active) return
          quota.textContent = copy().unavailable
          refresh.hidden = false
        }
        controls()
      }
      async function poll() {
        if (!jobId || !active) return
        retry.hidden = true
        try {
          const response = await fetch(
            `${API}/jobs/${encodeURIComponent(jobId)}`,
            { signal: abort.signal, credentials: 'same-origin' },
          )
          if (!response.ok) throw new Error('Unavailable')
          const data = await response.json()
          if (!active) return
          if (
            data.id !== jobId ||
            !['queued', 'running', 'done', 'failed'].includes(data.status)
          )
            throw new Error('Unavailable')
          if (data.status === 'done') {
            downloads.replaceChildren()
            const epubFiles: string[] = (
              Array.isArray(data.files) ? data.files : []
            )
              .map((file: unknown) =>
                typeof file === 'object' && file !== null
                  ? (file as { name?: unknown }).name
                  : undefined,
              )
              .filter((name: unknown): name is string => validEpub(name))
            for (const name of epubFiles) {
              const item = document.createElement('li')
              const link = document.createElement('a')
              link.textContent = copy().download(name)
              link.href = `${API}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`
              link.download = name
              link.className = 'underline underline-offset-4'
              item.append(link)
              downloads.append(item)
            }
            say(downloads.childElementCount ? copy().complete : copy().noEpub)
            busy = false
            store()
            controls()
            const previewName =
              epubFiles.find((name) =>
                /(?:^|[-_.])mobile(?:[-_.]|$)/i.test(name),
              ) ?? epubFiles[0]
            if (previewName) {
              const previewHref = `${API}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(previewName)}`
              void loadStructDemoEpubPreview(
                root,
                previewHref,
                previewName,
                previewAbort.signal,
                fetch,
                previewRequestId,
              )
            } else {
              previewUnavailable(root, previewRequestId ?? startPreview(jobId))
            }
            return
          }
          if (data.status === 'failed') {
            say(copy().failed)
            busy = false
            store()
            controls()
            return
          }
          say(data.status === 'queued' ? copy().queued : copy().running)
          if (Date.now() >= pollUntil) throw new Error('Timeout')
          timer = setTimeout(poll, POLL_INTERVAL)
        } catch {
          if (!active) return
          say(copy().paused)
          retry.hidden = false
        }
      }
      async function submitJob(path: string, init: RequestInit) {
        try {
          const response = await fetch(path, {
            ...init,
            credentials: 'same-origin',
            signal: abort.signal,
          })
          if (response.status === 429) {
            const data = await response.json().catch(() => ({}))
            allowed = false
            say(
              data.error?.code === 'daily_limit'
                ? `${copy().limit}${resetLabel(data.resetsAt)}${copy().samples}`
                : data.error?.code === 'busy'
                  ? copy().busy
                  : copy().temporary,
            )
            refresh.hidden = false
            busy = false
            controls()
            return
          }
          if (response.status !== 202) throw new Error('Unavailable')
          const data = await response.json()
          if (!validJob(data.id) || data.status !== 'queued')
            throw new Error('Unavailable')
          if (!active) return
          jobId = data.id
          store(jobId)
          pollUntil = Date.now() + POLL_DURATION
          void checkLimits()
          await poll()
        } catch {
          if (!active) return
          say(copy().requestFailed)
          busy = false
          allowed = false
          refresh.hidden = false
          controls()
        }
      }
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        if (busy || !allowed) return
        const file = input.files?.[0]
        if (!file) {
          say(copy().choose)
          return
        }
        busy = true
        controls()
        downloads.replaceChildren()
        try {
          if (file.size > maxBytes) {
            say(copy().oversize(Math.floor(maxBytes / 1024 / 1024)))
            busy = false
            controls()
            return
          }
          if (
            !/\.pdf$/i.test(file.name) ||
            file.size < 5 ||
            new TextDecoder().decode(await file.slice(0, 5).arrayBuffer()) !==
              '%PDF-'
          ) {
            say(copy().invalid)
            busy = false
            controls()
            return
          }
          if (!active) return
          say(copy().uploading)
          startPreview(undefined, file)
          await submitJob(`${API}/jobs`, {
            method: 'POST',
            body: file,
            headers: {
              'Content-Type': 'application/pdf',
              'X-Filename': encodeURIComponent(file.name),
            },
          })
        } catch {
          if (!active) return
          say(copy().uploadFailed)
          busy = false
          allowed = false
          refresh.hidden = false
          controls()
        }
      })
      sampleButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const sampleId = button.dataset.structConvertSample
          if (busy || !allowed || sampleId !== 'attention-is-all-you-need')
            return
          busy = true
          controls()
          downloads.replaceChildren()
          startPreview(undefined, undefined, sampleId)
          say(copy().requestPaper)
          status.scrollIntoView({ block: 'center', behavior: 'auto' })
          void submitJob(`${API}/samples/${sampleId}`, { method: 'POST' })
        })
      })
      retry.addEventListener('click', () => {
        pollUntil = Date.now() + POLL_DURATION
        void poll()
      })
      refresh.addEventListener('click', () => {
        void checkLimits()
      })
      const saved = storedJob()
      if (validJob(saved)) {
        jobId = saved
        busy = true
        let sourceSampleId: string | undefined
        try {
          const source = JSON.parse(
            sessionStorage.getItem(SESSION_SOURCE_KEY) ?? 'null',
          )
          if (
            source?.jobId === jobId &&
            source?.sampleId === 'attention-is-all-you-need'
          )
            sourceSampleId = source.sampleId
        } catch {
          /* Storage is optional. */
        }
        startPreview(jobId, undefined, sourceSampleId)
        pollUntil = Date.now() + POLL_DURATION
        void poll()
      }
      void checkLimits()
      const cleanup = () => {
        active = false
        clearTimeout(timer)
        abort.abort()
        previewAbort.abort()
      }
      document.addEventListener('astro:before-swap', cleanup, { once: true })
      window.addEventListener('pagehide', cleanup, { once: true })
    })
}
