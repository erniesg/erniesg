import { expect, test } from 'vitest'

test('canonical inline ledger hashes external targets without retaining their URLs', async () => {
  const evidence = await import('./pdf-private-fidelity-evidence.mjs').catch(
    () => null,
  )
  expect(
    evidence,
    'the private fidelity evidence module must be available',
  ).toBeTruthy()

  const first = evidence.createInlineSemanticLedger([
    {
      id: 'section/one',
      text: 'Read more',
      inlineRuns: [
        {
          start: 0,
          end: 4,
          bold: true,
          href: 'https://example.test/research?q=one',
        },
      ],
    },
  ])
  const second = evidence.createInlineSemanticLedger([
    {
      id: 'section/one',
      text: 'Read more',
      inlineRuns: [
        {
          start: 0,
          end: 4,
          href: 'https://example.test/research?q=one',
          bold: true,
        },
      ],
    },
  ])

  expect(first.schemaVersion).toBe('1.0.0')
  expect(first.nodeCount).toBe(1)
  expect(first.semanticRangeCount).toBe(2)
  expect(first.relationshipCount).toBe(1)
  expect(first.relationshipTargetCount).toBe(1)
  expect(first.semanticRangeLedgerSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(first.relationshipTargetLedgerSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(first)).not.toContain('example.test')
  expect(first).toEqual(second)
})
