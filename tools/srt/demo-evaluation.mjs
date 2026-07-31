#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createServer } from 'vite'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EVALUATION_DIRECTORY = join(
  REPO_ROOT,
  'docs/research/semantic-responsive-typesetting/evaluation',
)
const DEFAULT_WARM_ITERATIONS = 50

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}

function percentile(sorted, fraction) {
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ]
}

function milliseconds(value) {
  return Number(value.toFixed(6))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function run(command, args, environment = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed ${signal ? `with signal ${signal}` : `with exit ${code}`}`,
        ),
      )
    })
  })
}

function measureCompositions(buildLayoutManifest, paper, targets) {
  return Object.fromEntries(
    targets.map((target) => {
      const coldStart = performance.now()
      buildLayoutManifest(paper, [target])
      const coldMs = performance.now() - coldStart

      buildLayoutManifest(paper, [target])
      const warm = []
      for (let index = 0; index < DEFAULT_WARM_ITERATIONS; index += 1) {
        const start = performance.now()
        buildLayoutManifest(paper, [target])
        warm.push(performance.now() - start)
      }
      warm.sort((left, right) => left - right)

      return [
        target,
        {
          coldMs: milliseconds(coldMs),
          warmIterations: DEFAULT_WARM_ITERATIONS,
          warmMedianMs: milliseconds(percentile(warm, 0.5)),
          warmP95Ms: milliseconds(percentile(warm, 0.95)),
        },
      ]
    }),
  )
}

function percentage(value) {
  return `${(value * 100).toFixed(1)}%`
}

function geometryCount(target, key) {
  return target.browserGeometry.status === 'measured'
    ? String(target.browserGeometry[key])
    : 'unmeasured'
}

function renderBenchmarkReport(result) {
  const rows = result.targets
    .map(
      (target) =>
        `| ${target.target} | ${percentage(target.structuralCoverage.ratio)} (${target.structuralCoverage.preserved}/${target.structuralCoverage.expected}) | ${percentage(target.relationshipPreservation.ratio)} (${target.relationshipPreservation.preserved}/${target.relationshipPreservation.expected}) | ${geometryCount(target, 'clippedElements')} | ${geometryCount(target, 'overlapPairs')} | ${percentage(target.annotationSurvival.ratio)} (${target.annotationSurvival.preserved}/${target.annotationSurvival.expected}) | ${percentage(target.anchorStability.ratio)} (${target.anchorStability.stable}/${target.anchorStability.expected}) | ${target.fallbacks.total} | ${target.compositionTime.coldMs.toFixed(3)} | ${target.compositionTime.warmMedianMs.toFixed(3)} / ${target.compositionTime.warmP95Ms.toFixed(3)} |`,
    )
    .join('\n')
  const fixed = result.baselines.find((baseline) => baseline.id === 'fixed-pdf')

  return `# SRT engineering benchmark report

Generated ${result.runtime.generatedAt} from the machine-readable [results](./results.json).

## Result

One trusted structured fixture (${result.subject.canonicalNodes} nodes, ${result.subject.canonicalRelationships} relationship, ${result.subject.annotations} annotations) was evaluated across four target profiles. This is a POC engineering sample, not a corpus or user study.

| Target | Structure | Relationships | Clipped | Overlaps | Annotations | Anchors | Fallbacks | Cold ms | Warm median / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

Browser geometry used Chromium ${result.browserRuntime.browserVersion} at ${result.browserRuntime.viewport.width} × ${result.browserRuntime.viewport.height} CSS px and ${result.browserRuntime.deviceScaleFactor}× device scale. Clipping used a ${result.geometryTolerances.geometryCssPx} CSS px tolerance; horizontal overflow used ${result.geometryTolerances.overflowCssPx} CSS px. Zero counts mean the inspected golden rendition had no detected failure, not that the renderer is universally safe.

## Representation comparison

| Representation | Availability | What was compared | Boundary |
| --- | --- | --- | --- |
| Fixed PDF | Available, limited | Deterministic ${fixed.evidence.pageCount}-page export (${fixed.evidence.byteLength} bytes; SHA-256 \`${fixed.evidence.sha256}\`) | Generated from the same semantic fixture; not an independent ingestion baseline |
| Geometric reflow | Unavailable | No score reported | The repository has no same-content geometric-reflow implementation or validated output |
| Semantic rendition | Available, measured | Structure, relationships, browser geometry, annotations, anchors, fallbacks, and composition time across four targets | One trusted fixture only |

The unavailable geometric baseline is deliberately left blank; this report does not manufacture proxy results.

## Runtime and timing protocol

- Host: ${result.runtime.platform} ${result.runtime.osRelease}, ${result.runtime.architecture}, ${result.runtime.cpuModel}, ${result.runtime.logicalCpuCount} logical CPUs, ${result.runtime.totalMemoryMiB} MiB memory.
- Runtime: Node ${result.runtime.node}; V8 ${result.runtime.v8}.
- Cold: ${result.method.cold}
- Warm: ${result.method.warm}
- Browser: ${result.method.geometry}

The low-millisecond composition figures are microbenchmarks and should be read as reference-machine diagnostics, not user-visible end-to-end latency.

## Research qualification

${result.novelty.claim} Publication-facing language must remain qualified as **“${result.novelty.qualification}”** until the listed database search, screening, and citation-chaining work is complete.

See [limitations](./limitations.md), [ADR index](./adr-index.md), [evidence manifest](./evidence-manifest.json), and [reproducibility instructions](./README.md).
`
}

async function renderAdrIndex() {
  const directory = join(REPO_ROOT, 'docs/adr')
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right))
  const rows = []
  for (const file of files) {
    const value = await readFile(join(directory, file), 'utf8')
    const title = value.match(/^# (.+)$/m)?.[1] ?? file
    const status =
      value.match(/^## Status\s+([^\n]+)/m)?.[1]?.trim() ??
      value.match(/^- Status:\s*(.+)$/m)?.[1]?.trim() ??
      'Not recorded'
    rows.push(`| [${title}](../../../adr/${file}) | ${status} |`)
  }

  return `# SRT ADR index

This index is generated by \`tools/srt/demo-evaluation.mjs\` from the repository's current ADR set.

| Decision | Status |
| --- | --- |
${rows.join('\n')}
`
}

async function writeEvaluationPackage(result, geometry) {
  await mkdir(EVALUATION_DIRECTORY, { recursive: true })
  const resultPath = join(EVALUATION_DIRECTORY, 'results.json')
  const reportPath = join(EVALUATION_DIRECTORY, 'benchmark-report.md')
  const adrIndexPath = join(EVALUATION_DIRECTORY, 'adr-index.md')
  const geometryPath = join(EVALUATION_DIRECTORY, 'geometry-results.json')
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  await writeFile(reportPath, renderBenchmarkReport(result))
  await writeFile(adrIndexPath, await renderAdrIndex())
  await writeFile(geometryPath, `${JSON.stringify(geometry, null, 2)}\n`)

  const artifactPaths = [
    'docs/research/semantic-responsive-typesetting/evaluation/README.md',
    'docs/research/semantic-responsive-typesetting/evaluation/benchmark-report.md',
    'docs/research/semantic-responsive-typesetting/evaluation/results.json',
    'docs/research/semantic-responsive-typesetting/evaluation/geometry-results.json',
    'docs/research/semantic-responsive-typesetting/evaluation/limitations.md',
    'docs/research/semantic-responsive-typesetting/evaluation/adr-index.md',
    'src/research/evaluation.ts',
    'src/research/evaluation.test.ts',
    'src/research/papers/semantic-responsive-typesetting.json',
    'src/research/annotations.ts',
    'src/research/canonical-hash.ts',
    'src/research/composition.ts',
    'src/research/export-pdf.ts',
    'src/research/manifest.ts',
    'src/research/pagination.ts',
    'src/research/targets.ts',
    'src/components/research/ResearchStudio.tsx',
    'src/styles/global.css',
    'tools/srt/demo-evaluation.mjs',
    'tests/e2e/srt-visual.spec.ts',
    'tests/e2e/static-build.ts',
    'tests/e2e/publication-importer.spec.ts',
    'playwright.config.ts',
    'package.json',
    'package-lock.json',
  ]
  const artifacts = []
  for (const path of artifactPaths) {
    const bytes = await readFile(join(REPO_ROOT, path))
    artifacts.push({
      path,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    })
  }
  const evidenceManifest = {
    schemaVersion: '1.0.0',
    issue: 9,
    generatedAt: result.runtime.generatedAt,
    scope: 'SRT POC engineering evaluation package',
    artifacts,
    validationCommands: [
      'npm test',
      'npm run build',
      'npm run srt:evaluate',
      'scripts/agent-evidence --all',
      'git diff --check',
    ],
    caveat:
      'Command outcomes are recorded in .agent/evidence by scripts/agent-evidence; this manifest inventories the reproducible evaluation package and does not replace repository validation evidence.',
  }
  await writeFile(
    join(EVALUATION_DIRECTORY, 'evidence-manifest.json'),
    `${JSON.stringify(evidenceManifest, null, 2)}\n`,
  )
}

async function main() {
  const write = process.argv.includes('--write')
  const suppliedGeometry = argumentValue('--geometry')
  const temporaryDirectory = suppliedGeometry
    ? null
    : await mkdtemp(join(tmpdir(), 'erniesg-srt-evaluation-'))
  const geometryPath = suppliedGeometry
    ? resolve(REPO_ROOT, suppliedGeometry)
    : join(temporaryDirectory, 'geometry-report.json')

  try {
    if (!suppliedGeometry) {
      await run('npm', ['run', 'build:staging'])
      await run(
        'npm',
        ['run', 'test:e2e', '--', 'tests/e2e/srt-visual.spec.ts'],
        {
          SRT_GEOMETRY_REPORT: geometryPath,
          SRT_STATIC_BUILD_DIR: join(REPO_ROOT, 'dist'),
        },
      )
    }
    const geometry = JSON.parse(await readFile(geometryPath, 'utf8'))
    const vite = await createServer({
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null },
    })
    try {
      const [
        papersModule,
        annotationsModule,
        manifestModule,
        pdfModule,
        evaluationModule,
        targetsModule,
      ] = await Promise.all([
        vite.ssrLoadModule('/src/research/papers.ts'),
        vite.ssrLoadModule('/src/research/annotations.ts'),
        vite.ssrLoadModule('/src/research/manifest.ts'),
        vite.ssrLoadModule('/src/research/export-pdf.ts'),
        vite.ssrLoadModule('/src/research/evaluation.ts'),
        vite.ssrLoadModule('/src/research/targets.ts'),
      ])
      const paper = papersModule.getPaper('semantic-responsive-typesetting')
      if (!paper) throw new Error('The SRT evaluation fixture is unavailable')
      const timings = measureCompositions(
        manifestModule.buildLayoutManifest,
        paper,
        targetsModule.TARGET_PROFILE_IDS,
      )
      const manifest = manifestModule.buildLayoutManifest(paper)
      const fixedPdf = pdfModule.buildPaginatedPdf(paper, manifest)
      const cpu = cpus()[0]
      const result = evaluationModule.evaluateSrt({
        paper,
        manifest,
        annotations: annotationsModule.createDemoAnnotations(paper),
        geometry,
        timings,
        runtime: {
          generatedAt: new Date().toISOString(),
          node: process.version,
          v8: process.versions.v8,
          platform: platform(),
          architecture: arch(),
          osRelease: release(),
          cpuModel: cpu?.model.trim() || 'unavailable',
          logicalCpuCount: cpus().length,
          totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
        },
        fixedPdf: {
          pageCount: fixedPdf.pageCount,
          byteLength: fixedPdf.bytes.byteLength,
          sha256: fixedPdf.sha256,
        },
      })

      if (write) {
        await writeEvaluationPackage(result, geometry)
        process.stdout.write(
          `Wrote ${relative(REPO_ROOT, EVALUATION_DIRECTORY)} for ${result.targets.length} targets.\n`,
        )
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      }
    } finally {
      await vite.close()
    }
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `SRT evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
