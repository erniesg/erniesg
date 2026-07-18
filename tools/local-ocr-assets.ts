export const LOCAL_OCR_ASSET_FILES: ReadonlyMap<string, URL> = new Map([
  [
    'eng.traineddata.gz',
    new URL(
      '../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
      import.meta.url,
    ),
  ],
  [
    'tesseract-core-lstm.wasm.js',
    new URL(
      '../node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
      import.meta.url,
    ),
  ],
  [
    'tesseract-core-simd-lstm.wasm.js',
    new URL(
      '../node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
      import.meta.url,
    ),
  ],
  [
    'worker.min.js',
    new URL('../node_modules/tesseract.js/dist/worker.min.js', import.meta.url),
  ],
  [
    'worker.min.js.LICENSE.txt',
    new URL(
      '../node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt',
      import.meta.url,
    ),
  ],
  [
    'tesseract.js.LICENSE.md',
    new URL('../node_modules/tesseract.js/LICENSE.md', import.meta.url),
  ],
  [
    'tesseract.js-core.LICENSE',
    new URL('../node_modules/tesseract.js-core/LICENSE', import.meta.url),
  ],
  [
    'eng.LICENSE.txt',
    new URL('../docs/licenses/tesseract-eng-MIT.txt', import.meta.url),
  ],
])
