#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import {
  createExtractionArchitectureDecision,
  EXTRACTION_BAKEOFF_STRATA,
  runExtractionBakeoff,
} from '../src/research/extraction-bakeoff.ts'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function context(id, split, layout) {
  return {
    documentId: id,
    sourceSha256: id.startsWith('development') ? SHA_A : SHA_B,
    split,
    layout,
    sourceRuns: [
      { id: `${id}-title`, text: 'Synthetic title', page: 1, order: 1 },
      {
        id: `${id}-body`,
        text: 'Synthetic source paragraph.',
        page: 1,
        order: 2,
      },
    ],
    sourceAssets: [],
  }
}

function proposal(input, quality = 'complete') {
  const nodes = [
    {
      id: `${input.documentId}-title`,
      type: 'title',
      sourceRunIds: [`${input.documentId}-title`],
    },
    {
      id: `${input.documentId}-body`,
      type: 'paragraph',
      sourceRunIds: [`${input.documentId}-body`],
    },
  ]
  if (quality === 'baseline') nodes.pop()
  if (quality === 'authored')
    nodes[1].text = 'Model-authored text that cannot be verified.'
  return {
    schemaVersion: '1.0.0',
    nodes,
  }
}

function makeCorpus() {
  const documents = [
    ['development-one', 'development', 'one-column'],
    ['heldout-one', 'held-out', 'one-column'],
    ['heldout-two', 'held-out', 'two-column'],
  ].map(([id, split, layout]) => {
    const source = context(id, split, layout)
    return {
      id,
      split,
      layout,
      context: source,
      cases: EXTRACTION_BAKEOFF_STRATA.map((stratum) => ({
        id: `${id}-${stratum}`,
        documentId: id,
        stratum,
        layout,
        expectedNodeTypes: ['title', 'paragraph'],
        expectedSourceRunIds: [`${id}-title`, `${id}-body`],
      })),
    }
  })
  return {
    id: 'synthetic-extraction-bakeoff-v1',
    development: documents.filter(({ split }) => split === 'development'),
    heldOut: documents.filter(({ split }) => split === 'held-out'),
  }
}

function arm(id) {
  return {
    id,
    identity: {
      providerId: id,
      modelId: `${id}-model`,
      modelVersion: 'fixture-1.0.0',
      modelDigest: SHA_A,
      promptHash: SHA_B,
    },
    tunedOn: ['development'],
    run: async (input) => ({
      proposal: proposal(
        input,
        id === 'geometric-baseline'
          ? 'baseline'
          : id === 'llm-authored'
            ? 'authored'
            : 'complete',
      ),
      metrics: { latencyMs: 1, costUsd: 0 },
    }),
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (!args.includes('--self-test')) {
    process.stderr.write(
      'Usage: node --experimental-strip-types tools/pdf-extraction-bakeoff.mjs --self-test [--out <path>]\n',
    )
    process.exitCode = 2
    return
  }
  const report = await runExtractionBakeoff({
    corpus: makeCorpus(),
    arms: [arm('geometric-baseline'), arm('llm-authored'), arm('llm-grounded')],
  })
  const decision = createExtractionArchitectureDecision({ report })
  const payload = `${JSON.stringify({ report, decision }, null, 2)}\n`
  const outIndex = args.indexOf('--out')
  if (outIndex >= 0) {
    const outputPath = args[outIndex + 1]
    if (!outputPath) throw new Error('--out requires a path')
    await writeFile(outputPath, payload, 'utf8')
  } else {
    process.stdout.write(payload)
  }
  const reportOutIndex = args.indexOf('--report-out')
  if (reportOutIndex >= 0) {
    const reportPath = args[reportOutIndex + 1]
    if (!reportPath) throw new Error('--report-out requires a path')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  const decisionOutIndex = args.indexOf('--decision-out')
  if (decisionOutIndex >= 0) {
    const decisionPath = args[decisionOutIndex + 1]
    if (!decisionPath) throw new Error('--decision-out requires a path')
    await writeFile(
      decisionPath,
      `${JSON.stringify(decision, null, 2)}\n`,
      'utf8',
    )
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Extraction bake-off failed.'}\n`,
  )
  process.exitCode = 1
})
