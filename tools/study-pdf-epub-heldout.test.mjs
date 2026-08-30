import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifestUrl = new URL(
  '../tests/fixtures/pdf/study-pdf-epub-heldout-v1.json',
  import.meta.url,
)

test('the v1 Study holdout registry is fixed, complete, and content-addressed', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  assert.equal(manifest.corpusId, 'study-pdf-epub-heldout-v1')
  assert.equal(manifest.cases.length, 12)
  assert.match(manifest.policy, /immutable/u)
  assert.deepEqual(
    [...new Set(manifest.cases.map((entry) => entry.file))].length,
    manifest.cases.length,
  )
  for (const entry of manifest.cases) {
    const bytes = await readFile(new URL(entry.file, manifestUrl))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
    assert.ok(['epub', 'reject'].includes(entry.expect))
    if (entry.expect === 'reject') assert.match(entry.code, /^[A-Z_]+$/u)
  }
})
