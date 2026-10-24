/**
 * The guard on the app's own Struct package pin.
 *
 * The pin is a hand-stated constant (`APP_PACKAGE_PIN`) so that the policy is
 * a compile-time constant of the app and not a file read at import time. The
 * price of a hand-stated constant is that it can drift away from the
 * provenance file of record, and the price of a drift is a **refusal**: a
 * release cut under the vendored artifact would be refused with
 * `package_pin_unapproved`, because the binding names a pin the registry does
 * not hold.
 *
 * This test is the thing that stops the drift. It reads
 * `vendor/struct/provenance.json` — the file of record, the same one
 * `package.json` and `package-lock.json` resolve against — and compares **all
 * five** fields of the pin with it. It is deliberately a field-for-field
 * comparison and not a digest of a subset: a pin is one artifact, so a
 * half-updated pin is a broken pin and must fail here.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  APP_PACKAGE_PIN,
  APP_PACKAGE_PIN_REGISTRY,
  bindingNamesPin,
  checkPackagePin,
  currentPackagePin,
  findApprovedPin,
  orderedPins,
} from './package-pin'

/** The provenance file of record, relative to the repository root. */
const PROVENANCE_PATH = 'vendor/struct/provenance.json'

type Provenance = {
  packageName: string
  packageVersion: string
  sourceCommit: string
  artifact: string
  sha256: string
  integrity: string
}

function readProvenance(): Provenance {
  const path = resolve(process.cwd(), PROVENANCE_PATH)
  return JSON.parse(readFileSync(path, 'utf8')) as Provenance
}

describe('the app package pin', () => {
  it('names the artifact the provenance file of record names', () => {
    const provenance = readProvenance()

    expect(provenance.packageName).toBe('@erniesg/struct')
    expect(APP_PACKAGE_PIN.sourceCommit).toBe(provenance.sourceCommit)
    expect(APP_PACKAGE_PIN.artifact).toBe(provenance.artifact)
    expect(APP_PACKAGE_PIN.artifactSha256).toBe(provenance.sha256)
    expect(APP_PACKAGE_PIN.integrity).toBe(provenance.integrity)
    expect(APP_PACKAGE_PIN.version).toBe(provenance.packageVersion)
  })

  it('names an artifact whose file name is derived from the version and the commit', () => {
    const provenance = readProvenance()
    const derived = `erniesg-struct-${provenance.packageVersion}-${provenance.sourceCommit}.tgz`

    expect(APP_PACKAGE_PIN.artifact).toBe(derived)
    expect(APP_PACKAGE_PIN.sourceCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(APP_PACKAGE_PIN.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(APP_PACKAGE_PIN.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
  })

  it('is the only pin the production registry approves, and it is the current one', () => {
    const ordered = orderedPins(APP_PACKAGE_PIN_REGISTRY)

    expect(ordered).toHaveLength(1)
    expect(ordered[0]).toBe(APP_PACKAGE_PIN)
    expect(currentPackagePin(APP_PACKAGE_PIN_REGISTRY)).toBe(APP_PACKAGE_PIN)
  })

  it('is the pin a release bound to the shipped artifact names', () => {
    const binding = {
      packageSourceCommit: APP_PACKAGE_PIN.sourceCommit,
      packageArtifact: APP_PACKAGE_PIN.artifact,
      packageArtifactSha256: APP_PACKAGE_PIN.artifactSha256,
      packageIntegrity: APP_PACKAGE_PIN.integrity,
      packageVersion: APP_PACKAGE_PIN.version,
    }

    expect(bindingNamesPin(binding, APP_PACKAGE_PIN)).toBe(true)
    expect(
      findApprovedPin(binding, APP_PACKAGE_PIN_REGISTRY),
    ).toBe(APP_PACKAGE_PIN)
    expect(checkPackagePin(binding, APP_PACKAGE_PIN_REGISTRY)).toEqual({
      ok: true,
      pin: APP_PACKAGE_PIN,
    })
  })

  it('refuses a binding that names the same commit under a different digest', () => {
    const binding = {
      packageSourceCommit: APP_PACKAGE_PIN.sourceCommit,
      packageArtifact: APP_PACKAGE_PIN.artifact,
      packageArtifactSha256: '0'.repeat(64),
      packageIntegrity: APP_PACKAGE_PIN.integrity,
      packageVersion: APP_PACKAGE_PIN.version,
    }

    expect(
      findApprovedPin(binding, APP_PACKAGE_PIN_REGISTRY),
    ).toBeNull()
    expect(checkPackagePin(binding, APP_PACKAGE_PIN_REGISTRY)).toEqual({
      ok: false,
      code: 'package_pin_unapproved',
      message:
        'the source binding names a package pin the app has not approved',
    })
  })
})
