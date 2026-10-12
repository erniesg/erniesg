import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  applyValidatedPublishArtifacts,
  createPublishStage,
  createTrustedVmPublishScript,
  trustedVmSshInvocation,
  validateReturnedPublishArtifacts,
} from './publish.mjs'
import { parsePublishArgs } from './run-publish.mjs'

const execFile = promisify(execFileCallback)

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'translation-publish-'))
  await Promise.all([
    mkdir(path.join(root, '.translation'), { recursive: true }),
    mkdir(path.join(root, 'docs', 'translation'), { recursive: true }),
    mkdir(path.join(root, 'tools', 'translation'), { recursive: true }),
    mkdir(path.join(root, 'src', 'content', 'blog', 'post'), {
      recursive: true,
    }),
    mkdir(path.join(root, 'dist', 'about'), { recursive: true }),
    mkdir(path.join(root, 'public', 'data'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      path.join(root, '.translation', 'config.json'),
      '{"protectedHumanTranslations":[]}\n',
    ),
    writeFile(
      path.join(root, '.translation', 'manifest.json'),
      '{"families":{}}\n',
    ),
    writeFile(path.join(root, 'docs', 'translation', 'zh.md'), 'style\n'),
    writeFile(
      path.join(root, 'tools', 'translation', 'sync.mjs'),
      'export {}\n',
    ),
    writeFile(
      path.join(root, 'src', 'content', 'blog', 'post', 'index.mdx'),
      '---\nlang: en\n---\nSource\n',
    ),
    writeFile(path.join(root, 'dist', 'about', 'index.html'), '<p>About</p>\n'),
    writeFile(
      path.join(root, 'public', 'data', 'copy.json'),
      '{"copy":"About"}\n',
    ),
    writeFile(path.join(root, '.env'), 'never-stage-this\n'),
    writeFile(
      path.join(root, 'wrangler.toml'),
      'credential-like configuration stays local\n',
    ),
  ])
  return root
}

describe('translation publish bridge', () => {
  it('accepts only the trusted VM alias from its CLI boundary', () => {
    expect(parsePublishArgs(['--run-id', 'release-1'])).toEqual({
      runId: 'release-1',
      vmAlias: 'erniesg-ai-vm',
    })
    expect(() => parsePublishArgs(['--vm', 'localhost'])).toThrow(
      /trusted VM alias/,
    )
  })

  it('builds a shell-valid VM command whose archive stream remains on standard input', async () => {
    const script = createTrustedVmPublishScript()
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'translation-publish-shell-'),
    )
    try {
      const scriptPath = path.join(root, 'publish.sh')
      await writeFile(scriptPath, script)
      await execFile('bash', ['-n', scriptPath])
      const invocation = trustedVmSshInvocation()
      expect(invocation[0]).toBe('erniesg-ai-vm')
      expect(invocation).toHaveLength(2)
      expect(invocation[1]).toMatch(/^bash -c /)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stages only the bounded translation inputs and HTML build output', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'test-run',
      })
      expect(
        await readFile(
          path.join(stage.path, 'src/content/blog/post/index.mdx'),
          'utf8',
        ),
      ).toContain('Source')
      expect(
        await readFile(path.join(stage.path, 'dist/about/index.html'), 'utf8'),
      ).toContain('About')
      await expect(
        readFile(path.join(stage.path, '.env'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        readFile(path.join(stage.path, 'wrangler.toml'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(stage.files).toEqual(
        expect.arrayContaining([
          '.translation/config.json',
          'docs/translation/zh.md',
          'dist/about/index.html',
          'src/content/blog/post/index.mdx',
        ]),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a returned artifact that changes protected input bytes', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'protected-bytes',
      })
      const output = await mkdtemp(
        path.join(os.tmpdir(), 'translation-publish-output-'),
      )
      try {
        await mkdir(path.join(output, '.translation'), { recursive: true })
        await writeFile(
          path.join(output, '.translation', 'config.json'),
          '{"changed":true}\n',
        )
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(
          /protected input changed: \.translation\/config\.json/,
        )
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a returned catalog that overwrites a native page locale', async () => {
    const root = await fixture()
    try {
      await writeFile(
        path.join(root, '.translation', 'pages.json'),
        JSON.stringify({
          pages: {
            '/about/': {
              locales: {
                zh: {
                  status: 'native',
                  sourceHash: 'source',
                  translations: { s0001: '原文' },
                },
              },
            },
          },
        }),
      )
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'native-page',
      })
      const output = await mkdtemp(
        path.join(os.tmpdir(), 'translation-publish-output-'),
      )
      try {
        await mkdir(path.join(output, '.translation'), { recursive: true })
        await writeFile(
          path.join(output, '.translation', 'pages.json'),
          JSON.stringify({
            pages: {
              '/about/': {
                locales: {
                  zh: {
                    status: 'machine',
                    sourceHash: 'source',
                    translations: { s0001: '机器' },
                  },
                },
              },
            },
          }),
        )
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(/native page locale changed: \/about\/ zh/)
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies a validated new machine sidecar without changing its English source', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'apply-machine',
      })
      const output = await mkdtemp(
        path.join(os.tmpdir(), 'translation-publish-output-'),
      )
      try {
        await mkdir(path.join(output, 'src', 'content', 'blog', 'post'), {
          recursive: true,
        })
        await writeFile(
          path.join(output, 'src', 'content', 'blog', 'post', 'zh.mdx'),
          '---\nlang: zh\ntranslationStatus: machine\ntranslationSource: codex\n---\n译文\n',
        )
        await applyValidatedPublishArtifacts({
          stage,
          outputRoot: output,
          repoRoot: root,
        })
        expect(
          await readFile(
            path.join(root, 'src/content/blog/post/index.mdx'),
            'utf8',
          ),
        ).toContain('Source')
        expect(
          await readFile(
            path.join(root, 'src/content/blog/post/zh.mdx'),
            'utf8',
          ),
        ).toContain('译文')
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
