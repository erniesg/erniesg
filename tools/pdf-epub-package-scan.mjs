#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { strFromU8 } from 'fflate'
import { createServer } from 'vite'

const USAGE =
  'Usage: node tools/pdf-epub-package-scan.mjs --receipt <corpus-regeneration-receipt.json> --out <scan.json>\n'

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--receipt' && argument !== '--out') {
      throw new Error(`Unknown argument ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    options[argument.slice(2)] = value
    index += 1
  }
  if (!options.receipt || !options.out) throw new Error(USAGE.trim())
  return options
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function xmlAttributeCount(value, names) {
  const expression = new RegExp(
    `\\b(?:${names.join('|')})\\s*=\\s*(?:\"[^\"]*\"|'[^']*')`,
    'giu',
  )
  return [...value.matchAll(expression)].length
}

function manifestItemCount(value) {
  return [...value.matchAll(/<item\b[^>]*>/giu)].length
}

function javascriptFindings(files) {
  const findings = []
  for (const [name, bytes] of Object.entries(files)) {
    if (/\.(?:c|m)?js$/iu.test(name)) findings.push(`script entry: ${name}`)
    if (!/\.(?:xhtml|html|opf)$/iu.test(name)) continue
    const value = strFromU8(bytes)
    if (/<script\b/iu.test(value)) findings.push(`script element: ${name}`)
    if (/\bon[a-z]+\s*=/iu.test(value)) {
      findings.push(`inline event handler: ${name}`)
    }
    if (/\bjavascript\s*:/iu.test(value)) {
      findings.push(`javascript URL: ${name}`)
    }
    if (
      /<item\b[^>]*\bmedia-type\s*=\s*(?:["'](?:application|text)\/javascript["'])/iu.test(
        value,
      )
    ) {
      findings.push(`script manifest item: ${name}`)
    }
  }
  return findings
}

function profileEntries(receipt) {
  return receipt.documents.flatMap((document) =>
    document.profiles
      .filter(({ artifact }) => artifact)
      .map((profile) => ({
        documentId: document.id,
        profile: profile.id,
        artifact: profile.artifact,
      })),
  )
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const receiptPath = resolve(options.receipt)
  const receiptRoot = dirname(receiptPath)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const server = await createServer({
    root: process.cwd(),
    server: { middlewareMode: true, watch: null },
    appType: 'custom',
    logLevel: 'silent',
  })
  try {
    const { inspectEpub, readerFacingDebugMarkers } =
      await server.ssrLoadModule('/src/research/epub.ts')
    const { getTargetProfile } = await server.ssrLoadModule(
      '/src/research/targets.ts',
    )
    const results = []
    for (const entry of profileEntries(receipt)) {
      const bytes = new Uint8Array(
        await readFile(resolve(receiptRoot, entry.artifact.relativePath)),
      )
      const integrityFailures = []
      if (bytes.byteLength !== entry.artifact.byteLength) {
        integrityFailures.push('artifact byte length does not match receipt')
      }
      const artifactSha256 = sha256(bytes)
      if (artifactSha256 !== entry.artifact.sha256) {
        integrityFailures.push('artifact SHA-256 does not match receipt')
      }

      const structuralFailures = []
      let inspection
      try {
        inspection = inspectEpub(bytes, getTargetProfile(entry.profile))
      } catch (error) {
        structuralFailures.push(
          error instanceof Error ? error.message : String(error),
        )
      }
      const files = inspection?.files ?? {}
      const xhtml = Object.entries(files).filter(([name]) =>
        name.endsWith('.xhtml'),
      )
      const opf = files['EPUB/package.opf']
        ? strFromU8(files['EPUB/package.opf'])
        : ''
      const assetReferencesChecked = xhtml.reduce(
        (total, [, value]) =>
          total + xmlAttributeCount(strFromU8(value), ['src', 'data']),
        0,
      )
      const hrefsChecked = xhtml.reduce(
        (total, [, value]) =>
          total + xmlAttributeCount(strFromU8(value), ['href', 'src', 'data']),
        0,
      )
      const markerFindings = xhtml.flatMap(([name, value]) =>
        readerFacingDebugMarkers(strFromU8(value)).map(
          (finding) => `${name}: ${finding}`,
        ),
      )
      const scriptFindings = javascriptFindings(files)
      results.push({
        set: receipt.identity.contract.setId,
        documentId: entry.documentId,
        profile: entry.profile,
        artifactSha256,
        archiveEntries: inspection?.entries.length ?? 0,
        manifestItemsChecked: manifestItemCount(opf),
        assetReferencesChecked,
        assetFailures: [...integrityFailures, ...structuralFailures],
        hrefsChecked,
        hrefFailures: structuralFailures,
        markerFindings,
        javascriptFindings: scriptFindings,
        passed:
          integrityFailures.length === 0 &&
          structuralFailures.length === 0 &&
          markerFindings.length === 0 &&
          scriptFindings.length === 0,
      })
    }
    const totals = results.reduce(
      (summary, result) => {
        summary.artifacts += 1
        summary[result.passed ? 'passed' : 'failed'] += 1
        summary.manifestItemsChecked += result.manifestItemsChecked
        summary.assetReferencesChecked += result.assetReferencesChecked
        summary.assetFailures += result.assetFailures.length
        summary.hrefsChecked += result.hrefsChecked
        summary.hrefFailures += result.hrefFailures.length
        summary.markerFindings += result.markerFindings.length
        summary.javascriptFindings += result.javascriptFindings.length
        return summary
      },
      {
        artifacts: 0,
        passed: 0,
        failed: 0,
        manifestItemsChecked: 0,
        assetReferencesChecked: 0,
        assetFailures: 0,
        hrefsChecked: 0,
        hrefFailures: 0,
        markerFindings: 0,
        javascriptFindings: 0,
      },
    )
    const report = {
      schemaVersion: '1.0.0',
      scanner:
        'deterministic-archive-asset-href-fragment-reader-marker-and-javascript-scan-v1',
      receiptSha256: receipt.receiptSha256,
      totals,
      results,
    }
    await writeFile(
      resolve(options.out),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    process.stdout.write(`${JSON.stringify(totals)}\n`)
    if (totals.failed > 0) process.exitCode = 1
  } finally {
    await server.close()
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exitCode = 2
})
