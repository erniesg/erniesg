import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mergePageLocaleCatalogs } from './publish-merge-pages.mjs'
import {
  exportPublishOutputs,
  snapshotPublishInputs,
} from './publish-output.mjs'
import { sha256 } from './content.mjs'

const clone = (value) => structuredClone(value)

function pageLocale(status, sourceHash, text) {
  return { status, sourceHash, translations: { s0001: text } }
}

function catalogFixture() {
  return {
    translations: {
      zh: {
        native: { status: 'native', text: '原文' },
        machine: { status: 'machine', text: '旧机器译文' },
      },
      ja: {
        edited: { status: 'edited', text: '編集済み' },
        machine: { status: 'machine', text: '旧機械訳' },
      },
      ko: {
        unknown: { text: '기존 번역' },
        machine: { status: 'machine', text: '이전 기계 번역' },
      },
    },
    pages: {
      '/research/': {
        sourceHash: 'research-source',
        locales: {
          zh: pageLocale('native', 'research-source', '研究'),
          ja: pageLocale('edited', 'research-source', '研究'),
          ko: pageLocale(undefined, 'research-source', '연구'),
        },
      },
      '/about/': {
        sourceHash: 'about-source',
        locales: {
          zh: pageLocale('machine', 'about-source', '关于（旧）'),
          ja: pageLocale('machine', 'about-source', '私について（旧）'),
          ko: pageLocale('machine', 'about-source', '소개（旧）'),
        },
      },
    },
  }
}

function localeCatalog(base, locale, text) {
  const next = clone(base)
  next.translations[locale].machine = { status: 'machine', text }
  next.pages['/about/'].locales[locale] = pageLocale(
    'machine',
    'about-source',
    text,
  )
  return next
}

async function outputFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publish-output-'))
  await Promise.all([
    mkdir(path.join(root, '.translation', 'reports'), { recursive: true }),
    mkdir(path.join(root, 'src', 'content', 'blog', 'post'), {
      recursive: true,
    }),
  ])
  const original = '---\nlang: en\n---\nOriginal body\n'
  const native =
    '---\nlang: zh\ntranslationStatus: final\ntranslationSource: human\n---\n原文\n'
  const machine =
    '---\nlang: ja\ntranslationStatus: machine\ntranslationSource: codex\n---\n旧訳\n'
  const manifest = {
    families: {
      post: {
        targets: {
          ja: {
            path: 'src/content/blog/post/ja.mdx',
            status: 'machine',
            provider: 'codex-cli',
            targetSha256: sha256(machine),
          },
        },
      },
    },
  }
  await Promise.all([
    writeFile(
      path.join(root, '.translation', 'config.json'),
      JSON.stringify({ protectedHumanTranslations: [] }),
    ),
    writeFile(
      path.join(root, '.translation', 'manifest.json'),
      JSON.stringify(manifest),
    ),
    writeFile(path.join(root, '.translation', 'pages.json'), '{"pages":{}}\n'),
    writeFile(
      path.join(root, '.translation', 'reports', 'post.json'),
      '{"status":"pass"}\n',
    ),
    writeFile(
      path.join(root, 'src', 'content', 'blog', 'post', 'index.mdx'),
      original,
    ),
    writeFile(
      path.join(root, 'src', 'content', 'blog', 'post', 'zh.mdx'),
      native,
    ),
    writeFile(
      path.join(root, 'src', 'content', 'blog', 'post', 'ja.mdx'),
      machine,
    ),
  ])
  return { root, original, native, machine, manifest }
}

