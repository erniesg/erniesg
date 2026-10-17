import { readFile } from 'node:fs/promises'
import { reconstructDocx } from '../../../src/research/docx-import'
import { reconstructPdf } from '../../../src/research/pdf'
import type { DocumentReconstruction } from '../../../src/research/import-types'
import { decodeReconstruction } from './observe'

const sources = {
  'structured-docx': {
    path: '../docx/structured-manuscript.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  'ordinary-pdf': {
    path: '../pdf/born-digital.pdf',
    type: 'application/pdf',
  },
  'source-preserved-pdf': {
    path: '../pdf/source-output-checkpoints.pdf',
    type: 'application/pdf',
  },
} as const

export type AdapterCase = keyof typeof sources
export const adapterCases = Object.keys(sources) as AdapterCase[]

/**
 * Reconstruct a case from its source file. Page crops are rasterized through
 * pdf.js's Skia-backed canvas, so the bytes (and therefore the frozen parity
 * snapshot) differ between CPU architectures; the fixtures under
 * `reconstructions/` are generated once with this function and then loaded
 * verbatim by the parity test so the suite stays deterministic everywhere.
 */
export async function reconstructAdapterCase(
  name: AdapterCase,
): Promise<DocumentReconstruction> {
  const source = sources[name]
  const bytes = await readFile(new URL(source.path, import.meta.url))
  const file = new File([bytes], source.path.split('/').at(-1)!, {
    type: source.type,
  })
  return name === 'structured-docx'
    ? reconstructDocx(file)
    : reconstructPdf(file)
}

export async function loadAdapterCase(
  name: AdapterCase,
): Promise<DocumentReconstruction> {
  const text = await readFile(
    new URL(`./reconstructions/${name}.json`, import.meta.url),
    'utf8',
  )
  return decodeReconstruction(text)
}
