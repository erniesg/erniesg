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
import { furnitureContaminationCountFromReconstruction } from './srt-source-output-evidence.mjs'

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

  it('derives the furniture checkpoint counter from reconstruction evidence', () => {
    expect(
      furnitureContaminationCountFromReconstruction({
        completeness: { furnitureContaminationCount: 3 },
        regions: [],
      }),
    ).toBe(3)
    expect(
      furnitureContaminationCountFromReconstruction({
        regions: [
          {
            furniture: { classification: 'repeated-text' },
            includedInReadingOrder: true,
          },
          {
            furniture: { classification: 'repeated-text' },
            includedInReadingOrder: false,
          },
          { includedInReadingOrder: true },
        ],
      }),
    ).toBe(1)
  })
})
