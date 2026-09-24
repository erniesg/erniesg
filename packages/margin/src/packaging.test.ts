/**
 * The standalone rule, asserted rather than promised.
 *
 * `@erniesg/margin` is meant to be dropped onto another site. That only holds
 * if it compiles on its own and if nothing book-shaped rides along inside it,
 * so this test builds the package the way `npm run build` does and then reads
 * what came out.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// `export =` CJS, loaded the one way that needs no interop flag to be set.
const ts = createRequire(import.meta.url)(
  'typescript',
) as typeof import('typescript')

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src')

/** Unique per run: several workers build this package at once on one host. */
const outDir = mkdtempSync(path.join(tmpdir(), 'erniesg-margin-build-'))

afterAll(() => rmSync(outDir, { recursive: true, force: true }))

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function sourceFiles() {
  return walk(SOURCE_ROOT).filter(
    (file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file),
  )
}

function build() {
  const configPath = path.join(PACKAGE_ROOT, 'tsconfig.build.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  expect(config.error).toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    PACKAGE_ROOT,
  )
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    outDir,
    noEmit: false,
  })
  const emit = program.emit()
  const diagnostics = [
    ...ts.getPreEmitDiagnostics(program),
    ...emit.diagnostics,
  ]
  return {
    emitted: walk(outDir),
    messages: diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    ),
  }
}

const built = build()

describe('the published package', () => {
  it('compiles on its own, with no errors', () => {
    expect(built.messages).toEqual([])
  })

  it('emits every entry point its exports map promises', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as {
      exports: Record<string, { types?: string; import?: string } | string>
    }
    const promised = Object.values(manifest.exports)
      .flatMap((entry) =>
        typeof entry === 'string' ? [entry] : [entry.types, entry.import],
      )
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry) => entry.startsWith('./dist/'))

    expect(promised.length).toBeGreaterThan(0)
    for (const entry of promised) {
      const emitted = path.join(outDir, entry.slice('./dist/'.length))
      expect(built.emitted, `${entry} is not emitted`).toContain(emitted)
    }
  })

  it('imports the emitted ESM entry with Node module resolution', () => {
    // TypeScript accepts extensionless imports in bundler mode even though
    // Node rejects the resulting .js files. Exercise the emitted entry and
    // every transitive relative specifier with the runtime we advertise.
    writeFileSync(path.join(outDir, 'package.json'), '{"type":"module"}')
    symlinkSync(
      path.join(PACKAGE_ROOT, '..', '..', 'node_modules'),
      path.join(outDir, 'node_modules'),
      'dir',
    )
    const entry = pathToFileURL(path.join(outDir, 'index.js')).href
    const imported = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(entry)})`],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 30_000 },
    )
    expect(imported.status, imported.stderr).toBe(0)
  })

  it('carries no book identifier into the build output', () => {
    // Anything here would mean the package had learned about this site.
    const forbidden = [
      'challenges/',
      'build-a-coding-agent',
      'ernie.sg',
      'render.py',
      'src/content',
      'src/research',
      'ResearchPaper',
      'astro',
    ]
    const offences = built.emitted.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return forbidden
        .filter((needle) => text.includes(needle))
        .map((needle) => `${path.relative(outDir, file)} contains ${needle}`)
    })

    expect(offences).toEqual([])
  })

  it('imports nothing but its own files and its declared dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const allowed = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])

    const offences = sourceFiles().flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      const specifiers = Array.from(
        text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/gu),
        (match) => match[1],
      )
      return specifiers
        .filter((specifier) => {
          if (specifier.startsWith('.')) {
            const target = path.resolve(path.dirname(file), specifier)
            return !target.startsWith(SOURCE_ROOT)
          }
          return !allowed.has(specifier.split('/')[0])
        })
        .map(
          (specifier) => `${path.relative(PACKAGE_ROOT, file)} -> ${specifier}`,
        )
    })

    expect(offences).toEqual([])
  })

  it('packs a tarball holding only the built package', (context) => {
    // `npm pack --dry-run` is read-only and needs no registry. Where npm is
    // absent or shimmed to another package manager the case is skipped, so a
    // green run never stands in for a check that did not happen.
    const packed = spawnSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 120_000 },
    )
    if (packed.status !== 0 || !packed.stdout.trim().startsWith('[')) {
      context.skip()
      return
    }
    const [report] = JSON.parse(packed.stdout) as {
      files: { path: string }[]
    }[]
    const paths = report.files.map((entry) => entry.path)

    expect(paths).toContain('package.json')
    for (const entry of paths) {
      expect(
        entry === 'package.json' ||
          entry === 'README.md' ||
          entry.startsWith('dist/'),
      ).toBe(true)
    }
  })
})
