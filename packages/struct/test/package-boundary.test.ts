import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditPackageImportBoundary } from './package-import-boundary.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const child = join(path, entry.name)
      return entry.isDirectory() ? filesUnder(child) : [child]
    }),
  )
  return nested.flat()
}

describe('STRUCT package artifact boundary', () => {
  it('publishes only built files and contains no private consumer contracts', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as {
      version?: string
      files?: string[]
      exports?: Record<string, unknown>
    }
    expect(manifest.version).toBe('0.1.0-rc.0')
    expect(manifest.files).toEqual(['dist'])
    expect(Object.keys(manifest.exports ?? {})).toEqual([
      '.',
      './core',
      './schema',
      './ids',
      './recovery',
      './renderers/xhtml',
      './renderers/epub',
    ])

    const sourceFiles = await filesUnder(join(root, 'src'))
    const forbidden =
      /(?:reconstruction|publication|astro|pdf|provider|model|bookworld)/iu
    expect(
      sourceFiles.some(
        (path) =>
          forbidden.test(path) &&
          !path.endsWith('/model-consultation-receipt.ts'),
      ),
    ).toBe(false)

    const pack = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: root,
        encoding: 'utf8',
      }),
    )[0] as {
      filename: string
      name: string
      version: string
      files?: Array<{ path: string }>
    }
    expect(pack).toMatchObject({
      filename: 'erniesg-struct-0.1.0-rc.0.tgz',
      name: '@erniesg/struct',
      version: '0.1.0-rc.0',
    })
    const packedPaths = pack.files?.map(({ path }) => path) ?? []
    expect(packedPaths).toContain('package.json')
    expect(
      packedPaths.every(
        (path) => path === 'package.json' || path.startsWith('dist/'),
      ),
    ).toBe(true)
    expect(
      packedPaths.some(
        (path) =>
          forbidden.test(path) &&
          !path.endsWith('/model-consultation-receipt.js') &&
          !path.endsWith('/model-consultation-receipt.d.ts') &&
          !path.endsWith('/model-consultation-receipt.js.map') &&
          !path.endsWith('/model-consultation-receipt.d.ts.map'),
      ),
    ).toBe(false)
  })

  it('reports exact graph-boundary diagnostics for red fixtures', async () => {
    const cases: GraphBoundaryCase[] = [
      {
        name: 'relative import escaping source',
        source: "import '../app.js'\n",
        extra: { 'app.ts': 'export const app = true\n' },
        expected: 'relative-outside-source',
        specifier: '../app.js',
      },
      {
        name: 'resolution indirection',
        source: "import '@app/secret.js'\n",
        extra: {
          'app/secret.ts': 'export const secret = true\n',
          'tsconfig.json': JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'Bundler',
              rootDir: 'src',
              baseUrl: '.',
              paths: { '@app/*': ['app/*'] },
            },
            include: ['src/**/*.ts'],
          }),
        },
        expected: 'resolution-indirection-not-allowed',
        importer: 'tsconfig.json',
      },
      {
        name: 'undeclared dependency',
        source: "import 'vitest'\n",
        extra: {
          'node_modules/vitest/package.json': JSON.stringify({
            name: 'vitest',
            types: 'index.d.ts',
          }),
          'node_modules/vitest/index.d.ts': 'export {}\n',
        },
        expected: 'undeclared-runtime-dependency',
        specifier: 'vitest',
      },
      {
        name: 'AMD module compiler option',
        source:
          '/// <amd-dependency path="evil" />\nexport const value = true\n',
        extra: {
          'tsconfig.json': JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'AMD',
              moduleResolution: 'Node10',
              strict: true,
              skipLibCheck: true,
              rootDir: 'src',
            },
            include: ['src/**/*.ts'],
          }),
        },
        expected: 'compiler-option-not-allowed',
        importer: 'tsconfig.json',
        specifier: 'module',
      },
      ...['constructor', 'toString', 'hasOwnProperty'].map((name) => ({
        name: `inherited dependency name: ${name}`,
        source: `import '${name}'\n`,
        extra: {
          [`node_modules/${name}/package.json`]: JSON.stringify({
            name,
            types: 'index.d.ts',
          }),
          [`node_modules/${name}/index.d.ts`]: 'export {}\n',
        },
        expected: 'undeclared-runtime-dependency',
        specifier: name,
      })),
      {
        name: 'unresolved dependency',
        source: "import 'missing-runtime'\n",
        expected: 'unresolved-module',
        specifier: 'missing-runtime',
      },
      {
        name: 'unsafe dependency subpath',
        source: "import 'fflate/../fast-xml-parser'\n",
        expected: 'unsafe-module-specifier',
        specifier: 'fflate/../fast-xml-parser',
      },
      {
        name: 'dot dependency subpath',
        source: "import 'fflate/./index'\n",
        extra: {
          'node_modules/fflate/package.json': JSON.stringify({
            name: 'fflate',
            types: 'index.d.ts',
          }),
          'node_modules/fflate/index.d.ts': 'export {}\n',
        },
        expected: 'unsafe-module-specifier',
        specifier: 'fflate/./index',
      },
      {
        name: 'dot package root subpath',
        source: "import 'fflate/.'\n",
        extra: {
          'node_modules/fflate/package.json': JSON.stringify({
            name: 'fflate',
            types: 'index.d.ts',
          }),
          'node_modules/fflate/index.d.ts': 'export {}\n',
        },
        expected: 'unsafe-module-specifier',
        specifier: 'fflate/.',
      },
      {
        name: 'encoded dependency traversal',
        source: "import 'fflate%2e%2fsecret'\n",
        expected: 'unsafe-module-specifier',
        specifier: 'fflate%2e%2fsecret',
      },
      {
        name: 'backslash dependency traversal',
        source: "import 'fflate\\\\secret'\n",
        expected: 'unsafe-module-specifier',
        specifier: 'fflate\\secret',
      },
      {
        name: 'reference directive',
        source: '/// <reference path="../app.ts" />\nexport const value = 1\n',
        extra: { 'app.ts': 'export const app = true\n' },
        expected: 'reference-directive-not-allowed',
        specifier: '../app.ts',
      },
      {
        name: 'source symlink',
        source: 'export const value = 1\n',
        symlink: true,
        expected: 'source-symlink-not-allowed',
        importer: 'src/link.ts',
      },
    ]

    for (const testCase of cases) {
      const fixture = await makeFixture(testCase.source, testCase.extra)
      try {
        if (testCase.symlink) {
          await symlink(
            join(fixture, 'src/index.ts'),
            join(fixture, 'src/link.ts'),
          )
        }
        const diagnostics = await auditPackageImportBoundary(fixture)
        const matching = diagnostics.find(
          ({ code }) => code === testCase.expected,
        )
        expect(matching, testCase.name).toBeDefined()
        expect(matching).toMatchObject({
          importer: testCase.importer ?? 'src/index.ts',
          ...(testCase.specifier ? { specifier: testCase.specifier } : {}),
        })
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('rejects AMD and UMD options without lexically parsing directive text', async () => {
    const cases = [
      { name: 'AMD', module: 'AMD' },
      { name: 'UMD', module: 'UMD' },
    ]
    const source =
      '/// <amd-dependency name=\'path="evil"\' data-path="evil" />\n' +
      'export const value = true\n' +
      '//// <amd-dependency path="late" />\n' +
      'text = "<amd-dependency path=\\"ignored\\" />"\n' +
      '/// <amd-dependency path="post-code" />\n'

    for (const testCase of cases) {
      const fixture = await makeFixture(source, {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: testCase.module,
            moduleResolution: 'Node10',
            strict: true,
            skipLibCheck: true,
            rootDir: 'src',
          },
          include: ['src/**/*.ts'],
        }),
      })
      try {
        const diagnostics = await auditPackageImportBoundary(fixture)
        expect(diagnostics).toContainEqual(
          expect.objectContaining({
            code: 'compiler-option-not-allowed',
            importer: 'tsconfig.json',
            offset: 0,
            specifier: 'module',
          }),
        )
        expect(
          diagnostics.filter(({ code }) => code === 'invalid-amd-dependency'),
          testCase.name,
        ).toEqual([])
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('rejects compiler-recognized AMD directives in every module mode', async () => {
    const cases = [
      { module: 'ESNext', moduleResolution: 'Bundler' },
      { module: 'CommonJS', moduleResolution: 'Node10' },
      { module: 'System', moduleResolution: 'Node10' },
      { module: 'None', moduleResolution: 'Node10' },
    ]
    for (const compilerOptions of cases) {
      const fixture = await makeFixture(
        '/// <amd-dependency path="evil" />\n' +
          '/// <amd-dependency path="second" />\n' +
          'export const value = true\n' +
          '/// <amd-dependency path="late" />\n',
        {
          'tsconfig.json': JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              ...compilerOptions,
              strict: true,
              skipLibCheck: true,
              rootDir: 'src',
            },
            include: ['src/**/*.ts'],
          }),
        },
      )
      try {
        const diagnostics = await auditPackageImportBoundary(fixture)
        expect(
          diagnostics.filter(({ code }) => code === 'invalid-amd-dependency'),
        ).toHaveLength(1)
        expect(diagnostics).toEqual([
          expect.objectContaining({
            code: 'invalid-amd-dependency',
            importer: 'src/index.ts',
            offset: 0,
          }),
        ])
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('ignores AMD directive lookalikes that TypeScript does not recognize', async () => {
    const sources = [
      '//// <amd-dependency path="four-slash" />\nexport const value = true\n',
      'export const value = true\n/// <amd-dependency path="post-code" />\n',
      '/// <amd-dependency name=\'path="decoy"\' data-path="decoy" />\nexport const value = true\n',
    ]
    for (const source of sources) {
      const fixture = await makeFixture(source, {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true,
            rootDir: 'src',
          },
          include: ['src/**/*.ts'],
        }),
      })
      try {
        await expect(auditPackageImportBoundary(fixture)).resolves.toEqual([])
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('rejects non-portable dependency declarations while retaining portable forms', async () => {
    const cases = [
      { name: 'parent path', declaration: '../evil' },
      { name: 'current path', declaration: './evil' },
      { name: 'npm local path', declaration: '~/evil' },
      { name: 'npm local backslash path', declaration: '~\\evil' },
      { name: 'npm local archive', declaration: '~/evil.tgz' },
      { name: 'POSIX absolute path', declaration: '/tmp/evil' },
      { name: 'Windows drive path', declaration: 'C:\\evil' },
      { name: 'Windows drive slash path', declaration: 'C:/evil' },
      { name: 'Windows drive-relative path', declaration: 'C:evil' },
      { name: 'Windows drive-relative parent', declaration: 'C:../evil' },
      { name: 'Windows drive-relative archive', declaration: 'Z:package.tgz' },
      { name: 'Windows UNC path', declaration: '\\\\server\\share\\evil' },
      { name: 'bare tgz archive', declaration: 'evil.tgz' },
      { name: 'bare tgz archive is case-insensitive', declaration: 'evil.TGZ' },
      { name: 'bare tar.gz archive', declaration: 'evil.tar.gz' },
      {
        name: 'bare tar.gz archive is case-insensitive',
        declaration: 'evil.TAR.GZ',
      },
      { name: 'bare tar archive', declaration: 'evil.tar' },
      { name: 'dot-prefixed local directory', declaration: '.hidden' },
      {
        name: 'dot-prefixed nested local directory',
        declaration: '.config/pkg',
      },
      { name: 'multi-dot local directory', declaration: '.../evil' },
      { name: 'nested local directory', declaration: 'dir/sub/local' },
      { name: 'raw scoped local directory', declaration: '@scope/pkg' },
      {
        name: 'hosted shorthand with version suffix',
        declaration: 'user/repo@1.2.3',
      },
      {
        name: 'hosted shorthand with tag suffix',
        declaration: 'foo/bar@latest',
      },
      {
        name: 'hosted shorthand with whitespace',
        declaration: 'user/repo name',
      },
      {
        name: 'hosted shorthand with tab whitespace',
        declaration: 'user/repo\tname',
      },
      {
        name: 'hosted shorthand with control character',
        declaration: 'user/repo\u0000name',
      },
      {
        name: 'hosted shorthand with user at-sign',
        declaration: 'user@name/repo',
      },
      {
        name: 'hosted shorthand with invalid repository escape',
        declaration: 'user/repo%ZZ',
      },
      {
        name: 'hosted shorthand with invalid user escape',
        declaration: 'user/%ZZ',
      },
      {
        name: 'slash value with non-protocol colon',
        declaration: 'user/repo:tag',
      },
      {
        name: 'multisegment shorthand with semver fragment',
        declaration: 'dir/sub/local#semver:^1.2.3',
      },
      {
        name: 'multisegment shorthand with path fragment',
        declaration: 'user/repo/extra#path:packages/a',
      },
      {
        name: 'scoped multisegment shorthand with semver fragment',
        declaration: '@scope/pkg/path#semver:^1.2.3',
      },
      {
        name: 'hosted shorthand with invalid fragment escape',
        declaration: 'user/repo#main%ZZ',
      },
      { name: 'file protocol', declaration: 'file:../evil' },
      { name: 'link protocol', declaration: 'link:../evil' },
      { name: 'workspace protocol', declaration: 'workspace:*' },
      { name: 'git file protocol', declaration: 'git+file:///tmp/evil' },
      { name: 'empty declaration', declaration: '' },
      { name: 'whitespace declaration', declaration: '   ' },
      { name: 'null declaration', declaration: null },
      { name: 'object declaration', declaration: { path: 'evil' } },
      { name: 'exact semver', declaration: '1.2.3', portable: true },
      { name: 'semver range', declaration: '^1.2.3', portable: true },
      { name: 'semver tilde', declaration: '~1.2.3', portable: true },
      { name: 'bare tilde registry tag', declaration: '~', portable: true },
      {
        name: 'named tilde registry tag',
        declaration: '~latest',
        portable: true,
      },
      { name: 'npm alias', declaration: 'npm:evil@^1.2.3', portable: true },
      {
        name: 'npm scoped alias',
        declaration: 'npm:@scope/pkg@^1.2.3',
        portable: true,
      },
      { name: 'GitHub shorthand', declaration: 'user/repo', portable: true },
      {
        name: 'GitHub shorthand empty fragment',
        declaration: 'user/repo#',
        portable: true,
      },
      {
        name: 'GitHub shorthand space escape',
        declaration: 'user/repo%20',
        portable: true,
      },
      {
        name: 'GitHub shorthand letter escape',
        declaration: 'user/repo%72',
        portable: true,
      },
      {
        name: 'GitHub shorthand slash escape',
        declaration: 'user/repo%2F',
        portable: true,
      },
      {
        name: 'GitHub shorthand tgz repository',
        declaration: 'user/repo.tgz',
        portable: true,
      },
      {
        name: 'GitHub shorthand tar.gz repository',
        declaration: 'user/repo.tar.gz',
        portable: true,
      },
      {
        name: 'GitHub shorthand tar repository',
        declaration: 'user/repo.tar',
        portable: true,
      },
      {
        name: 'GitHub shorthand archive fragment',
        declaration: 'user/repo.tgz#main',
        portable: true,
      },
      {
        name: 'GitHub shorthand semver fragment',
        declaration: 'user/repo#semver:^1.2.3',
        portable: true,
      },
      {
        name: 'HTTPS archive',
        declaration: 'https://example.com/evil.tgz',
        portable: true,
      },
      {
        name: 'HTTPS git repository',
        declaration: 'git+https://github.com/example/evil.git',
        portable: true,
      },
      {
        name: 'GitHub protocol repository',
        declaration: 'github:user/repo',
        portable: true,
      },
      {
        name: 'GitLab protocol repository',
        declaration: 'gitlab:user/repo',
        portable: true,
      },
      {
        name: 'Bitbucket protocol repository',
        declaration: 'bitbucket:user/repo',
        portable: true,
      },
      {
        name: 'git+ssh repository',
        declaration: 'git+ssh://git@github.com/example/evil.git',
        portable: true,
      },
      {
        name: 'SCP git repository',
        declaration: 'git@github.com:example/evil.git',
        portable: true,
      },
    ]

    for (const testCase of cases) {
      const fixture = await makeFixture("import 'evil'\n", {
        'package.json': JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          dependencies: { evil: testCase.declaration },
        }),
        'node_modules/evil/package.json': JSON.stringify({
          name: 'evil',
          types: 'index.d.ts',
        }),
        'node_modules/evil/index.d.ts': 'export {}\n',
      })
      try {
        const diagnostics = await auditPackageImportBoundary(fixture)
        const matching = diagnostics.filter(
          ({ code, specifier }) =>
            code === 'non-portable-dependency' && specifier === 'evil',
        )
        if (testCase.portable) {
          expect(matching, testCase.name).toEqual([])
        } else {
          expect(matching, testCase.name).toHaveLength(1)
        }
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('rejects every parsed root outside the canonical source set', async () => {
    const cases = [
      { name: 'mts', path: 'src/extra.mts', compilerOptions: {} },
      { name: 'cts', path: 'src/extra.cts', compilerOptions: {} },
      {
        name: 'javascript with allowJs',
        path: 'src/extra.js',
        compilerOptions: { allowJs: true },
      },
      {
        name: 'json with resolveJsonModule',
        path: 'src/extra.json',
        compilerOptions: { resolveJsonModule: true },
      },
    ]

    for (const testCase of cases) {
      const fixture = await makeFixture('export const value = true\n', {
        [testCase.path]: testCase.path.endsWith('.json')
          ? '{"value":true}\n'
          : 'export const extra = true\n',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true,
            rootDir: 'src',
            ...testCase.compilerOptions,
          },
          files: ['src/index.ts', testCase.path],
        }),
      })
      try {
        expect(
          (await auditPackageImportBoundary(fixture)).map(({ code }) => code),
          testCase.name,
        ).toContain('configured-source-set-mismatch')
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('rejects compiler-selected local declaration closure outside src', async () => {
    const fixture = await makeFixture('export const value = true\n')
    const ambientName = `ambient-${basename(fixture)}`
    const ambientPath = join(fixture, '..', ambientName)
    await mkdir(ambientPath, { recursive: true })
    await writeFile(
      join(ambientPath, 'index.d.ts'),
      'declare const ambient: unique symbol\n',
    )
    await writeFile(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          skipLibCheck: true,
          rootDir: 'src',
          types: [`../${ambientName}`],
        },
        include: ['src/**/*.ts'],
      }),
    )
    try {
      expect(
        (await auditPackageImportBoundary(fixture)).map(({ code }) => code),
      ).toContain('source-closure-outside-source')
    } finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(ambientPath, { recursive: true, force: true })
    }
  })

  it('classifies the implicit JSX runtime module edge', async () => {
    const cases = [
      {
        name: 'configured JSX import source',
        source: 'export const value = <div />\n',
        packageName: 'evil',
        jsx: 'react-jsx',
        runtimeFile: 'jsx-runtime.d.ts',
        runtime: 'evil/jsx-runtime',
      },
      {
        name: 'default React JSX runtime',
        source: 'export const value = <div />\n',
        packageName: 'react',
        jsx: 'react-jsx',
        runtimeFile: 'jsx-runtime.d.ts',
        runtime: 'react/jsx-runtime',
      },
      {
        name: 'default React JSX dev runtime',
        source: 'export const value = <div />\n',
        packageName: 'react',
        jsx: 'react-jsxdev',
        runtimeFile: 'jsx-dev-runtime.d.ts',
        runtime: 'react/jsx-dev-runtime',
      },
    ]

    const missing: string[] = []
    for (const testCase of cases) {
      const fixture = await makeFixture(
        testCase.source,
        {
          [`node_modules/${testCase.packageName}/package.json`]: JSON.stringify(
            {
              name: testCase.packageName,
              types: testCase.runtimeFile,
            },
          ),
          [`node_modules/${testCase.packageName}/${testCase.runtimeFile}`]:
            'export function jsx(): unknown\n',
          'tsconfig.json': JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'Bundler',
              jsx: testCase.jsx,
              ...(testCase.packageName === 'evil' &&
              !testCase.source.includes('@jsxImportSource')
                ? { jsxImportSource: 'evil' }
                : {}),
              strict: true,
              skipLibCheck: true,
              rootDir: 'src',
            },
            include: ['src/**/*.tsx'],
          }),
        },
        'src/index.tsx',
      )
      try {
        const matching = (await auditPackageImportBoundary(fixture)).find(
          ({ code, specifier }) =>
            code === 'undeclared-runtime-dependency' &&
            specifier === testCase.runtime,
        )
        if (!matching) missing.push(testCase.name)
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
    expect(missing).toEqual([])
  })

  it('rejects unsupported source JSX pragmas with exact diagnostics', async () => {
    const cases = [
      {
        name: 'automatic runtime override',
        source: '/** @jsxRuntime automatic */\nexport const value = <div />\n',
        jsx: 'react',
        pragma: '@jsxRuntime',
      },
      {
        name: 'classic runtime override',
        source: '/** @jsxRuntime classic */\nexport const value = <div />\n',
        jsx: 'react-jsx',
        pragma: '@jsxRuntime',
      },
      {
        name: 'source import override',
        source: '/** @jsxImportSource evil */\nexport const value = <div />\n',
        jsx: 'react-jsx',
        pragma: '@jsxImportSource',
      },
      {
        name: 'pragma-looking string',
        source: 'const value = "@jsxRuntime automatic"\nexport { value }\n',
        jsx: 'react-jsx',
      },
      {
        name: 'ordinary comment',
        source:
          '// ordinary comment mentioning jsxRuntime automatic\nexport const value = true\n',
        jsx: 'react-jsx',
      },
      {
        name: 'line comment with pragma text',
        source: '// @jsxRuntime automatic\nexport const value = true\n',
        jsx: 'react-jsx',
      },
      {
        name: 'block comment with pragma text',
        source: '/* @jsxImportSource evil */\nexport const value = <div />\n',
        jsx: 'react-jsx',
        pragma: '@jsxImportSource',
      },
      {
        name: 'block automatic runtime override',
        source: '/* @jsxRuntime automatic */\nexport const value = <div />\n',
        jsx: 'react',
        pragma: '@jsxRuntime',
      },
      {
        name: 'lowercase block import source pragma',
        source: '/* @jsximportsource evil */\nexport const value = <div />\n',
        jsx: 'react-jsx',
        pragma: '@jsxImportSource',
        marker: '@jsximportsource',
      },
      {
        name: 'uppercase block runtime pragma',
        source: '/* @JSXRUNTIME automatic */\nexport const value = <div />\n',
        jsx: 'react',
        pragma: '@jsxRuntime',
        marker: '@JSXRUNTIME',
      },
      {
        name: 'unknown prefix before import source token',
        source:
          '/* @notAThing @jsxImportSource evil */\nexport const value = <div />\n',
        jsx: 'react-jsx',
        allowRuntimeEdge: true,
      },
      {
        name: 'unknown prefix before runtime token',
        source:
          '/* @notAThing @jsxRuntime automatic */\nexport const value = <div />\n',
        jsx: 'react',
        allowRuntimeEdge: true,
      },
      ...[
        { name: 'CRLF', lineBreak: '\r\n' },
        { name: 'LF', lineBreak: '\n' },
        { name: 'bare CR', lineBreak: '\r' },
        { name: 'line separator', lineBreak: '\u2028' },
        { name: 'paragraph separator', lineBreak: '\u2029' },
      ].map(({ name, lineBreak }) => {
        const marker = '@jSxImPoRtSoUrCe'
        return {
          name: `pragma after ${name}`,
          source: `/* @notAThing${lineBreak}${marker} evil */\nexport const value = <div />\n`,
          jsx: 'react-jsx',
          pragma: '@jsxImportSource',
          marker,
        }
      }),
    ]

    const missing: string[] = []
    for (const testCase of cases) {
      const fixture = await makeFixture(
        testCase.source,
        {
          'node_modules/react/package.json': JSON.stringify({
            name: 'react',
            types: 'jsx-runtime.d.ts',
          }),
          'node_modules/react/jsx-runtime.d.ts':
            'export function jsx(): unknown\n',
          'node_modules/evil/package.json': JSON.stringify({
            name: 'evil',
            types: 'jsx-runtime.d.ts',
          }),
          'node_modules/evil/jsx-runtime.d.ts':
            'export function jsx(): unknown\n',
          'tsconfig.json': JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'Bundler',
              jsx: testCase.jsx,
              strict: true,
              skipLibCheck: true,
              rootDir: 'src',
            },
            include: ['src/**/*.tsx'],
          }),
        },
        'src/index.tsx',
      )
      try {
        const diagnostics = await auditPackageImportBoundary(fixture)
        if (testCase.pragma) {
          const matching = diagnostics.find(
            ({ code, specifier }) =>
              code === 'jsx-pragma-not-allowed' &&
              specifier === testCase.pragma,
          )
          if (!matching) {
            missing.push(testCase.name)
          } else {
            expect(matching).toMatchObject({
              importer: 'src/index.tsx',
              offset: testCase.source.indexOf(
                testCase.marker ?? testCase.pragma,
              ),
              message: `${testCase.pragma} is not part of the package source dialect`,
            })
          }
        } else if (
          diagnostics.some(({ code }) => code === 'jsx-pragma-not-allowed') ||
          (!testCase.allowRuntimeEdge && diagnostics.length > 0)
        ) {
          missing.push(testCase.name)
        }
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
    expect(missing).toEqual([])
  })

  it('rejects compiler helper imports as an unsupported dialect option', async () => {
    const fixture = await makeFixture(
      'export async function value() { await Promise.resolve() }\n',
      {
        'node_modules/tslib/package.json': JSON.stringify({
          name: 'tslib',
          types: 'index.d.ts',
        }),
        'node_modules/tslib/index.d.ts':
          'export declare const __awaiter: unknown\n',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2015',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            importHelpers: true,
            strict: true,
            skipLibCheck: true,
            rootDir: 'src',
          },
          include: ['src/**/*.ts'],
        }),
      },
    )
    try {
      expect(await auditPackageImportBoundary(fixture)).toContainEqual(
        expect.objectContaining({
          code: 'compiler-option-not-allowed',
          importer: 'tsconfig.json',
          specifier: 'importHelpers',
        }),
      )
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('reports exact lexical policy diagnostics for unsupported capabilities', async () => {
    const cases = [
      {
        source: "export const value = import('./local.js')\n",
        expected: 'dynamic-import-not-allowed',
      },
      {
        source: "export const value = require('x')\n",
        expected: 'reserved-capability-not-allowed',
      },
      {
        source: "export const value = require.resolve('x')\n",
        expected: 'reserved-capability-not-allowed',
      },
      {
        source:
          'const require = () => undefined\nexport const value = require()\n',
        expected: 'reserved-capability-not-allowed',
      },
      {
        source:
          'declare const name: string\nexport const value = import(name)\n',
        expected: 'dynamic-import-not-allowed',
      },
      {
        source: "import value = require('x')\n",
        expected: 'import-equals-not-allowed',
      },
      {
        source: 'export const value = eval("1")\n',
        expected: 'runtime-codegen-not-allowed',
      },
      {
        source: 'export const value = Function("return 1")\n',
        expected: 'runtime-codegen-not-allowed',
      },
      {
        source: "import { readFile } from 'node:module'\n",
        expected: 'loader-module-not-allowed',
      },
      {
        source:
          'const { process: proc } = globalThis\nexport const value = proc\n',
        expected: 'reserved-capability-not-allowed',
      },
      {
        source: 'const req = global.process\nexport const value = req\n',
        expected: 'reserved-capability-not-allowed',
      },
      {
        source:
          "const req = process.getBuiltinModule('module').Module.createRequire(import.meta.url)\nexport const value = req\n",
        expected: 'reserved-capability-not-allowed',
      },
      {
        source:
          "const { Module } = process.getBuiltinModule('module')\nexport const value = Module\n",
        expected: 'reserved-capability-not-allowed',
      },
      {
        source:
          "const { default: proc } = await import('node:process')\nexport const value = proc\n",
        expected: 'dynamic-import-not-allowed',
      },
      {
        source:
          "const proc = await import('node:process' as const)\nexport const value = proc\n",
        expected: 'dynamic-import-not-allowed',
      },
      {
        source:
          '// require eval Function globalThis\nconst value = "process module"\n',
        expected: undefined,
      },
    ]

    for (const testCase of cases) {
      const fixture = await makeFixture(testCase.source)
      try {
        const diagnostics = await auditPackageImportBoundary(fixture)
        if (testCase.expected) {
          expect(
            diagnostics.map(({ code }) => code),
            testCase.source,
          ).toContain(testCase.expected)
        } else {
          expect(diagnostics).toEqual([])
        }
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('accepts the current source tree', async () => {
    expect(await auditPackageImportBoundary(root)).toEqual([])
  })

  it('compiles and packs from a package-only temporary copy', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'struct-package-only-'))
    try {
      await cp(join(root, 'src'), join(fixture, 'src'), { recursive: true })
      await cp(join(root, 'package.json'), join(fixture, 'package.json'))
      await cp(join(root, 'tsconfig.json'), join(fixture, 'tsconfig.json'))
      await symlink(
        join(root, '../../node_modules'),
        join(fixture, 'node_modules'),
      )

      execFileSync(
        process.execPath,
        [
          join(root, '../../node_modules/typescript/bin/tsc'),
          '-p',
          join(fixture, 'tsconfig.json'),
        ],
        { cwd: fixture, stdio: 'pipe' },
      )
      const distPaths = (await filesUnder(join(fixture, 'dist'))).map((path) =>
        path.slice(fixture.length + 1),
      )
      expect(distPaths).toEqual(
        expect.arrayContaining([
          'dist/index.js',
          'dist/core.js',
          'dist/schema.js',
          'dist/ids.js',
          'dist/recovery.js',
          'dist/renderers/xhtml.js',
          'dist/renderers/epub.js',
        ]),
      )
      const pack = JSON.parse(
        execFileSync(
          'npm',
          ['pack', '--dry-run', '--ignore-scripts', '--json'],
          {
            cwd: fixture,
            encoding: 'utf8',
          },
        ),
      )[0] as { files?: Array<{ path: string }> }
      const packedPaths = pack.files?.map(({ path }) => path) ?? []
      expect(packedPaths).toContain('package.json')
      expect(
        packedPaths.every(
          (path) => path === 'package.json' || path.startsWith('dist/'),
        ),
      ).toBe(true)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

type FixtureExtra = Record<string, string | undefined>

type GraphBoundaryCase = {
  name: string
  source: string
  extra?: FixtureExtra
  expected: string
  symlink?: boolean
  importer?: string
  specifier?: string
}

async function makeFixture(
  source: string,
  extra: FixtureExtra = {},
  sourcePath = 'src/index.ts',
) {
  const fixture = await mkdtemp(join(tmpdir(), 'struct-boundary-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, sourcePath), source)
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      dependencies: { fflate: '^0.8.3', 'fast-xml-parser': '^5.10.1' },
    }),
  )
  await writeFile(
    join(fixture, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        rootDir: 'src',
      },
      include: ['src/**/*.ts'],
    }),
  )
  for (const [path, contents] of Object.entries(extra)) {
    if (contents === undefined) continue
    const destination = join(fixture, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents)
  }
  return fixture
}
