import { strFromU8, strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { buildEpub, inspectEpub, profileEpubCss } from './epub'
import { rezipEpub } from './epub-test-utils'
import { researchPaperSchema } from './schema'
import { getTargetProfile, resolveTargetProfile } from './targets'

const paper = researchPaperSchema.parse(rawPaper)

describe('EPUB 3 export', () => {
  it('escapes publication metadata rather than emitting invalid XHTML', async () => {
    const escaped = structuredClone(paper)
    escaped.title = 'Evidence & <meaning>'
    escaped.authors = ['A. "Reader" & Co.']
    const epub = await buildEpub(escaped)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])

    expect(content).toContain('Evidence &amp; &lt;meaning&gt;')
    expect(content).not.toContain('Evidence & <meaning>')
    expect(content).toContain('<title>Evidence &amp; &lt;meaning&gt;</title>')
    expect(opf).toContain('<dc:title>Evidence &amp; &lt;meaning&gt;</dc:title>')

    const placeholderTitle = {
      ...files,
      'EPUB/content.xhtml': strToU8(
        content.replace(
          '<title>Evidence &amp; &lt;meaning&gt;</title>',
          '<title>Publication</title>',
        ),
      ),
    }
    expect(() => inspectEpub(rezipEpub(placeholderTitle))).toThrow(
      /XHTML title.*OPF|OPF title.*XHTML/i,
    )
  })

  it('propagates authoritative publication language, direction, and dates independently of the device profile', async () => {
    const rtlPaper = {
      ...structuredClone(paper),
      language: 'ar',
      baseDirection: 'rtl' as const,
      publicationDate: '2024-08-19',
      artifactModifiedAt: '2026-07-23T00:42:00Z',
    }
    const profile = getTargetProfile('paperProMove')
    const epub = await buildEpub(rtlPaper, profile)
    const { files } = inspectEpub(epub.bytes, profile)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const nav = strFromU8(files['EPUB/nav.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])

    expect(content).toContain('xml:lang="ar" lang="ar" dir="rtl"')
    expect(nav).toContain('xml:lang="ar" lang="ar" dir="rtl"')
    expect(opf).toContain('xml:lang="ar"')
    expect(opf).toContain('<dc:language>ar</dc:language>')
    expect(opf).toContain('<dc:date>2024-08-19</dc:date>')
    expect(opf).toContain(
      '<meta property="dcterms:modified">2026-07-23T00:42:00Z</meta>',
    )
    expect(opf).toContain('page-progression-direction="rtl"')
    expect(opf).not.toContain(
      `page-progression-direction="${profile.epub.pageProgressionDirection}"`,
    )
  })

  it('renders third-order scholarly headings as h4 and mirrors their hierarchy in navigation', async () => {
    const hierarchyPaper = structuredClone(paper)
    hierarchyPaper.nodes = [
      {
        id: 'section-2',
        type: 'heading',
        level: 1,
        text: '2 Methods',
        source: 'synthetic-heading-hierarchy',
      },
      {
        id: 'section-2-2',
        type: 'heading',
        level: 2,
        text: '2.2 Patient profiles',
        source: 'synthetic-heading-hierarchy',
      },
      {
        id: 'section-2-2-1',
        type: 'heading',
        level: 3,
        text: '2.2.1 Patient cohort',
        source: 'synthetic-heading-hierarchy',
      },
    ]

    const epub = await buildEpub(hierarchyPaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const nav = strFromU8(files['EPUB/nav.xhtml'])

    expect(content).toContain(
      '<h2 id="section-2" data-canonical-id="section-2">2 Methods</h2>',
    )
    expect(content).toContain(
      '<h3 id="section-2-2" data-canonical-id="section-2-2">2.2 Patient profiles</h3>',
    )
    expect(content).toContain(
      '<h4 id="section-2-2-1" data-canonical-id="section-2-2-1">2.2.1 Patient cohort</h4>',
    )
    expect(nav).toMatch(
      /2 Methods<\/a><ol><li><a[^>]+>2\.2 Patient profiles<\/a><ol><li><a[^>]+>2\.2\.1 Patient cohort<\/a><\/li><\/ol><\/li><\/ol><\/li>/u,
    )
  })

  it('does not serialize a heading-level jump when source hierarchy starts below its proved parent', async () => {
    const hierarchyPaper = structuredClone(paper)
    hierarchyPaper.nodes = [
      {
        id: 'orphaned-third-order-heading',
        type: 'heading',
        level: 3,
        text: 'A deeply numbered heading without its source ancestors',
        source: 'synthetic-heading-jump',
      },
    ]

    const epub = await buildEpub(hierarchyPaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain(
      '<h2 id="orphaned-third-order-heading" data-canonical-id="orphaned-third-order-heading">A deeply numbered heading without its source ancestors</h2>',
    )
    expect(content).not.toContain('<h4 id="orphaned-third-order-heading"')
  })

  it('pairs EPUB note and bibliography types with their matching DPUB-ARIA roles', async () => {
    const semanticPaper = structuredClone(paper)
    semanticPaper.nodes = [
      {
        id: 'claim',
        type: 'paragraph',
        text: 'Prior work [1]1.',
        noteReferences: [
          {
            id: 'note-reference-1',
            target: 'note-1',
            label: '1',
            start: 14,
            end: 15,
            confidence: 1,
          },
        ],
        inlineRuns: [
          {
            start: 11,
            end: 14,
            relationshipId: 'citation-1',
            semanticRole: 'citation',
            targetIds: ['reference-1'],
          },
        ],
        source: 'synthetic-dpub-aria-role-audit',
      },
      {
        id: 'note-1',
        type: 'footnote',
        kind: 'footnote',
        label: '1',
        text: 'A note.',
        relationships: { backlinks: ['note-reference-1'] },
        source: 'synthetic-dpub-aria-role-audit',
      },
      {
        id: 'reference-1',
        type: 'paragraph',
        text: '[1] Reference entry.',
        source: 'synthetic-dpub-aria-role-audit',
      },
    ]

    const epub = await buildEpub(semanticPaper)
    const { files } = inspectEpub(epub.bytes)
    const content = strFromU8(files['EPUB/content.xhtml'])

    expect(content).toContain('epub:type="biblioref" role="doc-biblioref"')
    expect(content).toContain('epub:type="noteref" role="doc-noteref"')
    expect(content).not.toMatch(
      /<(?!a\b)[^>]+\bepub:type="(?:biblioref|noteref)"/u,
    )
    expect(content).not.toMatch(
      /<a\b(?=[^>]+\bepub:type="biblioref")(?![^>]+\brole="doc-biblioref")[^>]*>/u,
    )
    expect(content).not.toMatch(
      /<a\b(?=[^>]+\bepub:type="noteref")(?![^>]+\brole="doc-noteref")[^>]*>/u,
    )
  })

  it('uses und and omits unproven publication date and direction while preserving profile geometry', async () => {
    const unknownPaper = {
      ...structuredClone(paper),
      language: 'und',
      baseDirection: 'unknown' as const,
      publicationDate: undefined,
      artifactModifiedAt: '2026-07-23T00:42:00Z',
    }
    const profile = getTargetProfile('paperPro')
    const [unknown, baseline] = await Promise.all([
      buildEpub(unknownPaper, profile),
      buildEpub(paper, profile),
    ])
    const { files } = inspectEpub(unknown.bytes, profile)
    const content = strFromU8(files['EPUB/content.xhtml'])
    const nav = strFromU8(files['EPUB/nav.xhtml'])
    const opf = strFromU8(files['EPUB/package.opf'])
    const baselineFiles = inspectEpub(baseline.bytes, profile).files

    expect(content).toContain('xml:lang="und" lang="und"')
    expect(content).not.toMatch(/<html\b[^>]*\sdir=/)
    expect(nav).toContain('xml:lang="und" lang="und"')
    expect(nav).not.toMatch(/<html\b[^>]*\sdir=/)
    expect(opf).toContain('xml:lang="und"')
    expect(opf).toContain('<dc:language>und</dc:language>')
    expect(opf).not.toMatch(/<dc:date\b/)
    expect(opf).not.toContain('page-progression-direction=')
    expect(strFromU8(files['EPUB/styles.css'])).toBe(
      strFromU8(baselineFiles['EPUB/styles.css']),
    )
  })

  it('does not leave a trailing separator when a title slug is truncated', async () => {
    const longTitlePaper = structuredClone(paper)
    longTitlePaper.title = 'word '.repeat(30).trim()

    const epub = await buildEpub(longTitlePaper, getTargetProfile('paperPro'))

    expect(epub.fileName).toMatch(
      /^[a-z0-9]+(?:-[a-z0-9]+)*-paper-pro-[a-f0-9]{12}\.epub$/,
    )
  })

  it('derives deterministic device CSS and progression metadata from profiles', async () => {
    const paperPro = getTargetProfile('paperPro')
    const paperMove = getTargetProfile('paperProMove')
    const sameTitleDifferentPaper = structuredClone(paper)
    sameTitleDifferentPaper.id = `${paper.id}-second`
    const firstTextNode = sameTitleDifferentPaper.nodes.find(
      (
        node,
      ): node is Extract<
        (typeof sameTitleDifferentPaper.nodes)[number],
        { text: string }
      > => 'text' in node,
    )
    if (!firstTextNode) throw new Error('The EPUB identity fixture needs text.')
    firstTextNode.text += ' Distinct canonical content.'
    const [first, second, move, distinct] = await Promise.all([
      buildEpub(paper, paperPro),
      buildEpub(paper, undefined, paperPro),
      buildEpub(paper, paperMove),
      buildEpub(sameTitleDifferentPaper, paperPro),
    ])

    expect(first.bytes).toEqual(second.bytes)
    expect(first.bytes).not.toEqual(move.bytes)
    expect(distinct.fileName).not.toBe(first.fileName)

    const { files, manifest } = inspectEpub(first.bytes, paperPro)
    const moveManifest = inspectEpub(move.bytes, paperMove).manifest as {
      canonicalContentSha256: string
    }
    expect(first.fileName).toBe(
      `semantic-responsive-typesetting-paper-pro-${String(
        (manifest as { canonicalContentSha256: string }).canonicalContentSha256,
      ).slice(0, 12)}.epub`,
    )
    expect(move.fileName).toBe(
      `semantic-responsive-typesetting-paper-pro-move-${moveManifest.canonicalContentSha256.slice(0, 12)}.epub`,
    )
    expect(first.fileName).toMatch(/^[a-z0-9-]+\.epub$/)
    const css = strFromU8(files['EPUB/styles.css'])
    const opf = strFromU8(files['EPUB/package.opf'])
    expect(css).toContain(`font-family: ${paperPro.typography.fontFamily}`)
    expect(css).toContain(`font-size: ${paperPro.typography.bodySizeCssPx}px`)
    expect(css).not.toMatch(/(^|[;{]\s*)direction\s*:/m)
    expect(css).toContain('8.951% 8.025% 8.951% 8.025%')
    expect(css.match(/8\.951% 8\.025% 8\.951% 8\.025%/g)).toHaveLength(1)
    expect(css).toContain('@page { margin: 0; }')
    expect(css).toContain('main { max-width: none; padding:')
    expect(css).toContain(
      'h1, h2, h3, h4, p, figcaption, .orphan-caption, .publication-note, .publication-list, .publication-list-item { overflow-wrap: break-word; word-break: normal; }',
    )
    expect(css).toContain(
      'a, code, pre { overflow-wrap: anywhere; word-break: break-word; }',
    )
    const headingSizes = ['h2', 'h3', 'h4'].map((selector) => {
      const match = css.match(
        new RegExp(`${selector} \\{ font-size: (\\d+)px; \\}`),
      )
      expect(match, `${selector} profile rule`).not.toBeNull()
      return Number(match![1])
    })
    expect(headingSizes[0]).toBeGreaterThan(headingSizes[1])
    expect(headingSizes[1]).toBeGreaterThan(headingSizes[2])
    expect(headingSizes[2]).toBeGreaterThan(paperPro.typography.bodySizeCssPx)
    expect(css).toContain(
      '.publication-list { max-width: 100%; min-width: 0; margin: 0.8rem 0; padding-inline-start: 1.5rem; }',
    )
    expect(css).toContain('*, *::before, *::after { box-sizing: border-box; }')
    expect(css).toContain('main { box-sizing: border-box; width: 100%;')
    expect(css).toContain(
      '.semantic-table-wrapper { max-width: 100%; overflow-x: auto; }',
    )
    expect(css).toContain(
      '.omitted-table-transcript-source { max-width: 100%; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }',
    )
    expect(css).toContain(
      '.source-code { box-sizing: border-box; max-width: 100%; margin: 0; overflow-x: auto; overflow-y: hidden; overflow-wrap: normal;',
    )
    expect(css).toContain('white-space: pre; word-break: normal; }')
    expect(css).toContain(
      '.omitted-visual-transcript, .omitted-table-transcript { border-top: 0.06rem solid currentColor; margin-top: 0.75rem; padding-top: 0.75rem; }',
    )
    expect(css).toContain(
      '.semantic-table-figure, .semantic-table-wrapper, .semantic-table-wrapper table { break-inside: auto; }',
    )
    expect(css).toContain(
      '.semantic-table-wrapper thead { display: table-header-group; }',
    )
    expect(css).toContain(
      '.semantic-table-figure > figcaption { break-before: avoid; }',
    )
    expect(css).toContain('table-layout: fixed')
    expect(css).toContain(
      '.semantic-table-wrapper[data-wide-table="true"] table { min-width: 100%; table-layout: auto; width: auto; }',
    )
    expect(css).toContain(
      '.semantic-table-wrapper[data-wide-table="true"] th, .semantic-table-wrapper[data-wide-table="true"] td { min-width: 3.5rem; overflow-wrap: break-word; word-break: normal; }',
    )
    expect(opf).toContain(
      `page-progression-direction="${paperPro.epub.pageProgressionDirection}"`,
    )
    expect(opf).toContain(
      `<meta property="rendition:flow">${paperPro.epub.renditionFlow}</meta>`,
    )
    expect(manifest).toMatchObject({
      schemaVersion: '1.2.0',
      rendition: 'profile-tuned-reflowable-epub',
      profile: {
        id: 'paperPro',
        version: paperPro.version,
        dimensions: paperPro.dimensions,
        manufacturerDisplay: paperPro.manufacturerDisplay,
        preview: paperPro.preview,
        pixelsPerInch: paperPro.pixelsPerInch,
        compositionPolicy: { id: 'large-eink', version: '1.1.0' },
        exportPolicy: {
          id: 'profile-tuned-reflowable',
          version: '1.2.0',
        },
        truth: {
          geometry: 'authoritative',
          typography: 'advisory',
          pagination: 'reader-controlled',
          orientation: 'reader-controlled',
        },
      },
    })
  })

  it('binds a landscape EPUB filename, bytes, and manifest to transposed profile geometry', async () => {
    const portrait = getTargetProfile('paperPro')
    const landscape = resolveTargetProfile('paperPro', 'landscape')
    const [portraitEpub, landscapeEpub] = await Promise.all([
      buildEpub(paper, portrait),
      buildEpub(paper, landscape),
    ])
    const inspected = inspectEpub(landscapeEpub.bytes, landscape)

    expect(landscapeEpub.fileName).toContain('-paper-pro-landscape-')
    expect(landscapeEpub.bytes).not.toEqual(portraitEpub.bytes)
    expect(landscapeEpub.profile?.orientation.selected).toBe('landscape')
    expect(inspected.manifest).toMatchObject({
      profile: {
        orientation: {
          selected: 'landscape',
          supported: ['portrait', 'landscape'],
        },
        dimensions: {
          width: portrait.dimensions.height,
          height: portrait.dimensions.width,
        },
      },
    })
  })

  it('keeps heading hierarchy monotone and never forces source visuals wider than the viewport', () => {
    for (const profileId of [
      'mobile',
      'paperProMove',
      'paperPro',
      'print',
    ] as const) {
      const profile = getTargetProfile(profileId)
      const css = profileEpubCss(profile)
      const headingSizes = ['h2', 'h3', 'h4'].map((selector) => {
        const match = css.match(
          new RegExp(`${selector} \\{ font-size: (\\d+)px; \\}`),
        )
        expect(match, `${profileId} ${selector} profile rule`).not.toBeNull()
        return Number(match![1])
      })
      expect(headingSizes[0], `${profileId} h2 > h3`).toBeGreaterThan(
        headingSizes[1],
      )
      expect(headingSizes[1], `${profileId} h3 > h4`).toBeGreaterThan(
        headingSizes[2],
      )
      expect(headingSizes[2], `${profileId} h4 > body`).toBeGreaterThan(
        profile.typography.bodySizeCssPx,
      )
      expect(css).toContain(
        '.wide-source-visual-frame { max-width: 100%; overflow: visible; }',
      )
      expect(css).not.toContain(
        '.wide-source-visual-scroll[data-wide-source-visual="true"] img { max-width: none;',
      )
    }

    expect(profileEpubCss(getTargetProfile('mobile'))).not.toContain(
      'min-width: max(100%',
    )
    expect(profileEpubCss(getTargetProfile('paperProMove'))).not.toContain(
      'min-width: max(100%',
    )
  })

  it('rejects profiled EPUB styles that do not match the selected profile', async () => {
    const profile = getTargetProfile('paperPro')
    const epub = await buildEpub(paper, profile)
    const files = unzipSync(epub.bytes)
    const tampered = {
      ...files,
      'EPUB/styles.css': strToU8(
        strFromU8(files['EPUB/styles.css'])
          .replace(
            `html { font-size: ${profile.typography.bodySizeCssPx}px;`,
            'html { font-size: 1px;',
          )
          .replace(
            /main \{ max-width: none; padding: [^;]+;/,
            'main { max-width: none; padding: 0;',
          ),
      ),
    }

    expect(() => inspectEpub(rezipEpub(tampered), profile)).toThrow(
      /profile.*styles|styles.*profile/i,
    )
  })

  it('rejects stale profiled export schema, rendition, and policy metadata', async () => {
    const profile = getTargetProfile('paperProMove')
    const epub = await buildEpub(paper, profile)
    const files = unzipSync(epub.bytes)
    const originalManifest = JSON.parse(
      strFromU8(files['EPUB/export.json']),
    ) as Record<string, any>
    const mutations = [
      (manifest: Record<string, any>) => {
        manifest.schemaVersion = '0.0.0'
      },
      (manifest: Record<string, any>) => {
        manifest.rendition = 'reflowable-epub'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.exportPolicy.id = 'stale-policy'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.exportPolicy.version = '0.0.0'
      },
      (manifest: Record<string, any>) => {
        manifest.profile.typography.bodySizeCssPx = 1
      },
    ]

    for (const mutate of mutations) {
      const manifest = structuredClone(originalManifest)
      mutate(manifest)
      const tampered = {
        ...files,
        'EPUB/export.json': strToU8(`${JSON.stringify(manifest)}\n`),
      }

      expect(() => inspectEpub(rezipEpub(tampered), profile)).toThrow(
        /profiled export manifest contract/i,
      )
    }
  })
})
