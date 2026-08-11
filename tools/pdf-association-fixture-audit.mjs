#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'
import {
  auditAssociationReconstruction,
  serializeAssociationAudit,
  validateAssociationGroundTruth,
} from './pdf-association-fixture-audit-lib.mjs'

function parseArguments(argv) {
  let output = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--output') {
      output = argv[index + 1] ?? null
      index += 1
    } else if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (output !== null && !output.trim()) {
    throw new Error('Audit output path must be non-empty')
  }
  return { output: output ? resolve(output) : null }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function reconstructAndAudit(groundTruth, fixtureBytes) {
  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null },
  })
  try {
    const [pdfModule, epubModule, checkpointModule, targetModule] =
      await Promise.all([
        vite.ssrLoadModule('/src/research/pdf.ts'),
        vite.ssrLoadModule('/src/research/epub.ts'),
        vite.ssrLoadModule('/src/research/source-output-checkpoints.ts'),
        vite.ssrLoadModule('/src/research/targets.ts'),
      ])
    const fixtureName = groundTruth.fixture.split('/').at(-1)
    const reconstruction = await pdfModule.reconstructPdf(
      new File([fixtureBytes], fixtureName, {
        type: 'application/pdf',
        lastModified: 0,
      }),
      undefined,
      {
        language: 'en-US',
        standardFontDataUrl: new URL(
          '../node_modules/pdfjs-dist/standard_fonts/',
          import.meta.url,
        ).href,
      },
    )
    const audit = auditAssociationReconstruction(reconstruction, groundTruth)
    const html = epubModule.renderPublicationXhtml(reconstruction.paper, {
      reconstruction,
    })
    const checkpointSet = checkpointModule.parseSourceOutputCheckpointSet({
      schemaVersion: groundTruth.schemaVersion,
      checkpoints: groundTruth.checkpoints,
    })
    const checkpoints = checkpointSet.checkpoints.map((checkpoint) => {
      const sourcePage = reconstruction.pages.find(
        (page) => page.page === checkpoint.page,
      )
      return checkpointModule.evaluateSourceOutputCheckpoint(checkpoint, {
        source: {
          page: checkpoint.page,
          text: reconstruction.regions
            .filter((region) => region.page === checkpoint.page)
            .map((region) => region.text)
            .join(' '),
          hasVisual: (sourcePage?.objects?.length ?? 0) > 0,
        },
        rendition: {
          profile: checkpoint.profile,
          width: targetModule.getTargetProfile(checkpoint.profile).preview
            .widthCssPx,
          html,
        },
      })
    })
    const passed =
      audit.counters.falseLinkCount === 0 &&
      audit.counters.unresolvedAssociations === 0 &&
      audit.counters.verifiedAssociationRate === 1 &&
      checkpoints.every((checkpoint) => checkpoint.status === 'passed')
    return {
      schemaVersion: '1.0.0',
      status: passed ? 'passed' : 'failed',
      fixture: groundTruth.fixture,
      fixtureSha256: groundTruth.fixtureSha256,
      baselineRef: groundTruth.baselineRef,
      before: groundTruth.baselineCounters,
      after: audit.counters,
      checkpoints,
      associations: audit.associations,
      diagnosticCounts: audit.diagnosticCounts,
    }
  } finally {
    await vite.close()
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const groundTruthPath = resolve(
    'tests/fixtures/pdf/note-citation-associations.json',
  )
  const groundTruth = validateAssociationGroundTruth(
    JSON.parse(await readFile(groundTruthPath, 'utf8')),
  )
  const fixtureBytes = await readFile(resolve(groundTruth.fixture))
  const actualFixtureSha256 = sha256(fixtureBytes)
  if (actualFixtureSha256 !== groundTruth.fixtureSha256) {
    throw new Error(
      `Association fixture SHA-256 mismatch: expected ${groundTruth.fixtureSha256}, received ${actualFixtureSha256}`,
    )
  }
  const result = await reconstructAndAudit(groundTruth, fixtureBytes)
  const serialized = serializeAssociationAudit(result)
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, serialized)
  }
  process.stdout.write(serialized)
  if (result.status !== 'passed') process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(
    `PDF association fixture audit failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  )
  process.exitCode = 1
})
