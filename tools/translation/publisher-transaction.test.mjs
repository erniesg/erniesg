import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  acquirePublisherLease,
  commitPublisherTransaction,
  recoverPublisherTransaction,
} from './publisher-transaction.mjs'

const execFile = promisify(execFileCallback)
const moduleUrl = pathToFileURL(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'publisher-transaction.mjs',
  ),
).href

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'publisher-transaction-'),
  )
  await fs.mkdir(path.join(root, '.translation'), { recursive: true })
  await fs.mkdir(path.join(root, 'src/content/blog/post'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.translation/manifest.json'),
    '{"before":true}\n',
  )
  await fs.writeFile(
    path.join(root, '.translation/pages.json'),
    '{"before":true}\n',
  )
  await fs.writeFile(
    path.join(root, 'src/content/blog/post/zh.mdx'),
    'before\n',
  )
  return root
}

async function body(root, relative) {
  return fs.readFile(path.join(root, relative), 'utf8')
}

describe('publisher transaction', () => {
  it('publishes all prepared artifacts after the final commit guard', async () => {
    const root = await fixture()
    try {
      const release = await acquirePublisherLease({ repoRoot: root })
      let guardCalls = 0
      await commitPublisherTransaction({
        repoRoot: root,
        entries: [
          {
            relative: '.translation/pages.json',
            beforeBytes: Buffer.from('{"before":true}\n'),
            bytes: Buffer.from('{"after":true}\n'),
          },
          {
            relative: 'src/content/blog/post/zh.mdx',
            beforeBytes: Buffer.from('before\n'),
            bytes: Buffer.from('after\n'),
          },
          {
            relative: '.translation/manifest.json',
            beforeBytes: Buffer.from('{"before":true}\n'),
            bytes: Buffer.from('{"after":true}\n'),
          },
        ],
        beforeCommit: async () => {
          guardCalls += 1
        },
      })
      expect(guardCalls).toBe(1)
      expect(await body(root, '.translation/pages.json')).toBe(
        '{"after":true}\n',
      )
      expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe('after\n')
      expect(await body(root, '.translation/manifest.json')).toBe(
        '{"after":true}\n',
      )
      await expect(
        fs.access(
          path.join(
            root,
            'generated/tmp/.translation-transaction/journal.json',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await release()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('refuses paths outside publication artifacts before creating a journal', async () => {
    const root = await fixture()
    try {
      await expect(
        commitPublisherTransaction({
          repoRoot: root,
          entries: [
            {
              relative: '../package.json',
              beforeBytes: null,
              bytes: Buffer.from('bad'),
            },
          ],
        }),
      ).rejects.toThrow(/permitted publication artifact/)
      await expect(
        fs.access(
          path.join(
            root,
            'generated/tmp/.translation-transaction/journal.json',
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('does not follow a symbolic-link publication target', async () => {
    const root = await fixture()
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'publisher-outside-'),
    )
    try {
      const outsideFile = path.join(outside, 'outside.json')
      await fs.writeFile(outsideFile, 'outside\n')
      await fs.rm(path.join(root, '.translation/pages.json'))
      await fs.symlink(outsideFile, path.join(root, '.translation/pages.json'))
      await expect(
        commitPublisherTransaction({
          repoRoot: root,
          entries: [
            {
              relative: '.translation/pages.json',
              beforeBytes: Buffer.from('outside\n'),
              bytes: Buffer.from('changed\n'),
            },
          ],
        }),
      ).rejects.toThrow(/symbolic-link/)
      expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside\n')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('fails closed when an active transaction loses its journal mid-publish', async () => {
    const root = await fixture()
    try {
      await expect(
        commitPublisherTransaction({
          repoRoot: root,
          entries: [
            {
              relative: '.translation/pages.json',
              beforeBytes: Buffer.from('{"before":true}\n'),
              bytes: Buffer.from('{"after":true}\n'),
            },
            {
              relative: 'src/content/blog/post/zh.mdx',
              beforeBytes: Buffer.from('before\n'),
              bytes: Buffer.from('after\n'),
            },
          ],
          onCommitStep: async ({ index }) => {
            if (index !== 1) return
            await fs.unlink(
              path.join(
                root,
                'generated/tmp/.translation-transaction/active/journal.json',
              ),
            )
            throw new Error('stop after journal loss')
          },
        }),
      ).rejects.toThrow('stop after journal loss')
      expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe('before\n')
      await expect(
        recoverPublisherTransaction({ repoRoot: root }),
      ).rejects.toThrow(/missing its journal/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  for (const mutation of ['bytes', 'symlink']) {
    it(`rejects a ${mutation} replacement of a prepared artifact`, async () => {
      const root = await fixture()
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), 'publisher-after-'),
      )
      try {
        await expect(
          commitPublisherTransaction({
            repoRoot: root,
            entries: [
              {
                relative: '.translation/pages.json',
                beforeBytes: Buffer.from('{"before":true}\n'),
                bytes: Buffer.from('{"after":true}\n'),
              },
            ],
            beforeCommit: async () => {
              const prepared = path.join(
                root,
                'generated/tmp/.translation-transaction/active/after-0.bin',
              )
              if (mutation === 'bytes')
                await fs.writeFile(prepared, 'tampered\n')
              else {
                const outsideFile = path.join(outside, 'prepared.bin')
                await fs.writeFile(outsideFile, '{"after":true}\n')
                await fs.unlink(prepared)
                await fs.symlink(outsideFile, prepared)
              }
            },
          }),
        ).rejects.toThrow(/prepared artifact/)
        expect(await body(root, '.translation/pages.json')).toBe(
          '{"before":true}\n',
        )
      } finally {
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(outside, { recursive: true, force: true })
      }
    })
  }

  it('does not overwrite a later target edited after an earlier install', async () => {
    const root = await fixture()
    try {
      await expect(
        commitPublisherTransaction({
          repoRoot: root,
          entries: [
            {
              relative: '.translation/pages.json',
              beforeBytes: Buffer.from('{"before":true}\n'),
              bytes: Buffer.from('{"after":true}\n'),
            },
            {
              relative: 'src/content/blog/post/zh.mdx',
              beforeBytes: Buffer.from('before\n'),
              bytes: Buffer.from('after\n'),
            },
          ],
          onCommitStep: async ({ index }) => {
            if (index === 1)
              await fs.writeFile(
                path.join(root, 'src/content/blog/post/zh.mdx'),
                'external edit\n',
              )
          },
        }),
      ).rejects.toThrow(/changed immediately before publish/)
      expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe(
        'external edit\n',
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  for (const step of [1, 2, 3]) {
    it(`recovers to a single prior state after a process dies following rename ${step}`, async () => {
      const root = await fixture()
      try {
        const script = `
          import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await commitPublisherTransaction({
            repoRoot: ${JSON.stringify(root)},
            entries: [
              { relative: '.translation/pages.json', beforeBytes: Buffer.from('{"before":true}\\n'), bytes: Buffer.from('{"after":true}\\n') },
              { relative: 'src/content/blog/post/zh.mdx', beforeBytes: Buffer.from('before\\n'), bytes: Buffer.from('after\\n') },
              { relative: '.translation/manifest.json', beforeBytes: Buffer.from('{"before":true}\\n'), bytes: Buffer.from('{"after":true}\\n') },
            ],
            onCommitStep: async ({ index }) => { if (index === ${step}) process.kill(process.pid, 'SIGKILL') },
          });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', script]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        await recoverPublisherTransaction({ repoRoot: root })
        const result = await Promise.all([
          body(root, '.translation/pages.json'),
          body(root, 'src/content/blog/post/zh.mdx'),
          body(root, '.translation/manifest.json'),
        ])
        expect(result).toSatisfy(
          (values) =>
            JSON.stringify(values) ===
              JSON.stringify([
                '{"before":true}\n',
                'before\n',
                '{"before":true}\n',
              ]) ||
            JSON.stringify(values) ===
              JSON.stringify([
                '{"after":true}\n',
                'after\n',
                '{"after":true}\n',
              ]),
        )
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const boundary of ['prepare', 'journal']) {
    it(`removes an inactive transaction after a process dies at the ${boundary} boundary`, async () => {
      const root = await fixture()
      try {
        const callback =
          boundary === 'prepare'
            ? "onPrepareStep: async ({ index }) => { if (index === 1) process.kill(process.pid, 'SIGKILL') }"
            : "onJournalDurable: async () => process.kill(process.pid, 'SIGKILL')"
        const script = `
          import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await commitPublisherTransaction({
            repoRoot: ${JSON.stringify(root)},
            entries: [
              { relative: '.translation/pages.json', beforeBytes: Buffer.from('{"before":true}\\n'), bytes: Buffer.from('{"after":true}\\n') },
              { relative: 'src/content/blog/post/zh.mdx', beforeBytes: Buffer.from('before\\n'), bytes: Buffer.from('after\\n') },
            ],
            ${callback},
          });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', script]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        await recoverPublisherTransaction({ repoRoot: root })
        expect(await body(root, '.translation/pages.json')).toBe(
          '{"before":true}\n',
        )
        expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe(
          'before\n',
        )
        await expect(
          fs.readdir(path.join(root, 'generated/tmp/.translation-transaction')),
        ).resolves.toEqual([])
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const phase of ['artifact', 'journal', 'directory']) {
    it(`finishes cleanup after a process dies at the ${phase} cleanup boundary`, async () => {
      const root = await fixture()
      try {
        const script = `
          import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await commitPublisherTransaction({
            repoRoot: ${JSON.stringify(root)},
            entries: [
              { relative: '.translation/pages.json', beforeBytes: Buffer.from('{"before":true}\\n'), bytes: Buffer.from('{"after":true}\\n') },
              { relative: 'src/content/blog/post/zh.mdx', beforeBytes: Buffer.from('before\\n'), bytes: Buffer.from('after\\n') },
            ],
            onCleanupStep: async ({ phase }) => { if (phase === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL') },
          });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', script]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        await recoverPublisherTransaction({ repoRoot: root })
        expect(await body(root, '.translation/pages.json')).toBe(
          '{"after":true}\n',
        )
        expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe('after\n')
        await expect(
          fs.readdir(path.join(root, 'generated/tmp/.translation-transaction')),
        ).resolves.toEqual([])
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  it('recovers a stale lease but never removes a live publisher lease', async () => {
    const root = await fixture()
    try {
      const lock = path.join(root, 'generated/tmp/.translation-publisher.lock')
      await fs.mkdir(path.dirname(lock), { recursive: true })
      await fs.writeFile(
        lock,
        JSON.stringify({
          pid: 999999,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }),
      )
      const release = await acquirePublisherLease({ repoRoot: root })
      await release()
      await fs.writeFile(
        lock,
        JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }),
      )
      await expect(acquirePublisherLease({ repoRoot: root })).rejects.toThrow(
        /already running/,
      )
      await expect(fs.access(lock)).resolves.toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'darwin')(
    'records a macOS boot and process-start identity in the lease',
    async () => {
      const root = await fixture()
      try {
        const release = await acquirePublisherLease({ repoRoot: root })
        const lock = JSON.parse(
          await fs.readFile(
            path.join(root, 'generated/tmp/.translation-publisher.lock'),
            'utf8',
          ),
        )
        expect(lock.bootId).toMatch(/^darwin:\d+:\d+$/)
        expect(lock.processStart).toMatch(
          /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/,
        )
        await release()
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
  )

  it('treats a live reused PID with a different process start as stale', async () => {
    const root = await fixture()
    const identityProvider = async () => ({
      bootId: 'boot-a',
      processStart: 'new-start',
    })
    try {
      const lock = path.join(root, 'generated/tmp/.translation-publisher.lock')
      await fs.mkdir(path.dirname(lock), { recursive: true })
      await fs.writeFile(
        lock,
        JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
          bootId: 'boot-a',
          processStart: 'old-start',
        }),
      )
      const release = await acquirePublisherLease({
        repoRoot: root,
        identityProvider,
      })
      await release()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('recovers a dead publisher journal before replacing its stale lease', async () => {
    const root = await fixture()
    try {
      const script = `
        import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
        await commitPublisherTransaction({
          repoRoot: ${JSON.stringify(root)},
          entries: [
            { relative: '.translation/pages.json', beforeBytes: Buffer.from('{"before":true}\\n'), bytes: Buffer.from('{"after":true}\\n') },
            { relative: 'src/content/blog/post/zh.mdx', beforeBytes: Buffer.from('before\\n'), bytes: Buffer.from('after\\n') },
          ],
          onCommitStep: async () => process.kill(process.pid, 'SIGKILL'),
        });
      `
      await expect(
        execFile(process.execPath, ['--input-type=module', '-e', script]),
      ).rejects.toMatchObject({ signal: 'SIGKILL' })
      const lock = path.join(root, 'generated/tmp/.translation-publisher.lock')
      await fs.writeFile(
        lock,
        JSON.stringify({
          pid: 999999,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }),
      )
      const release = await acquirePublisherLease({ repoRoot: root })
      expect(await body(root, '.translation/pages.json')).toBe(
        '{"before":true}\n',
      )
      expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe('before\n')
      await release()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('descriptor-pinned conditional publication', () => {
  const entries = [
    {
      relative: '.translation/pages.json',
      beforeBytes: Buffer.from('{"before":true}\n'),
      bytes: Buffer.from('{"after":true}\n'),
    },
    {
      relative: 'src/content/blog/post/zh.mdx',
      beforeBytes: Buffer.from('before\n'),
      bytes: Buffer.from('after\n'),
    },
  ]
  const transactionDir = (root) =>
    path.join(root, 'generated/tmp/.translation-transaction')

  it('pins the actual target directory when its pathname becomes an outside symlink', async () => {
    const root = await fixture()
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'publisher-pin-outside-'),
    )
    try {
      await fs.writeFile(path.join(outside, 'pages.json'), 'outside edit\n')
      await expect(
        commitPublisherTransaction({
          repoRoot: root,
          entries,
          onTransactionStep: async ({ boundary, relative }) => {
            if (boundary !== 'prepared' || relative !== entries[0].relative)
              return
            await fs.rename(
              path.join(root, '.translation'),
              path.join(root, '.translation-original'),
            )
            await fs.symlink(outside, path.join(root, '.translation'))
          },
        }),
      ).rejects.toThrow(/symbolic-link|unsafe/)
      expect(await fs.readFile(path.join(outside, 'pages.json'), 'utf8')).toBe(
        'outside edit\n',
      )
      expect(await fs.readdir(outside)).toEqual(['pages.json'])
      expect(await fs.readdir(transactionDir(root))).toContain('active')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  for (const boundary of ['prepared', 'quarantined']) {
    it(`preserves an external install edit made at ${boundary}`, async () => {
      const root = await fixture()
      try {
        await expect(
          commitPublisherTransaction({
            repoRoot: root,
            entries,
            onTransactionStep: async (step) => {
              if (
                step.boundary === boundary &&
                step.relative === entries[0].relative
              )
                await fs.writeFile(
                  path.join(root, step.relative),
                  'external edit\n',
                )
            },
          }),
        ).rejects.toThrow(/changed|exists/)
        expect(await body(root, entries[0].relative)).toBe('external edit\n')
        expect(await fs.readdir(transactionDir(root))).toContain('active')
        await expect(
          recoverPublisherTransaction({ repoRoot: root }),
        ).rejects.toThrow(/changed/)
        expect(await body(root, entries[0].relative)).toBe('external edit\n')
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const boundary of ['prepared', 'quarantined', 'installed']) {
    it(`recovers SIGKILL at the ${boundary} replacement boundary`, async () => {
      const root = await fixture()
      try {
        const script = `
          import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await commitPublisherTransaction({ repoRoot: ${JSON.stringify(root)},
            entries: ${JSON.stringify(entries.map(({ relative, beforeBytes, bytes }) => ({ relative, before: beforeBytes.toString(), after: bytes.toString() })))}.map(e => ({relative:e.relative,beforeBytes:Buffer.from(e.before),bytes:Buffer.from(e.after)})),
            onTransactionStep: async ({boundary}) => { if(boundary === ${JSON.stringify(boundary)}) process.kill(process.pid, 'SIGKILL') }
          });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', script]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        await recoverPublisherTransaction({ repoRoot: root })
        expect(await body(root, entries[0].relative)).toBe(
          entries[0].beforeBytes.toString(),
        )
        expect(await body(root, entries[1].relative)).toBe(
          entries[1].beforeBytes.toString(),
        )
        expect(await fs.readdir(transactionDir(root))).toEqual([])
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const boundary of ['prepared', 'quarantined']) {
    it(`preserves an external restore edit made at ${boundary}`, async () => {
      const root = await fixture()
      try {
        const script = `
          import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await commitPublisherTransaction({ repoRoot: ${JSON.stringify(root)},
            entries: ${JSON.stringify(entries.map(({ relative, beforeBytes, bytes }) => ({ relative, before: beforeBytes.toString(), after: bytes.toString() })))}.map(e => ({relative:e.relative,beforeBytes:Buffer.from(e.before),bytes:Buffer.from(e.after)})),
            onCommitStep: async () => process.kill(process.pid, 'SIGKILL')
          });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', script]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        await expect(
          recoverPublisherTransaction({
            repoRoot: root,
            onTransactionStep: async (step) => {
              if (step.phase === 'restore' && step.boundary === boundary)
                await fs.writeFile(
                  path.join(root, step.relative),
                  'external restore edit\n',
                )
            },
          }),
        ).rejects.toThrow(/changed|exists/)
        expect(await body(root, entries[0].relative)).toBe(
          'external restore edit\n',
        )
        expect(await fs.readdir(transactionDir(root))).toContain('active')
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  it('serializes two stale-lease contenders and preserves the winning live lease', async () => {
    const root = await fixture()
    let release
    try {
      const lock = path.join(root, 'generated/tmp/.translation-publisher.lock')
      await fs.mkdir(path.dirname(lock), { recursive: true })
      await fs.writeFile(
        lock,
        JSON.stringify({ pid: 999999, hostname: os.hostname() }),
      )
      const results = await Promise.allSettled([
        acquirePublisherLease({ repoRoot: root }),
        acquirePublisherLease({ repoRoot: root }),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1)
      release = results.find((result) => result.status === 'fulfilled').value
      const winner = await fs.readFile(lock, 'utf8')
      await expect(acquirePublisherLease({ repoRoot: root })).rejects.toThrow(
        /already running/,
      )
      expect(await fs.readFile(lock, 'utf8')).toBe(winner)
      expect(JSON.parse(winner).pid).toBe(process.pid)
    } finally {
      if (release) await release()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('rollback interruption protocol', () => {
  for (const boundary of ['prepared', 'quarantined', 'installed']) {
    it(`recovers SIGKILL during rollback at ${boundary}`, async () => {
      const root = await fixture()
      try {
        const script = `
          import { commitPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await commitPublisherTransaction({ repoRoot: ${JSON.stringify(root)}, entries: [
            {relative: '.translation/pages.json', beforeBytes: Buffer.from('{"before":true}\\n'), bytes: Buffer.from('{"after":true}\\n')},
            {relative: 'src/content/blog/post/zh.mdx', beforeBytes: Buffer.from('before\\n'), bytes: Buffer.from('after\\n')}
          ], onCommitStep: async () => process.kill(process.pid, 'SIGKILL') });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', script]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        const recovery = `
          import { recoverPublisherTransaction } from ${JSON.stringify(moduleUrl)};
          await recoverPublisherTransaction({repoRoot: ${JSON.stringify(root)},
            onTransactionStep: async ({boundary}) => { if(boundary === ${JSON.stringify(boundary)}) process.kill(process.pid, 'SIGKILL') }
          });
        `
        await expect(
          execFile(process.execPath, ['--input-type=module', '-e', recovery]),
        ).rejects.toMatchObject({ signal: 'SIGKILL' })
        await recoverPublisherTransaction({ repoRoot: root })
        expect(await body(root, '.translation/pages.json')).toBe(
          '{"before":true}\n',
        )
        expect(await body(root, 'src/content/blog/post/zh.mdx')).toBe(
          'before\n',
        )
        expect(
          await fs.readdir(
            path.join(root, 'generated/tmp/.translation-transaction'),
          ),
        ).toEqual([])
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  it('uses no-replace for newly created artifacts', async () => {
    const root = await fixture()
    try {
      await fs.unlink(path.join(root, '.translation/pages.json'))
      await expect(
        commitPublisherTransaction({
          repoRoot: root,
          entries: [
            {
              relative: '.translation/pages.json',
              beforeBytes: null,
              bytes: Buffer.from('published\n'),
            },
          ],
          onTransactionStep: async ({ boundary }) => {
            if (boundary === 'quarantined')
              await fs.writeFile(
                path.join(root, '.translation/pages.json'),
                'external new file\n',
              )
          },
        }),
      ).rejects.toThrow(/exists/)
      expect(await body(root, '.translation/pages.json')).toBe(
        'external new file\n',
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
