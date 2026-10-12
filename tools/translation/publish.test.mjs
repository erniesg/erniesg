import { describe, expect, it } from 'vitest'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  applyValidatedPublishArtifacts,
  createPublishStage,
  createTrustedVmPublishScript,
  runTrustedVmPublish,
  trustedRunnerExpectedHashes,
  trustedVmSshInvocation,
  validateReturnedPublishArtifacts,
} from './publish.mjs'
import { parsePublishArgs } from './run-publish.mjs'
import { sha256 } from './content.mjs'

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

async function validMachineOutput(
  root,
  { body = '译文', pages = { pages: {} }, target = {} } = {},
) {
  const output = await mkdtemp(
    path.join(os.tmpdir(), 'translation-publish-output-'),
  )
  const source = await readFile(
    path.join(root, 'src', 'content', 'blog', 'post', 'index.mdx'),
    'utf8',
  )
  const translation = `---\nlang: zh\ntranslationStatus: machine\ntranslationSource: codex\n---\n${body}\n`
  await mkdir(path.join(output, 'src', 'content', 'blog', 'post'), {
    recursive: true,
  })
  await mkdir(path.join(output, '.translation'), { recursive: true })
  await writeFile(
    path.join(output, 'src', 'content', 'blog', 'post', 'zh.mdx'),
    translation,
  )
  await writeFile(
    path.join(output, '.translation', 'manifest.json'),
    JSON.stringify({
      families: {
        post: {
          targets: {
            zh: {
              path: 'src/content/blog/post/zh.mdx',
              status: 'machine',
              provider: 'codex-cli',
              targetLocale: 'zh',
              sourceLocale: 'en',
              sourcePath: 'src/content/blog/post/index.mdx',
              sourceSha256: sha256(source),
              targetSha256: sha256(translation),
              ...target,
            },
          },
        },
      },
    }),
  )
  await writeFile(
    path.join(output, '.translation', 'pages.json'),
    JSON.stringify(pages),
  )
  return { output, translation }
}

