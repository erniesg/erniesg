import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  PRIVATE_PDF_EPUB_FILE_NAME,
  convertPrivatePdfToEpub,
  safePrivatePdfEpubError,
  safePrivatePdfEpubProgress,
} from '../../research/private-pdf-epub-bridge'

type BridgeState =
  | { status: 'idle' }
  | { status: 'processing'; message: string }
  | { status: 'ready'; downloadUrl: string }
  | { status: 'error'; code: string; message: string }

export default function PrivatePdfEpubBridge() {
  const [state, setState] = useState<BridgeState>({ status: 'idle' })
  const input = useRef<HTMLInputElement>(null)
  const activeConversion = useRef<AbortController>()
  const activeDownloadUrl = useRef<string>()

  const revokeDownload = () => {
    if (!activeDownloadUrl.current) return
    URL.revokeObjectURL(activeDownloadUrl.current)
    activeDownloadUrl.current = undefined
  }

  useEffect(
    () => () => {
      activeConversion.current?.abort()
      revokeDownload()
    },
    [],
  )

  const reset = () => {
    activeConversion.current?.abort()
    activeConversion.current = undefined
    revokeDownload()
    if (input.current) input.current.value = ''
    setState({ status: 'idle' })
  }

  const convert = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    activeConversion.current?.abort()
    revokeDownload()
    const controller = new AbortController()
    activeConversion.current = controller
    setState({
      status: 'processing',
      message: 'Reading the PDF locally…',
    })
    try {
      const result = await convertPrivatePdfToEpub(file, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (activeConversion.current === controller)
            setState({
              status: 'processing',
              message: safePrivatePdfEpubProgress(progress),
            })
        },
      })
      if (activeConversion.current !== controller || controller.signal.aborted)
        return
      const downloadUrl = URL.createObjectURL(
        new Blob([result.bytes as BlobPart], { type: result.mediaType }),
      )
      activeDownloadUrl.current = downloadUrl
      setState({ status: 'ready', downloadUrl })
    } catch (error) {
      if (activeConversion.current !== controller) return
      const safe = safePrivatePdfEpubError(error)
      setState({ status: 'error', ...safe })
    } finally {
      if (activeConversion.current === controller)
        activeConversion.current = undefined
    }
  }

  return (
    <section
      className="flex max-w-2xl flex-col gap-y-6 rounded-lg border p-6"
      aria-labelledby="private-pdf-epub-heading"
      data-conversion-status={state.status}
    >
      <div className="flex flex-col gap-y-2">
        <h2 id="private-pdf-epub-heading" className="text-xl font-semibold">
          Choose one local PDF
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Your PDF stays in this browser. It is read into memory, anonymized
          before reconstruction, and is not saved or uploaded.
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Password-protected, malformed, active-content, incomplete, or
          review-required documents stop without an EPUB. This bounded bridge
          does not claim arbitrary-PDF readiness.
        </p>
      </div>

      {state.status === 'idle' && (
        <label className="flex cursor-pointer flex-col gap-y-2 rounded-md border border-dashed p-5">
          <strong>Choose a PDF</strong>
          <span className="text-sm text-muted-foreground">Up to 50 MiB</span>
          <input
            ref={input}
            className="mt-2"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => void convert(event)}
          />
        </label>
      )}

      {state.status === 'processing' && (
        <div aria-live="polite" aria-busy="true" className="flex gap-x-3">
          <progress aria-label={state.message} />
          <span>{state.message}</span>
          <button type="button" onClick={reset} className="underline">
            Cancel
          </button>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="flex flex-col items-start gap-y-3" aria-live="polite">
          <p>The deterministic EPUB passed the local package checks.</p>
          <a
            href={state.downloadUrl}
            download={PRIVATE_PDF_EPUB_FILE_NAME}
            className="font-medium underline underline-offset-4"
          >
            Download safe EPUB
          </a>
          <button type="button" onClick={reset} className="text-sm underline">
            Convert another PDF
          </button>
        </div>
      )}

      {state.status === 'error' && (
        <div role="alert" className="flex flex-col items-start gap-y-3">
          <strong>{state.code.replaceAll('_', ' ')}</strong>
          <p>{state.message}</p>
          <button type="button" onClick={reset} className="text-sm underline">
            Choose another PDF
          </button>
        </div>
      )}
    </section>
  )
}
