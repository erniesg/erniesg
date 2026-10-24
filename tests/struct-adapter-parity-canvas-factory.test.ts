import { readFile } from 'node:fs/promises'
import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { reconstructPdf } from '../src/research/pdf'
import type { PdfCanvasFactory } from '../src/research/pdf-page-crop'

const sourceUrl = new URL(
  './fixtures/pdf/source-output-checkpoints.pdf',
  import.meta.url,
)

describe('reconstructPdf canvas factory injection', () => {
  it('rasterizes page crops through an injected factory', async () => {
    let created = 0
    const factory: PdfCanvasFactory = {
      create(width, height) {
        created += 1
        const canvas = createCanvas(width, height)
        return {
          canvas,
          context: canvas.getContext('2d'),
        } as unknown as ReturnType<PdfCanvasFactory['create']>
      },
      destroy() {},
    }

    const bytes = await readFile(sourceUrl)
    const file = new File([bytes], 'source-output-checkpoints.pdf', {
      type: 'application/pdf',
    })

    await reconstructPdf(file, undefined, { canvasFactory: factory })

    expect(created).toBeGreaterThan(0)
  })
})
