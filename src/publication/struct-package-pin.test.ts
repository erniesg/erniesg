import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  readStructPackagePin,
  readStructPackagePinSync,
  STRUCT_PACKAGE_PIN_RELATIVE_PATH,
} from './struct-package-pin'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const COMMIT = 'a'.repeat(40)
const ARTIFACT = `erniesg-struct-0.0.0-${COMMIT}.tgz`
const BYTES = Buffer.from('pinned struct tarball bytes')

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const integrity = (bytes: Uint8Array) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`

function provenance() {
  return {
    schemaVersion: 1,
    packageName: '@erniesg/struct',
    packageVersion: '0.0.0',
    sourceCommit: COMMIT,
    artifact: ARTIFACT,
    sha256: sha256(BYTES),
    integrity: integrity(BYTES),
  }
}

async function fakeRepository() {
  const root = await mkdtemp(resolve(tmpdir(), 'struct-package-pin-'))
  await mkdir(resolve(root, 'vendor/struct'), { recursive: true })
  await mkdir(resolve(root, 'node_modules/@erniesg/struct'), { recursive: true })
  await writeFile(resolve(root, 'vendor/struct', ARTIFACT), BYTES)
  await writeFile(
    resolve(root, STRUCT_PACKAGE_PIN_RELATIVE_PATH),
    `${JSON.stringify(provenance(), null, 2)}\n`,
  )
  await writeFile(
    resolve(root, 'package.json'),
    `${JSON.stringify(
      {
        dependencies: {
          '@erniesg/struct': `file:vendor/struct/${ARTIFACT}`,
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    resolve(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        packages: {
          '': {
            dependencies: {
              '@erniesg/struct': `file:vendor/struct/${ARTIFACT}`,
            },
          },
          'node_modules/@erniesg/struct': {
            version: '0.0.0',
            resolved: `file:vendor/struct/${ARTIFACT}`,
            integrity: integrity(BYTES),
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    resolve(root, 'node_modules/@erniesg/struct/package.json'),
    `${JSON.stringify(
      { name: '@erniesg/struct', version: '0.0.0' },
      null,
      2,
    )}\n`,
  )
  return root
}

async function withFakeRepository(
  run: (root: string) => Promise<void> | void,
) {
  const root = await fakeRepository()
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Struct package pin', () => {
  it('reads the checked-in provenance and cross-checks the real tarball', async () => {
    const pin = await readStructPackagePin(repositoryRoot)
    const provenance = JSON.parse(
      await readFile(
        resolve(repositoryRoot, STRUCT_PACKAGE_PIN_RELATIVE_PATH),
        'utf8',
      ),
    )
    expect(pin).toEqual({
      sourceCommit: provenance.sourceCommit,
      artifact: provenance.artifact,
      artifactSha256: provenance.sha256,
      integrity: provenance.integrity,
      packageVersion: provenance.packageVersion,
    })
  })

  it('reads the same pin through the synchronous twin', async () => {
    expect(readStructPackagePinSync(repositoryRoot)).toEqual(
      await readStructPackagePin(repositoryRoot),
    )
  })

  it('rejects a tampered tarball', async () => {
    await withFakeRepository(async (root) => {
      await writeFile(resolve(root, 'vendor/struct', ARTIFACT), 'tampered')
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /tarball digest does not match its provenance/,
      )
    })
  })

  it('rejects a mismatched integrity', async () => {
    await withFakeRepository(async (root) => {
      const tampered = {
        ...provenance(),
        integrity: `sha512-${'A'.repeat(86)}==`,
      }
      await writeFile(
        resolve(root, STRUCT_PACKAGE_PIN_RELATIVE_PATH),
        `${JSON.stringify(tampered, null, 2)}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /integrity does not match its provenance/,
      )
    })
  })

  it('rejects a wrong package version', async () => {
    await withFakeRepository(async (root) => {
      const tampered = { ...provenance(), packageVersion: '0.0.1' }
      await writeFile(
        resolve(root, STRUCT_PACKAGE_PIN_RELATIVE_PATH),
        `${JSON.stringify(tampered, null, 2)}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /artifact does not match its provenance/,
      )
    })
  })

  it('rejects a wrong installed package version', async () => {
    await withFakeRepository(async (root) => {
      await writeFile(
        resolve(root, 'node_modules/@erniesg/struct/package.json'),
        `${JSON.stringify({ name: '@erniesg/struct', version: '9.9.9' }, null, 2)}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /installed version does not match its provenance/,
      )
    })
  })

  it('rejects a missing provenance field', async () => {
    await withFakeRepository(async (root) => {
      const { sourceCommit: _sourceCommit, ...incomplete } = provenance()
      await writeFile(
        resolve(root, STRUCT_PACKAGE_PIN_RELATIVE_PATH),
        `${JSON.stringify(incomplete, null, 2)}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow()
    })
  })

  it('rejects a dependency that points at another artifact', async () => {
    await withFakeRepository(async (root) => {
      await writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify(
          {
            dependencies: {
              '@erniesg/struct': 'file:vendor/struct/some-other-artifact.tgz',
            },
          },
          null,
          2,
        )}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /dependency does not match its provenance/,
      )
    })
  })

  it('rejects a lockfile entry that does not match the provenance', async () => {
    await withFakeRepository(async (root) => {
      await writeFile(
        resolve(root, 'package-lock.json'),
        `${JSON.stringify(
          {
            packages: {
              'node_modules/@erniesg/struct': {
                version: '0.0.0',
                resolved: `file:vendor/struct/${ARTIFACT}`,
                integrity: 'sha512-not-the-pinned-integrity',
              },
            },
          },
          null,
          2,
        )}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /lockfile entry does not match its provenance/,
      )
    })
  })

  it('rejects an artifact whose name does not follow the provenance', async () => {
    await withFakeRepository(async (root) => {
      const tampered = {
        ...provenance(),
        artifact: 'erniesg-struct-0.0.0-deadbeef.tgz',
      }
      await writeFile(
        resolve(root, STRUCT_PACKAGE_PIN_RELATIVE_PATH),
        `${JSON.stringify(tampered, null, 2)}\n`,
      )
      await expect(readStructPackagePin(root)).rejects.toThrow(
        /artifact does not match its provenance/,
      )
    })
  })
})
