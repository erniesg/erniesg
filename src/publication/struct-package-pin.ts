import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

/**
 * The single provenance authority for the pinned Struct package. The pin is
 * read from here and from nowhere else: `package.json`, `package-lock.json`
 * and the installed manifest are cross-checks, never a source of the pin.
 */
export const STRUCT_PACKAGE_PIN_RELATIVE_PATH = 'vendor/struct/provenance.json'

export const structPackageProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    packageName: z.literal('@erniesg/struct'),
    packageVersion: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    artifact: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    integrity: z.string().min(1),
  })
  .passthrough()

export type StructPackageProvenance = z.infer<
  typeof structPackageProvenanceSchema
>

export type StructPackagePin = {
  sourceCommit: string
  artifact: string
  artifactSha256: string
  integrity: string
  packageVersion: string
}

const packageJsonSchema = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .passthrough()

const packageLockSchema = z
  .object({
    packages: z
      .record(
        z.string(),
        z
          .object({
            version: z.string().optional(),
            resolved: z.string().optional(),
            integrity: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

const installedManifestSchema = z
  .object({ version: z.string() })
  .passthrough()

const INSTALLED_PACKAGE_RELATIVE_PATH = 'node_modules/@erniesg/struct/package.json'

/**
 * Parse the provenance and check the one fact that needs no other file: the
 * artifact file name is derived from the version and the source commit, so a
 * renamed or substituted tarball is refused before it is ever read.
 */
function parseProvenance(value: unknown): StructPackageProvenance {
  const provenance = structPackageProvenanceSchema.parse(value)
  const expectedArtifact = `erniesg-struct-${provenance.packageVersion}-${provenance.sourceCommit}.tgz`
  if (provenance.artifact !== expectedArtifact)
    throw new Error(
      `Struct package pin artifact does not match its provenance: expected ${expectedArtifact}, found ${provenance.artifact}`,
    )
  return provenance
}

/**
 * Cross-check the provenance against the on-disk artifact and the manifests.
 * Every mismatch throws; nothing is repaired, defaulted or re-derived.
 */
function resolveStructPackagePin(input: {
  provenance: StructPackageProvenance
  artifactBytes: Uint8Array
  packageJson: unknown
  packageLock: unknown
  installedManifest: unknown
}): StructPackagePin {
  const { provenance } = input
  const artifactSha256 = createHash('sha256')
    .update(input.artifactBytes)
    .digest('hex')
  if (artifactSha256 !== provenance.sha256)
    throw new Error(
      `Struct package pin tarball digest does not match its provenance: expected ${provenance.sha256}, found ${artifactSha256}`,
    )
  const integrity = `sha512-${createHash('sha512')
    .update(input.artifactBytes)
    .digest('base64')}`
  if (integrity !== provenance.integrity)
    throw new Error(
      `Struct package pin integrity does not match its provenance: expected ${provenance.integrity}, found ${integrity}`,
    )
  const specifier = `file:vendor/struct/${provenance.artifact}`
  const dependencies = packageJsonSchema.parse(input.packageJson).dependencies
  if (dependencies['@erniesg/struct'] !== specifier)
    throw new Error(
      `Struct package pin dependency does not match its provenance: expected ${specifier}, found ${dependencies['@erniesg/struct']}`,
    )
  const locked = packageLockSchema
    .parse(input.packageLock)
    .packages?.['node_modules/@erniesg/struct']
  if (
    !locked ||
    locked.version !== provenance.packageVersion ||
    locked.resolved !== specifier ||
    locked.integrity !== provenance.integrity
  )
    throw new Error(
      'Struct package pin lockfile entry does not match its provenance',
    )
  const installedVersion = installedManifestSchema.parse(
    input.installedManifest,
  ).version
  if (installedVersion !== provenance.packageVersion)
    throw new Error(
      `Struct package pin installed version does not match its provenance: expected ${provenance.packageVersion}, found ${installedVersion}`,
    )
  return {
    sourceCommit: provenance.sourceCommit,
    artifact: provenance.artifact,
    artifactSha256: provenance.sha256,
    integrity: provenance.integrity,
    packageVersion: provenance.packageVersion,
  }
}

function pinPaths(repositoryRoot: string) {
  const pinPath = resolve(repositoryRoot, STRUCT_PACKAGE_PIN_RELATIVE_PATH)
  return {
    pinPath,
    artifactPath: (artifact: string) => resolve(dirname(pinPath), artifact),
    packageJsonPath: resolve(repositoryRoot, 'package.json'),
    packageLockPath: resolve(repositoryRoot, 'package-lock.json'),
    installedManifestPath: resolve(repositoryRoot, INSTALLED_PACKAGE_RELATIVE_PATH),
  }
}

/**
 * Read the pinned Struct package provenance and cross-check it against the
 * on-disk tarball, the tarball integrity, `package.json`,
 * `package-lock.json` and the installed package manifest. Any mismatch
 * throws; the pin is never read from a manifest, a constant or a second
 * copy.
 */
export async function readStructPackagePin(
  repositoryRoot = process.cwd(),
): Promise<StructPackagePin> {
  const paths = pinPaths(repositoryRoot)
  const provenance = parseProvenance(
    JSON.parse(await readFile(paths.pinPath, 'utf8')),
  )
  const artifactBytes = await readFile(
    paths.artifactPath(provenance.artifact),
  )
  const [packageJson, packageLock, installedManifest] = await Promise.all([
    readFile(paths.packageJsonPath, 'utf8'),
    readFile(paths.packageLockPath, 'utf8'),
    readFile(paths.installedManifestPath, 'utf8'),
  ])
  return resolveStructPackagePin({
    provenance,
    artifactBytes,
    packageJson: JSON.parse(packageJson),
    packageLock: JSON.parse(packageLock),
    installedManifest: JSON.parse(installedManifest),
  })
}

/**
 * The synchronous twin of {@link readStructPackagePin}, for the synchronous
 * adapters that must build a binding without changing their signature. It
 * reads the same single authority and runs the same cross-checks.
 */
export function readStructPackagePinSync(
  repositoryRoot = process.cwd(),
): StructPackagePin {
  const paths = pinPaths(repositoryRoot)
  const provenance = parseProvenance(
    JSON.parse(readFileSync(paths.pinPath, 'utf8')),
  )
  const artifactBytes = readFileSync(
    paths.artifactPath(provenance.artifact),
  )
  return resolveStructPackagePin({
    provenance,
    artifactBytes,
    packageJson: JSON.parse(readFileSync(paths.packageJsonPath, 'utf8')),
    packageLock: JSON.parse(readFileSync(paths.packageLockPath, 'utf8')),
    installedManifest: JSON.parse(
      readFileSync(paths.installedManifestPath, 'utf8'),
    ),
  })
}
