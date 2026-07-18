import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { LOCAL_OCR_ASSET_FILES } from './local-ocr-assets'

describe('local OCR distribution assets', () => {
  it('ships only the selected runtime files with complete adjacent notices', async () => {
    expect([...LOCAL_OCR_ASSET_FILES.keys()]).toEqual([
      'eng.traineddata.gz',
      'tesseract-core-lstm.wasm.js',
      'tesseract-core-simd-lstm.wasm.js',
      'worker.min.js',
      'worker.min.js.LICENSE.txt',
      'tesseract.js.LICENSE.md',
      'tesseract.js-core.LICENSE',
      'eng.LICENSE.txt',
    ])

    const assets = await Promise.all(
      [...LOCAL_OCR_ASSET_FILES].map(async ([name, source]) => ({
        name,
        bytes: await readFile(source),
      })),
    )
    expect(assets.every((asset) => asset.bytes.byteLength > 100)).toBe(true)
    expect(
      assets
        .filter((asset) => /LICENSE/.test(asset.name))
        .every((asset) =>
          /license|permission|apache/i.test(asset.bytes.toString()),
        ),
    ).toBe(true)
  })
})