async function bytes(root, files) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(path.join(root, file), 'utf8').catch((error) =>
          error.code === 'ENOENT' ? null : Promise.reject(error),
        ),
      ]),
    ),
  )
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
      expect(script).toContain('PATH=/usr/bin:/bin')
      expect(script).toContain(
        'unset NODE_OPTIONS NODE_PATH PYTHONPATH PYTHONHOME BASH_ENV ENV',
      )
      expect(script).toContain(
        '/usr/bin/python3 -I "$runner/trusted-runner.py"',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds the VM verifier to the local reviewed runner code and dependency lock', () => {
    const hashes = trustedRunnerExpectedHashes()
    expect(hashes['package.json']).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes['package-lock.json']).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes['trusted-runner.py']).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes['sync.mjs']).toMatch(/^[0-9a-f]{64}$/)
    expect(createTrustedVmPublishScript()).toContain(
      'verify --expected-hashes "$expected_hashes"',
    )
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

  it('never stages checkout-supplied translation code, even when it is malicious', async () => {
    const root = await fixture()
    try {
      await writeFile(
        path.join(root, 'tools', 'translation', 'sync.mjs'),
        'throw new Error("would read VM credentials")\n',
      )
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'data-only',
      })
      expect(stage.files).not.toContain('tools/translation/sync.mjs')
      await expect(
        readFile(
          path.join(stage.path, 'tools', 'translation', 'sync.mjs'),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(createTrustedVmPublishScript()).toContain(
        '/opt/erniesg-translation-publisher/',
      )
      expect(createTrustedVmPublishScript()).not.toContain(
        'node tools/translation/sync.mjs',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a symlink among staged inputs before copying any archive data', async () => {
    const root = await fixture()
    try {
      const source = path.join(root, 'docs', 'translation', 'zh.md')
      const linked = path.join(root, 'docs', 'translation', 'ja.md')
      await symlink(source, linked)
      await expect(
        createPublishStage({ repoRoot: root, runId: 'symlink' }),
      ).rejects.toThrow(/Symbolic links are not allowed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts before any archive or SSH process when the stage inventory changes', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'changed-stage',
      })
      await writeFile(path.join(stage.path, 'unexpected.txt'), 'injected')
      const archivePath = path.join(root, 'returned.tar.gz')
      await expect(runTrustedVmPublish({ stage, archivePath })).rejects.toThrow(
        /Publish stage inventory changed/,
      )
      await expect(readFile(archivePath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'a new English source post',
      'src/content/blog/new-post/index.mdx',
      '---\nlang: en\n---\nNew source\n',
    ],
    [
      'a new rendered HTML page',
      'dist/new-page/index.html',
      '<p>New rendered page</p>\n',
    ],
  ])(
    'refuses application if %s appears after staging',
    async (_label, newFile, text) => {
      const root = await fixture()
      try {
        const stage = await createPublishStage({
          repoRoot: root,
          runId: `new-input-${newFile.includes('dist') ? 'html' : 'post'}`,
        })
        const { output } = await validMachineOutput(root)
        try {
          await mkdir(path.dirname(path.join(root, newFile)), {
            recursive: true,
          })
          await writeFile(path.join(root, newFile), text)
          const before = await bytes(root, [
            '.translation/manifest.json',
            '.translation/pages.json',
            'src/content/blog/post/zh.mdx',
          ])
          await expect(
            applyValidatedPublishArtifacts({
              stage,
              outputRoot: output,
              repoRoot: root,
            }),
          ).rejects.toThrow(/Checkout inputs changed/)
          expect(await bytes(root, Object.keys(before))).toEqual(before)
        } finally {
          await rm(output, { recursive: true, force: true })
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

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
        ).rejects.toThrow(
          /protected translation entry changed: pages\.\/about\//,
        )
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects removal of an unknown catalog record, including dotted translation keys', async () => {
    const root = await fixture()
    try {
      await writeFile(
        path.join(root, '.translation', 'pages.json'),
        JSON.stringify({
          pages: {},
          translations: {
            zh: {
              'heading.with.dots': {
                status: 'unknown',
                sourceHash: 'source',
                text: '保留',
              },
            },
          },
        }),
      )
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'unknown-record',
      })
      const { output } = await validMachineOutput(root, {
        pages: { pages: {}, translations: { zh: {} } },
      })
      try {
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(
          /protected translation entry changed: translations\.zh\.heading\.with\.dots/,
        )
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a returned final manifest record relabelled as machine', async () => {
    const root = await fixture()
    try {
      await writeFile(
        path.join(root, '.translation', 'manifest.json'),
        JSON.stringify({
          families: {
            post: {
              targets: {
                zh: {
                  path: 'src/content/blog/post/zh.mdx',
                  status: 'final',
                  note: 'author',
                },
              },
            },
          },
        }),
      )
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'final-record',
      })
      const { output } = await validMachineOutput(root)
      try {
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(
          /protected translation entry changed: families\.post\.targets\.zh/,
        )
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a returned manifest that omits a human-owned sidecar record', async () => {
    const root = await fixture()
    try {
      await writeFile(
        path.join(root, '.translation', 'manifest.json'),
        JSON.stringify({
          families: {
            post: {
              targets: {
                zh: {
                  path: 'src/content/blog/post/zh.mdx',
                  status: 'human',
                  note: 'do not replace',
                },
              },
            },
          },
        }),
      )
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'human-record',
      })
      const { output } = await validMachineOutput(root)
      try {
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(
          /protected translation entry changed: families\.post\.targets\.zh/,
        )
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a sidecar whose returned provenance or source and target hashes are malformed', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'bad-provenance',
      })
      const { output } = await validMachineOutput(root)
      try {
        const manifestPath = path.join(output, '.translation', 'manifest.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.families.post.targets.zh.sourcePath =
          'src/content/blog/other/index.mdx'
        manifest.families.post.targets.zh.targetSha256 =
          'not-a-real-target-hash'
        await writeFile(manifestPath, JSON.stringify(manifest))
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(/Invalid returned machine sidecar/)
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing provider', {}],
    ['mismatched provider', { provider: 'openai' }],
    ['mismatched target locale', { targetLocale: 'ja' }],
    ['mismatched source locale', { sourceLocale: 'zh' }],
  ])('rejects a returned machine sidecar with %s', async (_label, target) => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: `machine-${_label.replaceAll(' ', '-')}`,
      })
      const { output } = await validMachineOutput(root, { target })
      try {
        if (_label === 'missing provider') {
          const manifestPath = path.join(
            output,
            '.translation',
            'manifest.json',
          )
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          delete manifest.families.post.targets.zh.provider
          await writeFile(manifestPath, JSON.stringify(manifest))
        }
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).rejects.toThrow(/Invalid returned machine sidecar/)
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts canonical codex-cli provenance paired with codex frontmatter', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'canonical-codex',
      })
      const { output } = await validMachineOutput(root)
      try {
        await expect(
          validateReturnedPublishArtifacts({ stage, outputRoot: output }),
        ).resolves.toMatchObject({
          files: expect.arrayContaining(['src/content/blog/post/zh.mdx']),
        })
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
        const translation =
          '---\nlang: zh\ntranslationStatus: machine\ntranslationSource: codex\n---\n译文\n'
        await writeFile(
          path.join(output, 'src', 'content', 'blog', 'post', 'zh.mdx'),
          translation,
        )
        await mkdir(path.join(output, '.translation'), { recursive: true })
        const source = await readFile(
          path.join(root, 'src', 'content', 'blog', 'post', 'index.mdx'),
          'utf8',
        )
        await writeFile(
          path.join(output, '.translation', 'manifest.json'),
          JSON.stringify({
            families: {
              post: {
                targets: {
                  zh: {
                    path: 'src/content/blog/post/zh.mdx',
                    status: 'machine',
                    provider: 'codex-cli',
                    targetLocale: 'zh',
                    sourceLocale: 'en',
                    sourcePath: 'src/content/blog/post/index.mdx',
                    sourceSha256: sha256(source),
                    targetSha256: sha256(translation),
                  },
                },
              },
            },
          }),
        )
        await writeFile(
          path.join(output, '.translation', 'pages.json'),
          JSON.stringify({ pages: {} }),
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
        await expect(
          access(
            path.join(
              root,
              'generated',
              'tmp',
              '.translation-transaction',
              'journal.json',
            ),
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['manifest', '.translation/manifest.json'],
    ['catalog', '.translation/pages.json'],
    ['machine sidecar', 'src/content/blog/post/zh.mdx'],
  ])(
    'refuses application when the current %s changes after staging',
    async (_label, changed) => {
      const root = await fixture()
      try {
        const stage = await createPublishStage({
          repoRoot: root,
          runId: `stale-${changed.replaceAll(/[^a-zA-Z0-9-]/gu, '-')}`,
        })
        const { output } = await validMachineOutput(root)
        try {
          if (changed.endsWith('zh.mdx')) {
            await writeFile(
              path.join(root, changed),
              '---\ntranslationStatus: machine\n---\nlocal edit\n',
            )
          } else {
            await writeFile(path.join(root, changed), '{"local":"edit"}\n')
          }
          const before = await bytes(root, [
            '.translation/manifest.json',
            '.translation/pages.json',
            'src/content/blog/post/zh.mdx',
          ])
          await expect(
            applyValidatedPublishArtifacts({
              stage,
              outputRoot: output,
              repoRoot: root,
            }),
          ).rejects.toThrow(/Checkout inputs changed/)
          expect(await bytes(root, Object.keys(before))).toEqual(before)
        } finally {
          await rm(output, { recursive: true, force: true })
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('preflights an existing non-file target before changing any other artifact', async () => {
    const root = await fixture()
    try {
      await writeFile(
        path.join(root, '.translation', 'pages.json'),
        '{"pages":{}}\n',
      )
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'nonfile-target',
      })
      const { output } = await validMachineOutput(root, {
        pages: { pages: {}, translations: {} },
      })
      try {
        const before = await bytes(root, [
          '.translation/manifest.json',
          'src/content/blog/post/zh.mdx',
        ])
        await rm(path.join(root, '.translation', 'pages.json'))
        await mkdir(path.join(root, '.translation', 'pages.json'))
        await expect(
          applyValidatedPublishArtifacts({
            stage,
            outputRoot: output,
            repoRoot: root,
          }),
        ).rejects.toThrow(
          /Checkout inputs changed|Target must be a regular file|Regular files only/,
        )
        expect(await bytes(root, Object.keys(before))).toEqual(before)
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat an unexpected symlink at a new translation target as absent', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'new-target-symlink',
      })
      const { output } = await validMachineOutput(root)
      try {
        const target = path.join(
          root,
          'src',
          'content',
          'blog',
          'post',
          'zh.mdx',
        )
        await symlink(
          path.join(root, 'src', 'content', 'blog', 'post', 'index.mdx'),
          target,
        )
        const before = await bytes(root, [
          '.translation/manifest.json',
          '.translation/pages.json',
        ])
        await expect(
          applyValidatedPublishArtifacts({
            stage,
            outputRoot: output,
            repoRoot: root,
          }),
        ).rejects.toThrow(
          /Symbolic links are not allowed|Target must be a regular file/,
        )
        expect(await bytes(root, Object.keys(before))).toEqual(before)
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds application to the exact bytes that were validated', async () => {
    const root = await fixture()
    try {
      const stage = await createPublishStage({
        repoRoot: root,
        runId: 'output-race',
      })
      const { output } = await validMachineOutput(root)
      try {
        const validatedResult = await validateReturnedPublishArtifacts({
          stage,
          outputRoot: output,
        })
        await writeFile(
          path.join(output, 'src', 'content', 'blog', 'post', 'zh.mdx'),
          '---\nlang: zh\ntranslationStatus: machine\ntranslationSource: codex\n---\ntampered\n',
        )
        const before = await bytes(root, [
          '.translation/manifest.json',
          'src/content/blog/post/zh.mdx',
        ])
        await expect(
          applyValidatedPublishArtifacts({
            stage,
            outputRoot: output,
            repoRoot: root,
            validatedResult,
          }),
        ).rejects.toThrow(/Returned artifact changed while preparing/)
        expect(await bytes(root, Object.keys(before))).toEqual(before)
      } finally {
        await rm(output, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
