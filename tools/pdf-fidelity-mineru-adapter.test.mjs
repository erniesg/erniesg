import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import * as fidelityEval from './pdf-fidelity-eval.mjs'

import {
  cachePageDirectory,
  createMineruCacheIdentity,
  createMineruCacheMetadata,
  normalizeMineruPredictions,
  observeMineruExecutable,
} from './pdf-fidelity-mineru-adapter.mjs'

const adapterPath = fileURLToPath(
  new URL('./pdf-fidelity-mineru-adapter.mjs', import.meta.url),
)
const temporaryDirectories = []

function request(cases) {
  return {
    schemaVersion: '1.1.0',
    privacy: 'owner-local-paths-present-ephemeral-delete-after-run',
    evalSet: { id: 'fixture-eval-v1', sha256: 'e'.repeat(64) },
    candidate: {
      id: 'mineru-local',
      version: '3.1.14-MinerU2.5-Pro-2604-1.2B',
      adapterSha256: 'a'.repeat(64),
    },
    documents: [
      {
        id: 'paper-v1',
        path: '/owner-only/paper-v1.pdf',
        byteLength: 123,
        sha256: 'd'.repeat(64),
        pageCount: 2,
      },
    ],
    cases,
  }
}

function target(id, kind, box) {
  void kind
  return { id, kind: 'candidate', box }
}

function evalCase({ id, page, task, targets, stratum = 'fixture' }) {
  return {
    id,
    documentId: 'paper-v1',
    page,
    stratum,
    task,
    targets,
  }
}

