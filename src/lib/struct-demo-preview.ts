import { createStructOriginalViewer } from './struct-demo-original'
import {
  DEFAULT_READER_SETTINGS,
  STRUCT_DEVICE_MODELS,
  STRUCT_READER_FONTS,
  previewDimension,
  readerDocument,
  type ReaderSettings,
} from './struct-reader-settings'

export const STRUCT_PREVIEW_SIZES = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  eink: { width: 600, height: 800 },
} as const
export type StructPreviewDevice = keyof typeof STRUCT_PREVIEW_SIZES

export function previewScale(
  availableWidth: number,
  logicalWidth: number,
): number {
  return availableWidth > 0 ? Math.min(1, availableWidth / logicalWidth) : 1
}

export function createPreviewRequestGuard() {
  let requestId: string | undefined
  let selectionRevision = 0
  let startedRevision = 0
  const accepts = (candidate: unknown) =>
    requestId !== undefined && candidate === requestId
  return {
    start(candidate: string) {
      if (candidate === requestId) return
      requestId = candidate
      startedRevision = selectionRevision
    },
    selectionChanged() {
      selectionRevision += 1
    },
    accepts,
    shouldActivate(candidate: unknown) {
      return accepts(candidate) && startedRevision === selectionRevision
    },
  }
}

