import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const routePath = fileURLToPath(
  new URL('../../pages/study/experiments/pdf-to-epub.astro', import.meta.url),
)

describe('the canonical Study PDF to EPUB route', () => {
  it('uses the browser-local PublicationImporter and stays out of search indexes', () => {
    const source = readFileSync(routePath, 'utf8')

    expect(source).toContain(
      "import PublicationImporter from '@/components/research/PublicationImporter'",
    )
    expect(source).toContain(
      'canonicalPath="/study/experiments/pdf-to-epub"',
    )
    expect(source).toMatch(/<Layout[\s\S]*?noindex/)
    expect(source).toMatch(/conversion[^<]*browser/i)
    expect(source).toContain(
      '<PublicationImporter showIntro={false} client:load />',
    )
  })
})
