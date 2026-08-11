import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const tool = fileURLToPath(
  new URL('./srt-source-output-evidence.mjs', import.meta.url),
)
const fixturePdf = join(
  root,
  'tests/fixtures/pdf/source-output-checkpoints.pdf',
)
const fixtureCheckpoints = join(
  root,
  'tests/fixtures/pdf/source-output-checkpoints.json',
)
const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function privateFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'srt-checkpoint-test-'))
  temporaryDirectories.push(directory)
  const document = join(directory, 'owner-paper.pdf')
  const checkpoints = join(directory, 'owner-checkpoints.json')
  const output = join(directory, 'evidence')
  copyFileSync(fixturePdf, document)
  const checkpointSet = JSON.parse(readFileSync(fixtureCheckpoints, 'utf8'))
  checkpointSet.checkpoints = checkpointSet.checkpoints.map((checkpoint) => ({
    ...checkpoint,
    document: basename(document),
  }))
  writeFileSync(checkpoints, `${JSON.stringify(checkpointSet)}\n`)
  return { document, checkpoints, output }
}

describe('source/output evidence privacy boundary', () => {
  it('renders repository prose checkpoints from the PDF reconstruction path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'srt-checkpoint-test-'))
    temporaryDirectories.push(directory)
    const output = join(directory, 'evidence')
    const result = spawnSync(
      process.execPath,
      [tool, '--output', output],
      { cwd: root, encoding: 'utf8' },
    )

    expect(result.status).toBe(0)
    const manifest = JSON.parse(
      readFileSync(join(output, 'checkpoint-manifest.json'), 'utf8'),
    )
    expect(manifest.result).toBe('passed')
    expect(
      manifest.checkpoints
        .filter(({ property }) =>
          [
            'prose-continuity',
            'hyphen-resolution',
            'markup-non-promotion',
          ].includes(property),
        )
        .every(
          ({ renditionSource }) => renditionSource === 'pdf-reconstruction',
        ),
    ).toBe(true)
  }, 30_000)

  it('does not fabricate a private rendition without caller-provided STRUCT', () => {
    const paths = privateFixture()
    const result = spawnSync(
      process.execPath,
      [
        tool,
        '--document',
        paths.document,
        '--checkpoints',
        paths.checkpoints,
        '--output',
        paths.output,
      ],
      { cwd: root, encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(
      'PRIVATE_STRUCT_REQUIRED',
    )
  })
})