export function initializeStructPreviews() {
  document
    .querySelectorAll<HTMLElement>('[data-struct-demo]')
    .forEach((root) => {
      if (root.dataset.previewInitialized) return
      root.dataset.previewInitialized = 'true'
      const select = root.querySelector<HTMLSelectElement>(
        '[data-struct-sample-select]',
      )!
      const articles = Array.from(
        root.querySelectorAll<HTMLElement>('[data-struct-sample]'),
      )
      const frame = root.querySelector<HTMLIFrameElement>(
        '[data-struct-preview-frame]',
      )!
      const originalFrame = root.querySelector<HTMLElement>(
        '[data-struct-original-frame]',
      )!
      const originalViewer = createStructOriginalViewer(originalFrame)
      const originalLink = root.querySelector<HTMLAnchorElement>(
        '[data-struct-original-link]',
      )!
      const originalEmpty = root.querySelector<HTMLElement>(
        '[data-struct-original-empty]',
      )!
      const viewport = root.querySelector<HTMLElement>(
        '[data-struct-preview-viewport]',
      )!
      const stage = root.querySelector<HTMLElement>(
        '[data-struct-preview-stage]',
      )!
      const title = root.querySelector<HTMLElement>(
        '[data-struct-preview-title]',
      )!
      const error = root.querySelector<HTMLElement>(
        '[data-struct-preview-error]',
      )!
      const empty = root.querySelector<HTMLElement>(
        '[data-struct-preview-empty]',
      )!
      const uploadedOption = root.querySelector<HTMLOptionElement>(
        '[data-struct-upload-option]',
      )!
      const uploadLabel = uploadedOption.textContent
      const frameLabel = frame.title
      const buttons = root.querySelectorAll<HTMLButtonElement>(
        '[data-struct-device]',
      )
      let device: StructPreviewDevice = 'phone'
      const model = root.querySelector<HTMLSelectElement>(
        '[data-struct-model]',
      )!
      const widthInput = root.querySelector<HTMLInputElement>(
        '[data-struct-width]',
      )!
      const heightInput = root.querySelector<HTMLInputElement>(
        '[data-struct-height]',
      )!
      const fontInput = root.querySelector<HTMLSelectElement>(
        '[data-struct-font-family]',
      )!
      const fontSizeInput = root.querySelector<HTMLInputElement>(
        '[data-struct-font-size]',
      )!
      const marginInput = root.querySelector<HTMLInputElement>(
        '[data-struct-margin]',
      )!
      let size = { ...STRUCT_PREVIEW_SIZES.phone } as {
        width: number
        height: number
      }
      let settings = { ...DEFAULT_READER_SETTINGS }
      let active = true
      let documentRevision = 0
      const sampleDocuments = new Map<string, string>()
      const sampleAbort = new AbortController()
      function syncModels() {
        Array.from(model.options).forEach((option) => {
          option.hidden =
            !!option.dataset.device && option.dataset.device !== device
        })
        buttons.forEach((button) =>
          button.setAttribute(
            'aria-pressed',
            String(button.dataset.structDevice === device),
          ),
        )
        widthInput.value = String(size.width)
        heightInput.value = String(size.height)
      }
      async function renderReadingDocument() {
        const revision = ++documentRevision
        if (select.value === '__upload__') {
          if (uploaded) {
            // srcdoc overrides the sample URL. Leave src alone: removing it
            // can race this document with an unwanted about:blank navigation.
            frame.srcdoc = readerDocument(uploaded.html, settings)
          }
          return
        }
        const source = articles.find(
          (article) => article.dataset.sampleId === select.value,
        )?.dataset.sampleHtml
        if (!source) return
        try {
          const url = new URL(source, location.href)
          if (
            url.origin !== location.origin ||
            !url.pathname.startsWith('/research/struct/samples/')
          )
            return
          let html = sampleDocuments.get(source)
          if (html === undefined) {
            const response = await fetch(url, { signal: sampleAbort.signal })
            if (!response.ok) throw new Error('Sample unavailable')
            html = await response.text()
            sampleDocuments.set(source, html)
          }
          if (!active || revision !== documentRevision) return
          frame.srcdoc = readerDocument(html, settings, url.href)
        } catch {
          // Keep the direct sample URL usable if the settings copy cannot load.
          if (active && revision === documentRevision) error.hidden = false
        }
      }
      let uploaded: { html: string; title: string } | undefined
      const requests = createPreviewRequestGuard()
      let uploadedPdf: string | undefined
      let ownedPdf: string | undefined
      let sourceRequestId: string | undefined
      function resize() {
        const scale = previewScale(viewport.clientWidth, size.width)
        frame.style.width = `${size.width}px`
        frame.style.height = `${size.height}px`
        frame.style.transformOrigin = 'top left'
        frame.style.transform = `scale(${scale})`
        stage.style.width = `${size.width * scale}px`
        stage.style.height = `${size.height * scale}px`
      }
      function chooseSample() {
        error.hidden = true
        const selectedArticle = articles.find(
          (article) => article.dataset.sampleId === select.value,
        )
        const pdf =
          select.value === '__upload__'
            ? uploadedPdf
            : selectedArticle?.dataset.samplePdf
        originalFrame.hidden = originalLink.hidden = !pdf
        originalEmpty.hidden = !!pdf
        if (pdf) {
          originalFrame.setAttribute('src', pdf)
          originalLink.href = pdf
          originalFrame.title = `${selectedArticle?.dataset.sampleTitle ?? uploaded?.title ?? 'Source'} · Original PDF`
        } else {
          originalFrame.removeAttribute('src')
          originalLink.removeAttribute('href')
        }
        originalViewer.setSource(pdf, originalFrame.title)
        articles.forEach((article) => {
          article.hidden = article.dataset.sampleId !== select.value
        })
        if (select.value === '__upload__') {
          title.textContent = uploaded?.title ?? uploadedOption.textContent
          if (!uploaded) {
            frame.removeAttribute('srcdoc')
            frame.removeAttribute('src')
          }
          viewport.hidden = !uploaded
          error.hidden = !!uploaded
          empty.hidden = true
        } else {
          const article = articles.find(
            (article) => article.dataset.sampleId === select.value,
          )
          const source = article?.dataset.sampleHtml
          if (article?.dataset.sampleTitle)
            title.textContent = article.dataset.sampleTitle
          frame.removeAttribute('srcdoc')
          if (source) frame.src = source
          else frame.removeAttribute('src')
          viewport.hidden = !source
          empty.hidden = !!source || !article
        }
        frame.title = `${title.textContent} · ${frameLabel}`
        resize()
        void renderReadingDocument()
      }
      select.addEventListener('change', () => {
        requests.selectionChanged()
        chooseSample()
      })
      buttons.forEach((button) =>
        button.addEventListener('click', () => {
          const value = button.dataset.structDevice
          if (!value || !Object.hasOwn(STRUCT_PREVIEW_SIZES, value)) return
          device = value as StructPreviewDevice
          model.value = device
          size = { ...STRUCT_PREVIEW_SIZES[device] }
          syncModels()
          resize()
        }),
      )
      model.addEventListener('change', () => {
        const selected = STRUCT_DEVICE_MODELS.find(
          (item) => item.id === model.value && item.device === device,
        )
        if (selected) size = { width: selected.width, height: selected.height }
        syncModels()
        resize()
      })
      for (const input of [widthInput, heightInput])
        input.addEventListener('change', () => {
          size = {
            width: previewDimension(widthInput.value, size.width),
            height: previewDimension(heightInput.value, size.height),
          }
          model.value = 'custom'
          syncModels()
          resize()
        })
      function updateTypography() {
        const family = fontInput.value
        if (Object.hasOwn(STRUCT_READER_FONTS, family))
          settings.fontFamily = family as ReaderSettings['fontFamily']
        const fontSize = fontSizeInput.valueAsNumber
        const margin = marginInput.valueAsNumber
        if (Number.isFinite(fontSize))
          settings.fontSize = Math.min(32, Math.max(12, Math.round(fontSize)))
        if (Number.isFinite(margin))
          settings.margin = Math.min(80, Math.max(0, Math.round(margin)))
        fontSizeInput.value = String(settings.fontSize)
        marginInput.value = String(settings.margin)
        void renderReadingDocument()
      }
      for (const input of [fontInput, fontSizeInput, marginInput])
        input.addEventListener('change', updateTypography)
      root
        .querySelector('[data-struct-reader-reset]')!
        .addEventListener('click', () => {
          settings = { ...DEFAULT_READER_SETTINGS }
          device = 'phone'
          size = { ...STRUCT_PREVIEW_SIZES.phone }
          model.value = 'phone'
          fontInput.value = settings.fontFamily
          fontSizeInput.value = String(settings.fontSize)
          marginInput.value = String(settings.margin)
          syncModels()
          resize()
          void renderReadingDocument()
        })
      const start = (event: Event) => {
        if (!(event instanceof CustomEvent)) return
        const requestId = event.detail?.requestId
        if (typeof requestId !== 'string' || requestId.length === 0) return
        if (requestId === sourceRequestId) return
        sourceRequestId = requestId
        requests.start(requestId)
        if (ownedPdf) URL.revokeObjectURL(ownedPdf)
        ownedPdf = undefined
        uploadedPdf = undefined
        if (event.detail.sourceFile instanceof File) {
          ownedPdf = URL.createObjectURL(
            new Blob([event.detail.sourceFile], { type: 'application/pdf' }),
          )
          uploadedPdf = ownedPdf
        } else if (typeof event.detail.sourceSampleId === 'string') {
          uploadedPdf = articles.find(
            (article) =>
              article.dataset.sampleId === event.detail.sourceSampleId,
          )?.dataset.samplePdf
        }
        if (select.value === '__upload__') {
          uploaded = undefined
          chooseSample()
        }
      }
      const ready = (event: Event) => {
        if (!(event instanceof CustomEvent)) return
        const detail = event.detail
        if (!requests.accepts(detail?.requestId)) return
        if (detail?.error === 'preview-unavailable') {
          uploaded = undefined
          uploadedOption.textContent = uploadLabel
          uploadedOption.disabled = uploadedOption.hidden = false
          if (requests.shouldActivate(detail.requestId)) {
            select.value = '__upload__'
            chooseSample()
          }
          return
        }
        if (
          typeof detail?.html !== 'string' ||
          typeof detail?.title !== 'string'
        )
          return
        uploaded = { html: detail.html, title: detail.title }
        uploadedOption.textContent = detail.title
        uploadedOption.disabled = uploadedOption.hidden = false
        if (requests.shouldActivate(detail.requestId)) {
          select.value = '__upload__'
          chooseSample()
        }
      }
      root.addEventListener('struct:preview-start', start)
      root.addEventListener('struct:preview-ready', ready)
      let animationFrame: number | undefined
      let observedWidth = viewport.clientWidth
      const observer = new ResizeObserver(() => {
        const width = viewport.clientWidth
        if (width === observedWidth) return
        observedWidth = width
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
        animationFrame = requestAnimationFrame(resize)
      })
      observer.observe(viewport)
      chooseSample()
      const cleanup = () => {
        active = false
        documentRevision += 1
        sampleAbort.abort()
        observer.disconnect()
        originalViewer.destroy()
        if (ownedPdf) URL.revokeObjectURL(ownedPdf)
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
        root.removeEventListener('struct:preview-ready', ready)
        root.removeEventListener('struct:preview-start', start)
      }
      document.addEventListener('astro:before-swap', cleanup, { once: true })
      window.addEventListener('pagehide', cleanup, { once: true })
    })
}
