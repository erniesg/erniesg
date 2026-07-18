#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createServer } from 'vite'

function parseArguments(args) {
  let output = '.agent/evidence/diagnostic-overlays'
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--output') {
      output = args[index + 1]
      index += 1
    } else if (argument.startsWith('--output=')) {
      output = argument.slice('--output='.length)
    } else {
      throw new Error('unknown argument')
    }
  }
  if (!output) throw new Error('missing output')
  return { output: resolve(output) }
}

function artifactName(file, suffix = 'overlays') {
  return `${basename(file, '.pdf').replaceAll(/[^a-z0-9-]+/gi, '-')}.${suffix}.html`
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  } catch {
    process.stderr.write(
      'Usage: node tools/pdf-diagnostic-evidence.mjs [--output <directory>]\n',
    )
    process.exitCode = 2
    return
  }
  const fixtureDirectory = resolve('tests/fixtures/pdf')
  const fixtureManifest = JSON.parse(
    await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8'),
  )
  const fixtures = fixtureManifest.fixtures
    .map((fixture) => fixture.file)
    .filter((file) => file.endsWith('.pdf') && !file.startsWith('virtual:'))
    .sort((left, right) => left.localeCompare(right))
  await mkdir(options.output, { recursive: true })

  const vite = await createServer({
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  try {
    const [{ reconstructPdf }, { renderDiagnosticEvidenceHtml }] =
      await Promise.all([
        vite.ssrLoadModule('/src/research/pdf.ts'),
        vite.ssrLoadModule('/src/research/diagnostic-overlays.ts'),
      ])
    const standardFontDataUrl = new URL(
      '../node_modules/pdfjs-dist/standard_fonts/',
      import.meta.url,
    ).href
    const records = []
    for (const fixture of fixtures) {
      const bytes = await readFile(join(fixtureDirectory, fixture))
      const result = await reconstructPdf(
        new File([bytes], fixture, {
          type: 'application/pdf',
          lastModified: 0,
        }),
        undefined,
        { standardFontDataUrl },
      )
      const afterName = artifactName(fixture)
      await writeFile(
        join(options.output, afterName),
        renderDiagnosticEvidenceHtml(result),
      )
      let beforeName = null
      if (fixture === 'diagnostic-overlays.pdf') {
        beforeName = artifactName(fixture, 'before')
        await writeFile(
          join(options.output, beforeName),
          renderDiagnosticEvidenceHtml(result, { overlays: false }),
        )
      }
      records.push({
        fixture,
        afterName,
        beforeName,
        diagnostics: [
          ...new Set(result.diagnostics.map((diagnostic) => diagnostic.code)),
        ].sort(),
      })
    }
    const rows = records
      .map(
        (record) =>
          `| ${record.fixture} | diagnostic-overlay-v1 | ${record.diagnostics.join(', ') || 'none'} | ${record.beforeName ? `[before](./${record.beforeName})` : 'n/a'} | [overlay](./${record.afterName}) |`,
      )
      .join('\n')
    const readme = `# SRT visual diagnostic evidence

Generated deterministically from the repository-owned CC0 PDF fixtures by
\`npm run srt:overlay-evidence\`. No downloaded or operator-supplied document
is eligible for this evidence directory.

The rule column identifies the renderer contract. The diagnostic column names
the reconstruction output demonstrated by each artifact. The before/overlay
pair for \`diagnostic-overlays.pdf\` shows the same source rendering before and
after \`diagnostic-overlay-v1\` adds inspectable geometry, note candidates, and
competing reading-order sequences.

| Fixture | Rule | Diagnostic | Before | After |
|---|---|---|---|---|
${rows}

Byte stability: these HTML files contain no timestamp, absolute path, random
identifier, or runtime version field. Changes are expected only when a fixture,
reconstruction rule, or overlay renderer changes.
`
    await writeFile(join(options.output, 'README.md'), readme)
    process.stdout.write(
      `Wrote ${records.length + 2} deterministic fixture overlay artifacts.\n`,
    )
  } finally {
    await vite.close()
  }
}

main().catch(() => {
  process.stderr.write('Fixture diagnostic evidence generation failed.\n')
  process.exitCode = 1
})
