import { readFile } from 'node:fs/promises'
import { MAX_LOCAL_PDF_BYTES } from '../../src/research/import-types'

export async function fixtureFile(name: string) {
  const bytes = await readFile(new URL(`./pdf/${name}`, import.meta.url))
  return new File([bytes], name, {
    type: 'application/pdf',
    lastModified: Date.UTC(2026, 6, 14),
  })
}

export function oversizedPdfFixture(onRead: () => void) {
  return {
    name: 'oversized-input.pdf',
    type: 'application/pdf',
    size: MAX_LOCAL_PDF_BYTES + 1,
    lastModified: Date.UTC(2026, 6, 14),
    async arrayBuffer() {
      onRead()
      return new ArrayBuffer(0)
    },
  } as File
}
