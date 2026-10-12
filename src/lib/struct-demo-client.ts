const API = '/api/struct-demo'
const MAX_BYTES = 10 * 1024 * 1024
const SESSION_KEY = 'struct-demo-job'
const POLL_INTERVAL = 5_000
const POLL_DURATION = 65 * 60_000
const validJob = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const validEpub = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9 _().-]{0,199}\.epub$/i.test(value) &&
  !value.includes('..')

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
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let active = true
      let busy = false
      let allowed = false
      let maxBytes = MAX_BYTES
      let jobId: string | undefined
      let pollUntil = 0
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
        } catch {
          /* Storage is optional. */
        }
      }
      const resetLabel = (value: unknown) => {
        const date = typeof value === 'string' ? new Date(value) : null
        return date && Number.isFinite(date.getTime())
          ? ` Resets at ${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}.`
          : ' Resets at the next UTC day.'
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
            ? `${data.remaining} of ${data.dailyLimit} conversions remaining for this network today.`
            : `The daily limit has been reached.${resetLabel(data.resetsAt)} Preconverted samples still work.`
          refresh.hidden = allowed
        } catch {
          if (!active) return
          quota.textContent =
            'Uploads are unavailable. Paper conversion is unavailable too. Preconverted samples still work; try checking availability again later.'
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
            for (const file of Array.isArray(data.files) ? data.files : []) {
              if (!validEpub(file?.name)) continue
              const item = document.createElement('li')
              const link = document.createElement('a')
              link.textContent = `Download ${file.name}`
              link.href = `${API}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.name)}`
              link.download = file.name
              link.className = 'underline underline-offset-4'
              item.append(link)
              downloads.append(item)
            }
            say(
              downloads.childElementCount
                ? 'Conversion complete. Your EPUB is ready.'
                : 'Conversion finished, but no EPUB is available. Please try another PDF.',
            )
            busy = false
            store()
            controls()
            return
          }
          if (data.status === 'failed') {
            say('Conversion failed. Please try another PDF.')
            busy = false
            store()
            controls()
            return
          }
          say(
            data.status === 'queued'
              ? 'Your PDF is queued for conversion.'
              : 'Converting your PDF…',
          )
          if (Date.now() >= pollUntil) throw new Error('Timeout')
          timer = setTimeout(poll, POLL_INTERVAL)
        } catch {
          if (!active) return
          say(
            'Status checking paused. Your upload may still be converting. Retry to check its progress; do not upload it again.',
          )
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
                ? `The daily limit has been reached.${resetLabel(data.resetsAt)} Preconverted samples still work.`
                : data.error?.code === 'busy'
                  ? 'The converter is busy. Try again shortly. Preconverted samples still work.'
                  : 'Conversion is temporarily unavailable. Try again shortly. Preconverted samples still work.',
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
          say(
            'The conversion request could not be confirmed. Check availability before trying again.',
          )
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
          say('Choose a PDF first.')
          return
        }
        busy = true
        controls()
        downloads.replaceChildren()
        try {
          if (file.size > maxBytes) {
            say(
              `Choose a PDF no larger than ${Math.floor(maxBytes / 1024 / 1024)} MiB.`,
            )
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
            say(
              'Choose a valid PDF file. Renaming another file to .pdf will not work.',
            )
            busy = false
            controls()
            return
          }
          if (!active) return
          say('Uploading your PDF…')
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
          say(
            'The upload could not be confirmed. Check availability before trying again.',
          )
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
          say('Requesting this paper from arXiv for conversion…')
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
        pollUntil = Date.now() + POLL_DURATION
        void poll()
      }
      void checkLimits()
      const cleanup = () => {
        active = false
        clearTimeout(timer)
        abort.abort()
      }
      document.addEventListener('astro:before-swap', cleanup, { once: true })
      window.addEventListener('pagehide', cleanup, { once: true })
    })
}
