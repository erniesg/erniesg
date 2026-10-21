import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  APP_PACKAGE_PIN,
  APP_PACKAGE_PIN_REGISTRY,
  approvedPackagePinSchema,
  checkPackagePin,
  type PackagePinBinding,
} from './package-pin'

/**
 * The app's package pin, and the vendor's provenance file of record.
 *
 * ## What this file is
 *
 * `APP_PACKAGE_PIN` is a hand-written constant in `package-pin.ts`; the
 * provenance file is written by the lane that builds and publishes the
 * Struct package. They are two authorities about one artifact, kept in two
 * places, and the production code deliberately never joins them: the pin is
 * a compile-time value on purpose, so that the admission policy cannot
 * depend on a file read at import time.
 *
 * Two authorities that are never compared drift apart. This file is the
 * join, and it is the only place in the repository where the app's pin and
 * the vendor's provenance are compared.
 *
 * ## Why all five fields
 *
 * The admission check names a pin by five fields and refuses a binding that
 * names it in any other way. A guard that compared fewer would let the rest
 * drift unnoticed, which is the failure this file exists to catch: the
 * constant keeps naming the artifact the vendor built while the vendor has
 * moved on, and every release cut under the vendor's real artifact is then
 * refused as unapproved. Fail-closed, but silent.
 *
 * ## The mapping
 *
 * The mapping is the one the design record defines: "The package fields are
 * the fields of the one provenance source, `vendor/struct/provenance.json`
 * (`sourceCommit`, `artifact`, `sha256`, `integrity`, `packageVersion`)"
 * (design record §7.1). The pin's `sourceCommit` is the vendor's
 * `sourceCommit`, the pin's `artifact` is the vendor's `artifact`, the pin's
 * `artifactSha256` is the vendor's `sha256`, the pin's `integrity` is the
 * vendor's `integrity`, and the pin's `version` is the vendor's
 * `packageVersion`.
 *
 * ## What it is not
 *
 * The expected side of every assertion below is read from the vendor's
 * file, so no assertion compares the pin with a restatement of itself. The
 * pin checker is not re-implemented here either: where the admission
 * boundary is in question, the production checker is called.
 */

/** The provenance file of record: the vendor's own statement of the artifact. */
const PROVENANCE_PATH = fileURLToPath(
  new URL('../../vendor/struct/provenance.json', import.meta.url),
)

/** The fields of the provenance file that name the packaged artifact. */
type VendorProvenance = {
  packageName: string
  packageVersion: string
  sourceCommit: string
  artifact: string
  sha256: string
  integrity: string
}

/** The vendor's statement of the artifact, read from the file of record. */
const provenance = JSON.parse(
  readFileSync(PROVENANCE_PATH, 'utf8'),
) as VendorProvenance

/**
 * The source binding the vendor's own artifact identity carries.
 *
 * This is the binding that a release cut under the artifact the vendor
 * actually published carries: the five fields of the source binding, taken
 * from the provenance file. It is built from the vendor's file and not from
 * the pin, so the checks below are about the vendor's artifact rather than
 * about the app's restatement of it.
 */
const vendorBinding: PackagePinBinding = {
  packageSourceCommit: provenance.sourceCommit,
  packageArtifact: provenance.artifact,
  packageArtifactSha256: provenance.sha256,
  packageIntegrity: provenance.integrity,
  packageVersion: provenance.packageVersion,
}

describe('the vendor provenance file of record', () => {
  it('is the provenance of the struct package', () => {
    expect(
      provenance.packageName,
      'vendor/struct/provenance.json must be the provenance of @erniesg/struct',
    ).toBe('@erniesg/struct')
  })

  it('carries a well-formed commit, digest and integrity for the artifact', () => {
    expect(
      provenance.sourceCommit,
      'the provenance file must carry a 40-hex source commit',
    ).toMatch(/^[0-9a-f]{40}$/)
    expect(
      provenance.sha256,
      'the provenance file must carry a 64-hex artifact digest',
    ).toMatch(/^[0-9a-f]{64}$/)
    expect(
      provenance.integrity,
      'the provenance file must carry an integrity string with an algorithm prefix',
    ).toMatch(/^sha\d+-/)
  })

  it('names the artifact after the version and the commit it was built from', () => {
    // The artifact file name is where the vendor's own three identity
    // fields meet: the version of the package it was cut from and the
    // commit it was built from are both in the name. That is what makes the
    // mapping below the mapping the vendor defines, rather than a guess.
    expect(
      provenance.artifact,
      'the artifact name must carry the source commit it was built from',
    ).toContain(provenance.sourceCommit)
    expect(
      provenance.artifact,
      'the artifact name must carry the package version it was cut from',
    ).toContain(provenance.packageVersion)
  })
})