describe('publish page catalog merge', () => {
  it('merges only each locale output while retaining protected memory and page entries', () => {
    const base = catalogFixture()
    const result = mergePageLocaleCatalogs(base, {
      zh: localeCatalog(base, 'zh', '关于'),
      ja: localeCatalog(base, 'ja', '私について'),
      ko: localeCatalog(base, 'ko', '소개'),
    })

    expect(result.translations.zh.machine.text).toBe('关于')
    expect(result.translations.ja.machine.text).toBe('私について')
    expect(result.translations.ko.machine.text).toBe('소개')
    expect(result.translations.zh.native).toEqual(base.translations.zh.native)
    expect(result.translations.ja.edited).toEqual(base.translations.ja.edited)
    expect(result.translations.ko.unknown).toEqual(base.translations.ko.unknown)
    expect(result.pages['/research/'].locales.zh).toEqual(
      base.pages['/research/'].locales.zh,
    )
    expect(result.pages['/research/'].locales.ja).toEqual(
      base.pages['/research/'].locales.ja,
    )
    expect(result.pages['/research/'].locales.ko).toEqual(
      base.pages['/research/'].locales.ko,
    )
  })

  it('rejects a changed native, edited, or unknown page or translation-memory entry', () => {
    const base = catalogFixture()
    for (const [locale, path, value] of [
      ['zh', ['translations', 'zh', 'native', 'text'], '改写'],
      [
        'ja',
        ['pages', '/research/', 'locales', 'ja', 'translations', 's0001'],
        '変更',
      ],
      ['ko', ['translations', 'ko', 'unknown', 'text'], '변경'],
    ]) {
      const catalogs = {
        zh: localeCatalog(base, 'zh', '关于'),
        ja: localeCatalog(base, 'ja', '私について'),
        ko: localeCatalog(base, 'ko', '소개'),
      }
      let target = catalogs[locale]
      for (const part of path.slice(0, -1)) target = target[part]
      target[path.at(-1)] = value
      expect(() => mergePageLocaleCatalogs(base, catalogs)).toThrow(/Protected/)
    }
  })

  it('rejects locale output produced from a different English source', () => {
    const base = catalogFixture()
    const zh = localeCatalog(base, 'zh', '关于')
    zh.pages['/about/'].sourceHash = 'different-source'
    expect(() =>
      mergePageLocaleCatalogs(base, {
        zh,
        ja: localeCatalog(base, 'ja', '私について'),
        ko: localeCatalog(base, 'ko', '소개'),
      }),
    ).toThrow(/Changed zh source: \/about\//)
  })
})

describe('trusted publish output boundary', () => {
  it('exports metadata plus only changed or new verified machine sidecars', async () => {
    const fixture = await outputFixture()
    const output = await mkdtemp(
      path.join(os.tmpdir(), 'publish-output-result-'),
    )
    try {
      const snapshot = await snapshotPublishInputs(fixture.root)
      expect(snapshot['src/content/blog/post/ja.mdx'].writable).toBe(true)
      expect(snapshot['src/content/blog/post/zh.mdx'].writable).toBe(false)

      const revised =
        '---\nlang: ja\ntranslationStatus: machine\ntranslationSource: codex\n---\n新しい訳\n'
      const manifest = clone(fixture.manifest)
      manifest.families.post.targets.ja.targetSha256 = sha256(revised)
      await Promise.all([
        writeFile(
          path.join(fixture.root, 'src', 'content', 'blog', 'post', 'ja.mdx'),
          revised,
        ),
        writeFile(
          path.join(fixture.root, '.translation', 'manifest.json'),
          JSON.stringify(manifest),
        ),
        writeFile(
          path.join(fixture.root, 'src', 'content', 'blog', 'post', 'ko.mdx'),
          '---\nlang: ko\ntranslationStatus: machine\ntranslationSource: codex\n---\n새 번역\n',
        ),
      ])

      const artifacts = await exportPublishOutputs({
        root: fixture.root,
        snapshot,
        output,
      })
      expect(artifacts).toEqual(
        expect.arrayContaining([
          '.translation/manifest.json',
          '.translation/pages.json',
          '.translation/reports/post.json',
          'src/content/blog/post/ja.mdx',
          'src/content/blog/post/ko.mdx',
        ]),
      )
      expect(artifacts).not.toContain('src/content/blog/post/index.mdx')
      expect(artifacts).not.toContain('src/content/blog/post/zh.mdx')
      await expect(
        readFile(path.join(output, 'src/content/blog/post/ja.mdx'), 'utf8'),
      ).resolves.toBe(revised)
      await expect(
        readFile(path.join(output, 'src/content/blog/post/zh.mdx'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
      await rm(output, { recursive: true, force: true })
    }
  })

  it('aborts when an English original or human-owned native sidecar changes', async () => {
    const fixture = await outputFixture()
    const output = await mkdtemp(
      path.join(os.tmpdir(), 'publish-output-result-'),
    )
    try {
      const snapshot = await snapshotPublishInputs(fixture.root)
      await writeFile(
        path.join(fixture.root, 'src', 'content', 'blog', 'post', 'index.mdx'),
        '---\nlang: en\n---\nChanged original\n',
      )
      await expect(
        exportPublishOutputs({ root: fixture.root, snapshot, output }),
      ).rejects.toThrow(/Original or human-owned content changed: .*index\.mdx/)

      await writeFile(
        path.join(fixture.root, 'src', 'content', 'blog', 'post', 'index.mdx'),
        fixture.original,
      )
      await writeFile(
        path.join(fixture.root, 'src', 'content', 'blog', 'post', 'zh.mdx'),
        `${fixture.native}changed`,
      )
      await expect(
        exportPublishOutputs({ root: fixture.root, snapshot, output }),
      ).rejects.toThrow(/Original or human-owned content changed: .*zh\.mdx/)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
      await rm(output, { recursive: true, force: true })
    }
  })

  it('throws when a snapshot original disappears before export', async () => {
    const fixture = await outputFixture()
    const output = await mkdtemp(
      path.join(os.tmpdir(), 'publish-output-result-'),
    )
    try {
      const snapshot = await snapshotPublishInputs(fixture.root)
      await rm(
        path.join(fixture.root, 'src', 'content', 'blog', 'post', 'index.mdx'),
      )
      await expect(
        exportPublishOutputs({ root: fixture.root, snapshot, output }),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
      await rm(output, { recursive: true, force: true })
    }
  })
})
