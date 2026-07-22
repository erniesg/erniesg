#!/usr/bin/env node
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import {
  auditPdfPath,
  createCorpusReport,
  createPdfPipeline,
  pdfPaths,
  serializeCorpusReport,
} from './pdf-corpus-audit-lib.mjs'

function parseArguments(args) {
  let reportOnly = false
  let overlayOutput = null
  const inputs = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--report-only') {
      reportOnly = true
    } else if (argument === '--overlay-output') {
      overlayOutput = args[index + 1] ?? null
      index += 1
    } else if (argument.startsWith('--overlay-output=')) {
      overlayOutput = argument.slice('--overlay-output='.length)
    } else if (argument.startsWith('--')) {
      throw new Error('unknown option')
    } else {
      inputs.push(argument)
    }
  }
  if (overlayOutput === '') throw new Error('missing overlay output')
  return { reportOnly, overlayOutput, inputs }
}

let cli
try {
  cli = parseArguments(process.argv.slice(2))
} catch {
  process.stderr.write(
    'Usage: npm run pdf:corpus-audit -- [--report-only] [--overlay-output <local-directory>] <pdf-or-directory> [...]\n',
  )
  process.exit(2)
}
const { reportOnly, overlayOutput, inputs } = cli

async function privateOverlayDirectory(requested) {
  const repository = await realpath('.')
  const target = resolve(requested)
  if (target === parse(target).root) throw new Error('unsafe output')
  let existing = target
  let resolvedExisting
  while (true) {
    try {
      resolvedExisting = await realpath(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) throw new Error('unsafe output')
      existing = parent
    }
  }
  const resolvedTarget = resolve(resolvedExisting, relative(existing, target))
  const repositoryRelative = relative(repository, resolvedTarget)
  const insideRepository =
    repositoryRelative === '' ||
    (!repositoryRelative.startsWith(`..${sep}`) &&
      repositoryRelative !== '..' &&
      !isAbsolute(repositoryRelative))
  if (insideRepository) throw new Error('unsafe output')
  await mkdir(resolvedTarget, { recursive: true, mode: 0o700 })
  return resolvedTarget
}

function overlayArtifactName(fileName, hash) {
  const safeName = basename(fileName, extname(fileName))
    .replaceAll(/[^a-z0-9-]+/gi, '-')
    .replaceAll(/^-|-$/g, '')
  return `${safeName || 'document'}-${hash.slice(0, 16)}.diagnostics.html`
}

async function main() {
  if (inputs.length === 0) {
    process.stderr.write(
      'Usage: npm run pdf:corpus-audit -- [--report-only] [--overlay-output <local-directory>] <pdf-or-directory> [...]\n',
    )
    process.exitCode = 2
    return
  }

  let localOverlayOutput = null
  if (overlayOutput) {
    try {
      localOverlayOutput = await privateOverlayDirectory(overlayOutput)
    } catch {
      process.stderr.write(
        'Overlay output must name a local directory outside the repository.\n',
      )
      process.exitCode = 2
      return
    }
  }

  const pipeline = await createPdfPipeline()
  try {
    const documents = []
    const diagnosticModules = localOverlayOutput
      ? await pipeline.loadDiagnosticModules()
      : null
    for (const path of await pdfPaths(inputs)) {
      const record = await auditPdfPath(path, pipeline)
      if (localOverlayOutput && diagnosticModules && record.reconstruction) {
        await writeFile(
          resolve(
            localOverlayOutput,
            overlayArtifactName(
              record.document.basename,
              record.reconstruction.source.sha256,
            ),
          ),
          diagnosticModules.renderDiagnosticEvidenceHtml(record.reconstruction),
          { mode: 0o600 },
        )
      }
      // Retain only the privacy-safe report row. Full reconstructions include
      // source assets and diagnostic SVGs that can otherwise accumulate across
      // a corpus-sized overlay run and exhaust the local process heap.
      documents.push(record.document)
    }
    documents.sort(
      (left, right) =>
        left.basename.localeCompare(right.basename) ||
        String(left.sha256).localeCompare(String(right.sha256)),
    )
    const report = createCorpusReport(documents, pipeline.policy)
    process.stdout.write(serializeCorpusReport(report))
    if (
      !reportOnly &&
      (report.summary.reviewRequired > 0 || report.summary.failed > 0)
    ) {
      process.exitCode = 1
    }
  } finally {
    await pipeline.close()
  }
}

main().catch(() => {
  process.stderr.write(
    'PDF corpus audit failed without publishing local path details.\n',
  )
  process.exitCode = 2
})