describe('the app package pin against the vendor provenance', () => {
  it('pins the source commit to the commit the vendor built the artifact from', () => {
    expect(
      APP_PACKAGE_PIN.sourceCommit,
      'APP_PACKAGE_PIN.sourceCommit must be the sourceCommit in vendor/struct/provenance.json',
    ).toBe(provenance.sourceCommit)
  })

  it('pins the artifact to the artifact file the vendor published', () => {
    expect(
      APP_PACKAGE_PIN.artifact,
      'APP_PACKAGE_PIN.artifact must be the artifact in vendor/struct/provenance.json',
    ).toBe(provenance.artifact)
  })

  it('pins the artifact digest to the digest the vendor recorded', () => {
    expect(
      APP_PACKAGE_PIN.artifactSha256,
      'APP_PACKAGE_PIN.artifactSha256 must be the sha256 in vendor/struct/provenance.json',
    ).toBe(provenance.sha256)
  })

  it('pins the integrity to the integrity the vendor recorded', () => {
    expect(
      APP_PACKAGE_PIN.integrity,
      'APP_PACKAGE_PIN.integrity must be the integrity in vendor/struct/provenance.json',
    ).toBe(provenance.integrity)
  })

  it('pins the version to the package version the vendor cut the artifact from', () => {
    expect(
      APP_PACKAGE_PIN.version,
      'APP_PACKAGE_PIN.version must be the packageVersion in vendor/struct/provenance.json',
    ).toBe(provenance.packageVersion)
  })

  it('is a well-formed approved pin', () => {
    expect(
      approvedPackagePinSchema.safeParse(APP_PACKAGE_PIN).success,
      'APP_PACKAGE_PIN must satisfy the approved pin schema',
    ).toBe(true)
  })
})

describe('the admission boundary of the app package pin', () => {
  it('admits a release cut under the artifact the vendor published', () => {
    const outcome = checkPackagePin(vendorBinding, APP_PACKAGE_PIN_REGISTRY)

    expect(
      outcome.ok,
      'the vendor artifact of record must be admitted by the app registry',
    ).toBe(true)
    if (outcome.ok) {
      expect(outcome.pin).toEqual(APP_PACKAGE_PIN)
    }
  })

  it('refuses a binding whose source commit is not the pinned commit', () => {
    const outcome = checkPackagePin(
      { ...vendorBinding, packageSourceCommit: 'f'.repeat(40) },
      APP_PACKAGE_PIN_REGISTRY,
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('package_pin_unapproved')
    }
  })

  it('refuses a binding whose artifact is not the pinned artifact', () => {
    const outcome = checkPackagePin(
      { ...vendorBinding, packageArtifact: 'erniesg-struct-0.0.0-drifted.tgz' },
      APP_PACKAGE_PIN_REGISTRY,
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('package_pin_unapproved')
    }
  })

  it('refuses a binding whose artifact digest is not the pinned digest', () => {
    const outcome = checkPackagePin(
      { ...vendorBinding, packageArtifactSha256: 'a'.repeat(64) },
      APP_PACKAGE_PIN_REGISTRY,
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('package_pin_unapproved')
    }
  })

  it('refuses a binding whose integrity is not the pinned integrity', () => {
    const outcome = checkPackagePin(
      { ...vendorBinding, packageIntegrity: 'sha512-drifted' },
      APP_PACKAGE_PIN_REGISTRY,
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('package_pin_unapproved')
    }
  })

  it('refuses a binding whose version is not the pinned version', () => {
    const outcome = checkPackagePin(
      { ...vendorBinding, packageVersion: '9.9.9' },
      APP_PACKAGE_PIN_REGISTRY,
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('package_pin_unapproved')
    }
  })
})
