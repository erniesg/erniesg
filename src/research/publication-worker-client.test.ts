import { describe, expect, it, vi } from 'vitest'
import { oversizedPdfFixture } from '../../tests/fixtures/pdf-fixtures'
import type { PublicationWorkerResponse } from './publication-worker-protocol'
import {
  buildEpubInWorker,
  createOwnedInlineWorker,
  reconstructPdfInWorker,
} from './publication-worker-client'

class SilentWorker {
  posted: Array<{ message: unknown; transfer: readonly Transferable[] }> = []
  terminated = false

  postMessage(message: unknown, transfer: readonly Transferable[]) {
    this.posted.push({ message, transfer })
  }

  terminate() {
    this.terminated = true
  }

  addEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject,
  ) {}

  removeEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject,
  ) {}
}

class RespondingWorker extends SilentWorker {
  private messageListener?: (
    event: MessageEvent<PublicationWorkerResponse>,
  ) => void

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    if (type === 'message') {
      this.messageListener = listener as (
        event: MessageEvent<PublicationWorkerResponse>,
      ) => void
    }
  }

  emit(response: PublicationWorkerResponse) {
    this.messageListener?.({
      data: response,
    } as MessageEvent<PublicationWorkerResponse>)
  }
}

class ThrowingWorker extends SilentWorker {
  error = new DOMException('The request could not be cloned.', 'DataCloneError')

  override postMessage(_message: unknown, _transfer: readonly Transferable[]) {
    throw this.error
  }
}

const inputFile = () =>
  new File([new Uint8Array([37, 80, 68, 70])], 'input.pdf', {
    type: 'application/pdf',
  })

