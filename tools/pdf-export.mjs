#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  auditPdfInputs,
  createCorpusReport,
  createPdfPipeline,
  serializeCorpusReport,
} from './pdf-corpus-audit-lib.mjs'

const DEFAULT_TARGETS = ['paperPro', 'paperProMove']
const encoder = new TextEncoder()
let temporaryFileSequence = 0

function usage() {
  return 'Usage: npm run pdf:export -- <pdf-or-directory> [--target <profile>]... --out <directory>\n'
}

function parseArguments(arguments_) {
  const inputs = []
  const targets = []
  let outputDirectory

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--target') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      targets.push(value)
      index += 1
      continue
    }
    if (argument.startsWith('--target=')) {
      targets.push(argument.slice('--target='.length))
      continue
    }
    if (argument === '--out') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) throw new Error('INVALID_USAGE')
      outputDirectory = value
      index += 1
      continue
    }
    if (argument.startsWith('--out=')) {
      outputDirectory = argument.slice('--out='.length)
      continue
    }
    if (argument.startsWith('--')) throw new Error('INVALID_USAGE')
    inputs.push(argument)
  }

  if (inputs.length === 0 || !outputDirectory) {
    throw new Error('INVALID_USAGE')
  }
  return {
    inputs,
    outputDirectory: resolve(outputDirectory),
    targets: [...new Set(targets.length > 0 ? targets : DEFAULT_TARGETS)],
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

function commandResult(command, arguments_, timeout = 10_000) {
  return spawnSync(command, arguments_, {
    stdio: 'ignore',
    timeout,
    windowsHide: true,
  })
}

async function epubCheckValidator() {
  const direct = commandResult('epubcheck', ['--version'])
  if (!direct.error && direct.status === 0) {
    return { kind: 'command', command: 'epubcheck', arguments: [] }
  }

  const java = commandResult('java', ['-version'])
  if (java.error || java.status !== 0) {
    return { kind: 'skipped', reason: 'java-unavailable' }
  }

  const jarCandidates = [
    process.env.EPUBCHECK_JAR,
    resolve('tools/epubcheck/epubcheck.jar'),
    '/usr/share/java/epubcheck.jar',
    '/usr/local/share/java/epubcheck.jar',
  ].filter(Boolean)
  for (const jar of jarCandidates) {
    try {
      await access(jar)
      return { kind: 'command', command: 'java', arguments: ['-jar', jar] }
    } catch {
      // Missing local validators are reported without exposing their paths.
    }
  }
  return { kind: 'skipped', reason: 'epubcheck-unavailable' }
}

async function validateWithEpubCheck(bytes, validator) {
  if (validator.kind === 'skipped') {
    return { status: 'skipped', reason: validator.reason }
  }

  const directory = await mkdtemp(join(tmpdir(), 'srt-epubcheck-'))
  const path = join(directory, 'publication.epub')
  try {
    await writeFile(path, bytes)
    const result = commandResult(
      validator.command,
      [...validator.arguments, path],
      120_000,
    )
    if (result.error || result.status !== 0) {
      throw new Error('EPUBCHECK_FAILED')
    }
    return { status: 'passed' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function safeStem(value) {
  return (
    basename(value, extname(value))
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-|-$/g, '') || 'publication'
  )
}

function documentOutputDirectory(root, document, documentCount) {
  if (documentCount === 1) return root
  return join(
    root,
    `${safeStem(document.basename)}-${document.sha256.slice(0, 12)}`,
  )
}

async function writeAtomically(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  temporaryFileSequence += 1
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${temporaryFileSequence}.tmp`,
  )
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function exportDocument({
  record,
  profiles,
  exportModules,
  validator,
  outputDirectory,
  documentCount,
}) {
  const artifacts = []
  for (const profile of profiles) {
    const epub = await exportModules.buildEpub(
      record.reconstruction.paper,
      record.reconstruction,
      profile,
    )
    exportModules.inspectEpub(epub.bytes, profile)
    artifacts.push({
      epub,
      metadata: {
        target: profile.id,
        basename: epub.fileName,
        byteLength: epub.bytes.byteLength,
        sha256: epub.sha256,
        structuralValidation: 'passed',
        epubCheck: await validateWithEpubCheck(epub.bytes, validator),
      },
    })
  }

  const manifest = {
    schemaVersion: '1.0.0',
    privacy: 'basename-hash-metrics-only',
    source: {
      basename: record.document.basename,
      sha256: record.document.sha256,
      byteLength: record.document.byteLength,
      pageCount: record.document.pageCount,
    },
    completeness: record.document.completeness,
    readiness: record.document.readiness,
    exports: artifacts.map(({ epub, metadata }) => ({
      ...metadata,
      profile: epub.profile,
    })),
    determinism: {
      volatileFields: [],
      guarantee:
        'Identical inputs, profiles, policy versions, dependency versions, and compatible runtimes produce byte-identical artifacts and reports.',
    },
  }
  const manifestBytes = jsonBytes(manifest)
  const checksumLines = [
    ...artifacts.map(({ epub }) => `${epub.sha256}  ${epub.fileName}`),
    `${sha256(manifestBytes)}  export-manifest.json`,
  ]
  const checksums = encoder.encode(`${checksumLines.join('\n')}\n`)
  const destination = documentOutputDirectory(
    outputDirectory,
    record.document,
    documentCount,
  )

  // All gates and validators finish before any artifact for this document is
  // published to the caller's output directory.
  for (const { epub } of artifacts) {
    await writeAtomically(join(destination, epub.fileName), epub.bytes)
  }
  await writeAtomically(
    join(destination, 'export-manifest.json'),
    manifestBytes,
  )
  await writeAtomically(join(destination, 'checksums.sha256'), checksums)
  return artifacts.map(({ metadata }) => metadata)
}

async function main() {
  let parsed
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(usage())
    process.exitCode = 2
    return
  }

  const pipeline = await createPdfPipeline()
  try {
    const records = await auditPdfInputs(parsed.inputs, pipeline)
    if (records.length === 0) {
      process.stderr.write('No local PDF inputs were found.\n')
      process.exitCode = 2
      return
    }

    const exportModules = await pipeline.loadExportModules()
    const unknownTarget = parsed.targets.find(
      (target) => !exportModules.targetProfileIds.includes(target),
    )
    if (unknownTarget) {
      process.stderr.write('An unknown local export target was requested.\n')
      process.exitCode = 2
      return
    }
    const profiles = parsed.targets.map(exportModules.getTargetProfile)
    const validator = await epubCheckValidator()
    for (const record of records) {
      if (!record.reconstruction?.readiness.ready) continue
      record.document.exports = await exportDocument({
        record,
        profiles,
        exportModules,
        validator,
        outputDirectory: parsed.outputDirectory,
        documentCount: records.length,
      })
    }

    const report = createCorpusReport(
      records.map((record) => record.document),
      pipeline.policy,
    )
    const serialized = serializeCorpusReport(report)
    await writeAtomically(
      join(parsed.outputDirectory, 'corpus-audit.json'),
      encoder.encode(serialized),
    )
    process.stdout.write(serialized)
    if (report.summary.reviewRequired > 0 || report.summary.failed > 0) {
      process.exitCode = 1
    }
  } finally {
    await pipeline.close()
  }
}

main().catch(() => {
  process.stderr.write(
    'PDF export failed without publishing local path or document details.\n',
  )
  process.exitCode = 2
})