function contentByPage() {
  return new Map([
    [
      'paper-v1:1',
      {
        v1: [
          {
            type: 'image',
            page_idx: 0,
            bbox: [520, 260, 860, 350],
            img_path: '/private/images/first-panel.jpg',
            image_caption: ['(b) Interactive outline'],
          },
          {
            type: 'image',
            page_idx: 0,
            bbox: [520, 360, 860, 460],
            img_path: '/private/images/second-panel.jpg',
            image_caption: [
              '(a) Hierarchical outline',
              '(c) Dynamic outline',
              'Figure 1: private caption canary',
            ],
          },
          {
            type: 'page_footnote',
            page_idx: 0,
            bbox: [90, 870, 475, 895],
            text: '$^{1}$ private affiliation canary',
          },
          {
            type: 'text',
            page_idx: 0,
            bbox: [340, 175, 630, 195],
            text: 'Ada Example $^{1}$ Ben Reader $^{1}$',
          },
        ],
        v2: [
          {
            type: 'paragraph',
            bbox: [118, 700, 489, 875],
            content: { paragraph_content: [{ type: 'text', content: 'left' }] },
          },
          {
            type: 'title',
            bbox: [514, 85, 875, 115],
            content: {
              title_content: [{ type: 'text', content: 'right head' }],
            },
          },
          {
            type: 'paragraph',
            bbox: [513, 112, 884, 750],
            content: {
              paragraph_content: [{ type: 'text', content: 'right' }],
            },
          },
        ],
      },
    ],
    [
      'paper-v1:2',
      {
        v1: [
          {
            type: 'table',
            page_idx: 0,
            bbox: [188, 80, 806, 167],
            table_body:
              '<table><tr><th>Method</th><th>Score</th></tr><tr><td>A</td><td>1</td></tr></table>',
            table_caption: ['Table 1: private table caption'],
          },
          {
            type: 'equation',
            page_idx: 0,
            bbox: [573, 469, 727, 489],
            text: '$$private-equation-line-one$$',
          },
          {
            type: 'equation',
            page_idx: 0,
            bbox: [575, 491, 885, 511],
            text: '$$private-equation-line-two\\tag{1}$$',
          },
          {
            type: 'equation',
            page_idx: 0,
            bbox: [570, 513, 750, 532],
            text: '$$private-equation-line-three$$',
          },
        ],
        v2: [],
      },
    ],
  ])
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('local MinerU fidelity adapter', () => {
  it('normalizes only bounded native decisions and preserves native page geometry', () => {
    const cases = [
      evalCase({
        id: 'figure-boundary',
        page: 1,
        task: 'detection',
        targets: [],
      }),
      evalCase({
        id: 'caption-owner',
        page: 1,
        task: 'relationship',
        targets: [
          target('figure-1', 'figure', [0.514, 0.269, 0.37, 0.205]),
          target('caption-1', 'caption', [0.514, 0.486, 0.37, 0.153]),
        ],
      }),
      evalCase({
        id: 'footnote-role',
        page: 1,
        task: 'classification',
        targets: [
          target(
            'affiliation-footnote',
            'footnote',
            [0.09, 0.87, 0.385, 0.025],
          ),
        ],
      }),
      evalCase({
        id: 'note-owner',
        page: 1,
        task: 'relationship',
        targets: [
          target(
            'author-note-reference-1',
            'note-reference',
            [0.5, 0.18, 0.012, 0.012],
          ),
          target(
            'affiliation-footnote',
            'footnote',
            [0.09, 0.87, 0.385, 0.025],
          ),
        ],
      }),
      evalCase({
        id: 'heading-role',
        page: 1,
        task: 'classification',
        targets: [target('section-3-2', 'heading', [0.514, 0.085, 0.36, 0.03])],
      }),
      evalCase({
        id: 'column-order',
        page: 1,
        task: 'reading-order',
        targets: [
          target('left-column-tail', 'prose', [0.118, 0.7, 0.371, 0.175]),
          target('right-column-head', 'heading', [0.514, 0.085, 0.36, 0.03]),
          target('right-column-prose', 'prose', [0.513, 0.112, 0.371, 0.638]),
        ],
      }),
      evalCase({
        id: 'table-structure',
        page: 2,
        task: 'classification',
        targets: [target('table-1', 'table', [0.188, 0.08, 0.618, 0.087])],
      }),
      evalCase({
        id: 'equation-group',
        page: 2,
        task: 'detection',
        targets: [],
      }),
      evalCase({
        id: 'unsupported-invariant',
        page: 1,
        task: 'classification',
        targets: [target('title-invariant', 'document-invariant', null)],
      }),
      evalCase({
        id: 'tiny-probe-inside-prose',
        page: 1,
        task: 'classification',
        targets: [target('tiny-probe', 'candidate', [0.35, 0.177, 0.01, 0.01])],
      }),
    ]

    const predictions = normalizeMineruPredictions(
      request(cases),
      contentByPage(),
    )

    expect(predictions.candidate).toEqual({
      id: 'mineru-local',
      version: '3.1.14-MinerU2.5-Pro-2604-1.2B',
      format: 'mineru-content-list',
      formatVersion: 'content-list-v1-v2-adapter-1.1.0',
      adapterSha256: 'a'.repeat(64),
      runtimeIdentity: {
        status: 'unattested',
        tool: null,
        model: null,
      },
    })
    expect(predictions.cases).toEqual([
      {
        caseId: 'figure-boundary',
        output: {
          objects: [
            {
              id: 'mineru-figure-p001-001',
              label: 'figure',
              box: [0.52, 0.26, 0.34, 0.2],
            },
            {
              id: 'mineru-footnote-p001-001',
              label: 'footnote',
              box: [0.09, 0.87, 0.385, 0.025],
            },
          ],
        },
      },
      {
        caseId: 'caption-owner',
        output: {
          relationships: [
            {
              type: 'caption-of',
              sourceId: 'caption-1',
              targetId: 'figure-1',
            },
          ],
        },
      },
      {
        caseId: 'footnote-role',
        output: {
          labels: [{ targetId: 'affiliation-footnote', label: 'footnote' }],
        },
      },
      {
        caseId: 'note-owner',
        output: {
          relationships: [
            {
              type: 'note-body-of',
              sourceId: 'affiliation-footnote',
              targetId: 'author-note-reference-1',
            },
          ],
        },
      },
      {
        caseId: 'heading-role',
        output: {
          labels: [{ targetId: 'section-3-2', label: 'heading' }],
        },
      },
      {
        caseId: 'column-order',
        output: {
          order: [
            'left-column-tail',
            'right-column-head',
            'right-column-prose',
          ],
        },
      },
      {
        caseId: 'table-structure',
        output: {
          labels: [{ targetId: 'table-1', label: 'semantic-table' }],
        },
      },
      {
        caseId: 'equation-group',
        output: {
          objects: [
            {
              id: 'mineru-table-p002-001',
              label: 'table',
              box: [0.188, 0.08, 0.618, 0.087],
            },
            {
              id: 'mineru-equation-p002-001',
              label: 'equation',
              box: [0.57, 0.469, 0.315, 0.063],
            },
          ],
        },
      },
    ])
    const serialized = JSON.stringify(predictions)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('owner-only')
    expect(serialized).not.toContain('equation-line')
  })

  it('rejects a request containing expected answers', () => {
    const cases = [
      {
        ...evalCase({
          id: 'gold-leak',
          page: 1,
          task: 'classification',
          targets: [target('note', 'footnote', [0.1, 0.8, 0.4, 0.05])],
        }),
        expected: { labels: [{ targetId: 'note', label: 'footnote' }] },
      },
    ]

    expect(() =>
      normalizeMineruPredictions(request(cases), contentByPage()),
    ).toThrow('MINERU_ADAPTER_REQUEST_CONTAINS_GOLD')

    const criticalRequest = request(
      cases.map(({ expected: _expected, ...item }) => item),
    )
    criticalRequest.cases[0].critical = true
    expect(() =>
      normalizeMineruPredictions(criticalRequest, contentByPage()),
    ).toThrow('MINERU_ADAPTER_REQUEST_CONTAINS_GOLD')

    const semanticTargetRequest = request([
      evalCase({
        id: 'semantic-kind-leak',
        page: 1,
        task: 'classification',
        targets: [
          {
            id: 'opaque-target',
            kind: 'footnote',
            box: [0.09, 0.87, 0.385, 0.025],
          },
        ],
      }),
    ])
    expect(() =>
      normalizeMineruPredictions(semanticTargetRequest, contentByPage()),
    ).toThrow('INVALID_MINERU_ADAPTER_REQUEST')

    const detectionGoldRequest = request([
      evalCase({
        id: 'detection-box-leak',
        page: 1,
        task: 'detection',
        targets: [target('opaque-target', 'candidate', [0.5, 0.2, 0.4, 0.3])],
      }),
    ])
    expect(() =>
      normalizeMineruPredictions(detectionGoldRequest, contentByPage()),
    ).toThrow('INVALID_MINERU_ADAPTER_REQUEST')
  })

  it('requires rectangular nonempty cells and source header evidence for semantic tables', () => {
    const cases = [
      evalCase({
        id: 'table-structure',
        page: 2,
        task: 'classification',
        targets: [target('table-1', 'table', [0.188, 0.08, 0.618, 0.087])],
      }),
    ]
    const headerless = contentByPage()
    headerless.get('paper-v1:2').v1[0].table_body =
      '<table><tr><td>Method</td><td>Score</td></tr><tr><td>A</td><td>1</td></tr></table>'
    const ragged = contentByPage()
    ragged.get('paper-v1:2').v1[0].table_body =
      '<table><tr><th>Method</th><th>Score</th></tr><tr><td>A</td></tr></table>'

    expect(
      normalizeMineruPredictions(request(cases), headerless).cases,
    ).toEqual([
      {
        caseId: 'table-structure',
        output: { labels: [{ targetId: 'table-1', label: 'table-image' }] },
      },
    ])
    expect(normalizeMineruPredictions(request(cases), ragged).cases).toEqual([
      {
        caseId: 'table-structure',
        output: { labels: [{ targetId: 'table-1', label: 'table-image' }] },
      },
    ])
  })

  it('separates cache namespaces by candidate, adapter, backend, and parser configuration', () => {
    const firstRequest = request([])
    const secondRequest = structuredClone(firstRequest)
    secondRequest.candidate.version = '3.1.15-MinerU2.6-Pro-2605-1.3B'
    const executableIdentity = {
      id: 'mineru',
      version: '3.1.14',
      executableSha256: 'b'.repeat(64),
      versionOutputSha256: 'c'.repeat(64),
    }
    const modelIdentity = {
      id: 'MinerU2.5-Pro-2604-1.2B',
      sha256: 'd'.repeat(64),
    }
    const first = createMineruCacheIdentity(firstRequest, {
      backend: 'vlm-auto-engine',
      executableIdentity,
      modelIdentity,
    })
    const second = createMineruCacheIdentity(secondRequest, {
      backend: 'vlm-auto-engine',
      executableIdentity,
      modelIdentity,
    })
    const alternateBackend = createMineruCacheIdentity(firstRequest, {
      backend: 'pipeline',
      executableIdentity,
      modelIdentity,
    })
    const alternateConfiguration = {
      ...first,
      configuration: { ...first.configuration, imageAnalysis: false },
    }
    const paths = [first, second, alternateBackend, alternateConfiguration].map(
      (identity) =>
        cachePageDirectory(
          '/owner-only/cache',
          firstRequest.documents[0],
          1,
          identity,
        ),
    )

    expect(new Set(paths).size).toBe(paths.length)
    const changedBinary = createMineruCacheIdentity(firstRequest, {
      backend: 'vlm-auto-engine',
      executableIdentity: {
        ...executableIdentity,
        executableSha256: 'e'.repeat(64),
      },
      modelIdentity,
    })
    expect(
      cachePageDirectory(
        '/owner-only/cache',
        firstRequest.documents[0],
        1,
        changedBinary,
      ),
    ).not.toBe(paths[0])
    expect(
      createMineruCacheMetadata(first, firstRequest.documents[0], 1),
    ).toMatchObject({
      schemaVersion: '1.1.0',
      identity: first,
      documentSha256: firstRequest.documents[0].sha256,
      page: 1,
    })
  })

  it('rotates the cache namespace when only a local adapter dependency changes', async () => {
    expect(typeof fidelityEval.createAdapterSourceIdentity).toBe('function')
    const root = await mkdtemp(join(tmpdir(), 'srt-mineru-source-identity-'))
    temporaryDirectories.push(root)
    const entryPath = join(root, 'adapter.mjs')
    const dependencyPath = join(root, 'dependency.mjs')
    await writeFile(
      entryPath,
      "import { value } from './dependency.mjs'\nvoid value\n",
    )
    await writeFile(dependencyPath, "export const value = 'first'\n")
    const firstSourceIdentity =
      await fidelityEval.createAdapterSourceIdentity(entryPath)
    await writeFile(dependencyPath, "export const value = 'second'\n")
    const secondSourceIdentity =
      await fidelityEval.createAdapterSourceIdentity(entryPath)
    const firstRequest = request([])
    firstRequest.candidate.adapterSha256 = firstSourceIdentity.sha256
    const secondRequest = structuredClone(firstRequest)
    secondRequest.candidate.adapterSha256 = secondSourceIdentity.sha256
    const executableIdentity = {
      id: 'mineru',
      version: '3.1.14',
      executableSha256: 'b'.repeat(64),
      versionOutputSha256: 'c'.repeat(64),
    }
    const firstCacheIdentity = createMineruCacheIdentity(firstRequest, {
      executableIdentity,
      modelIdentity: null,
    })
    const secondCacheIdentity = createMineruCacheIdentity(secondRequest, {
      executableIdentity,
      modelIdentity: null,
    })
    const firstPath = cachePageDirectory(
      '/owner-only/cache',
      firstRequest.documents[0],
      1,
      firstCacheIdentity,
    )
    const secondPath = cachePageDirectory(
      '/owner-only/cache',
      secondRequest.documents[0],
      1,
      secondCacheIdentity,
    )

    expect(secondSourceIdentity.sha256).not.toBe(firstSourceIdentity.sha256)
    expect(secondPath).not.toBe(firstPath)
    expect(secondPath).toContain('mineru-content-list-cache-v3')
  })

  it('uses an attested hash-and-page-keyed cache without running model extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'srt-mineru-adapter-test-'))
    temporaryDirectories.push(root)
    const cacheRoot = join(root, 'cache')
    const output = join(root, 'predictions.json')
    const mineruBin = join(root, 'fake-mineru')
    await writeFile(
      mineruBin,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "mineru 3.1.14\\n"; exit 0; fi\nexit 97\n',
      { mode: 0o700 },
    )
    await chmod(mineruBin, 0o700)
    const requestPath = join(root, 'request.json')
    const cases = [
      evalCase({
        id: 'table-structure',
        page: 2,
        task: 'classification',
        targets: [target('table-1', 'table', [0.188, 0.08, 0.618, 0.087])],
      }),
    ]
    const adapterSha256 = (
      await fidelityEval.createAdapterSourceIdentity(adapterPath)
    ).sha256
    const adapterRequest = request(cases)
    adapterRequest.candidate.adapterSha256 = adapterSha256
    const executableIdentity = await observeMineruExecutable(mineruBin)
    const cacheIdentity = createMineruCacheIdentity(adapterRequest, {
      backend: 'vlm-auto-engine',
      executableIdentity,
      modelIdentity: null,
    })
    const pageDirectory = cachePageDirectory(
      cacheRoot,
      adapterRequest.documents[0],
      2,
      cacheIdentity,
    )
    const nativeDirectory = join(pageDirectory, 'paper-v1', 'vlm')
    await mkdir(nativeDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(pageDirectory, 'cache-identity.json'),
      JSON.stringify(
        createMineruCacheMetadata(
          cacheIdentity,
          adapterRequest.documents[0],
          2,
        ),
      ),
      { mode: 0o600 },
    )
    await writeFile(
      join(nativeDirectory, 'paper-v1_content_list.json'),
      JSON.stringify(contentByPage().get('paper-v1:2').v1),
      { mode: 0o600 },
    )
    await writeFile(
      join(nativeDirectory, 'paper-v1_content_list_v2.json'),
      JSON.stringify([contentByPage().get('paper-v1:2').v2]),
      { mode: 0o600 },
    )
    await writeFile(requestPath, JSON.stringify(adapterRequest), {
      mode: 0o600,
    })
    const result = spawnSync(
      adapterPath,
      [
        '--request',
        requestPath,
        '--output',
        output,
        '--cache-root',
        cacheRoot,
        '--mineru-bin',
        mineruBin,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SRT_PDF_EVAL_OFFLINE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(output, 'utf8')).cases).toEqual([
      {
        caseId: 'table-structure',
        output: {
          labels: [{ targetId: 'table-1', label: 'semantic-table' }],
        },
      },
    ])
  })

  it('accepts exactly one gold-stripped public request from stdin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'srt-mineru-stdin-test-'))
    temporaryDirectories.push(root)
    const cacheRoot = join(root, 'cache')
    const output = join(root, 'predictions.json')
    const mineruBin = join(root, 'fake-mineru')
    await writeFile(
      mineruBin,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "mineru 3.1.14\\n"; exit 0; fi\nexit 97\n',
      { mode: 0o700 },
    )
    await chmod(mineruBin, 0o700)
    const cases = [
      evalCase({
        id: 'table-structure',
        page: 2,
        task: 'classification',
        targets: [
          target('opaque-target', 'candidate', [0.188, 0.08, 0.618, 0.087]),
        ],
      }),
    ]
    const adapterSha256 = (
      await fidelityEval.createAdapterSourceIdentity(adapterPath)
    ).sha256
    const adapterRequest = request(cases)
    adapterRequest.candidate.adapterSha256 = adapterSha256
    const executableIdentity = await observeMineruExecutable(mineruBin)
    const cacheIdentity = createMineruCacheIdentity(adapterRequest, {
      backend: 'vlm-auto-engine',
      executableIdentity,
      modelIdentity: null,
    })
    const pageDirectory = cachePageDirectory(
      cacheRoot,
      adapterRequest.documents[0],
      2,
      cacheIdentity,
    )
    const nativeDirectory = join(pageDirectory, 'paper-v1', 'vlm')
    await mkdir(nativeDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      join(pageDirectory, 'cache-identity.json'),
      JSON.stringify(
        createMineruCacheMetadata(
          cacheIdentity,
          adapterRequest.documents[0],
          2,
        ),
      ),
      { mode: 0o600 },
    )
    await writeFile(
      join(nativeDirectory, 'paper-v1_content_list.json'),
      JSON.stringify(contentByPage().get('paper-v1:2').v1),
      { mode: 0o600 },
    )

    const result = spawnSync(
      adapterPath,
      [
        '--output',
        output,
        '--cache-root',
        cacheRoot,
        '--mineru-bin',
        mineruBin,
      ],
      {
        input: JSON.stringify(adapterRequest),
        encoding: 'utf8',
        env: {
          ...process.env,
          SRT_PDF_EVAL_OFFLINE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(output, 'utf8')).cases[0]).toEqual({
      caseId: 'table-structure',
      output: {
        labels: [{ targetId: 'opaque-target', label: 'semantic-table' }],
      },
    })
  })
})