describe('publication worker client', () => {
  it('revokes inline worker URLs after termination and failed construction', () => {
    const originalCreateObjectUrl = URL.createObjectURL
    const originalRevokeObjectUrl = URL.revokeObjectURL
    const created = vi.fn(() => 'blob:owned-publication-worker')
    const revoked = vi.fn()
    URL.createObjectURL = created
    URL.revokeObjectURL = revoked
    try {
      const worker = new SilentWorker()
      const ownedWorker = createOwnedInlineWorker(() => {
        URL.createObjectURL(new Blob())
        return worker as never
      })
      expect(URL.createObjectURL).toBe(created)
      expect(revoked).not.toHaveBeenCalled()

      ownedWorker.terminate()
      expect(worker.terminated).toBe(true)
      expect(revoked).toHaveBeenCalledWith('blob:owned-publication-worker')

      const constructionError = new Error('worker construction failed')
      expect(() =>
        createOwnedInlineWorker(() => {
          URL.createObjectURL(new Blob())
          throw constructionError
        }),
      ).toThrow(constructionError)
      expect(revoked).toHaveBeenCalledTimes(2)
      expect(URL.createObjectURL).toBe(created)
    } finally {
      URL.createObjectURL = originalCreateObjectUrl
      URL.revokeObjectURL = originalRevokeObjectUrl
    }
  })

  it('rejects an oversized browser upload before reading or starting a worker', async () => {
    let read = false
    const createWorker = vi.fn()

    await expect(
      reconstructPdfInWorker(
        oversizedPdfFixture(() => {
          read = true
        }),
        undefined,
        { createWorker },
      ),
    ).rejects.toMatchObject({ code: 'OVERSIZED_PDF' })

    expect(read).toBe(false)
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('honors cancellation before reading or starting a worker', async () => {
    let read = false
    const createWorker = vi.fn()
    const controller = new AbortController()
    controller.abort()
    const file = {
      ...inputFile(),
      size: 4,
      async arrayBuffer() {
        read = true
        return new ArrayBuffer(0)
      },
    } as File

    await expect(
      reconstructPdfInWorker(file, undefined, {
        signal: controller.signal,
        createWorker,
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })

    expect(read).toBe(false)
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('terminates the worker immediately when cancellation is requested', async () => {
    const worker = new SilentWorker()
    const controller = new AbortController()
    const pending = reconstructPdfInWorker(inputFile(), undefined, {
      signal: controller.signal,
      createWorker: () => worker as never,
    })
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(worker.terminated).toBe(true)
    expect(worker.posted[0].transfer).toHaveLength(1)
  })

  it('fails closed and terminates a worker that stops heartbeating', async () => {
    vi.useFakeTimers()
    try {
      const worker = new SilentWorker()
      const pending = reconstructPdfInWorker(inputFile(), undefined, {
        watchdogMs: 200,
        createWorker: () => worker as never,
      })
      const stalled = expect(pending).rejects.toMatchObject({
        code: 'CONVERSION_STALLED',
      })
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(300)

      await stalled
      expect(worker.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up when posting to the worker fails synchronously', async () => {
    vi.useFakeTimers()
    try {
      const worker = new ThrowingWorker()
      const pending = reconstructPdfInWorker(inputFile(), undefined, {
        createWorker: () => worker as never,
      })

      await expect(pending).rejects.toBe(worker.error)
      expect(worker.terminated).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts progress and a matching completed result after heartbeats', async () => {
    const worker = new RespondingWorker()
    const progress = vi.fn()
    const pending = reconstructPdfInWorker(inputFile(), progress, {
      createWorker: () => worker as never,
    })
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1))
    const request = worker.posted[0].message as { jobId: string }
    worker.emit({
      type: 'heartbeat',
      jobId: request.jobId,
      at: Date.now(),
      stage: 'convert-pdf',
    })
    worker.emit({
      type: 'progress',
      jobId: request.jobId,
      progress: {
        phase: 'reading-order',
        completed: 0,
        total: 0,
        message: 'Reconstructing logical prose…',
      },
    })
    const result = { marker: 'complete' }
    worker.emit({
      type: 'pdf-result',
      jobId: request.jobId,
      result: result as never,
    })

    await expect(pending).resolves.toBe(result)
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'reading-order' }),
    )
    expect(worker.terminated).toBe(true)
  })

  it('attaches the worker-compiled preview payload to the unchanged EPUB', async () => {
    const worker = new RespondingWorker()
    const pending = buildEpubInWorker({} as never, {} as never, 'publication', {
      createWorker: () => worker as never,
    })
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1))
    const request = worker.posted[0].message as { jobId: string }
    const result = {
      bytes: new Uint8Array([80, 75]),
      sha256: 'a'.repeat(64),
    }
    const preview = {
      template: { segments: ['<img src="', '">'], assetIndices: [0] },
      assets: [
        {
          href: 'assets/figure.png',
          mediaType: 'image/png',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    }
    worker.emit({
      type: 'epub-result',
      jobId: request.jobId,
      result: result as never,
      preview,
    } as PublicationWorkerResponse)

    const completed = await pending
    expect(completed).toEqual({ ...result, preview })
    expect(completed.bytes).toBe(result.bytes)
    expect(completed.sha256).toBe(result.sha256)
    expect(worker.terminated).toBe(true)
  })

  it('terminates an EPUB build worker without accepting a result after abort', async () => {
    const worker = new RespondingWorker()
    const controller = new AbortController()
    const pending = buildEpubInWorker({} as never, {} as never, 'publication', {
      signal: controller.signal,
      createWorker: () => worker as never,
    })
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1))
    const request = worker.posted[0].message as { jobId: string }
    controller.abort()
    worker.emit({
      type: 'epub-result',
      jobId: request.jobId,
      result: {} as never,
      preview: { template: { segments: [''], assetIndices: [] }, assets: [] },
    } as PublicationWorkerResponse)

    await expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' })
    expect(worker.terminated).toBe(true)
  })

  it('fails closed and terminates an outdated worker with no preview payload', async () => {
    const worker = new RespondingWorker()
    const pending = buildEpubInWorker({} as never, {} as never, 'publication', {
      createWorker: () => worker as never,
    })
    await vi.waitFor(() => expect(worker.posted).toHaveLength(1))
    const request = worker.posted[0].message as { jobId: string }
    worker.emit({
      type: 'epub-result',
      jobId: request.jobId,
      result: {
        bytes: new Uint8Array([80, 75]),
        sha256: 'b'.repeat(64),
      },
    } as unknown as PublicationWorkerResponse)

    await expect(pending).rejects.toThrow(
      'background worker returned no EPUB preview payload',
    )
    expect(worker.terminated).toBe(true)
  })
})
