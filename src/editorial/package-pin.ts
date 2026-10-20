/**
 * The approved Struct package pins, and the refusal of a downgrade.
 *
 * ## What a pin is
 *
 * A **package pin** is the provenance of the Struct bundle that produced a
 * publication: the source commit it was built from, the artifact, the
 * artifact's digest, its integrity string and its version. The release
 * record's `sourceBinding` carries exactly those five fields
 * (`records.ts`), and they are the only thing that says *which* Struct the
 * bytes came from.
 *
 * ## Why the pins are ordered
 *
 * A pin on its own says nothing about whether it is safe. What makes a pin
 * unsafe is that it is *older* than the one the app is pinned to: publishing
 * under an older Struct is a **downgrade**, and a downgrade is refused even
 * when the older pin is a perfectly good pin that once was current.
 *
 * So the registry is an **ordered list**. Each entry carries an explicit
 * `sequence`, and the current pin is the one with the highest sequence. The
 * order is explicit rather than inferred from a version string, because
 * "0.10.0" is older than "0.9.0" and a string comparison would get it
 * wrong.
 *
 * ## Why the registry is injected
 *
 * The registry is **app-owned configuration**, like the target registry and
 * the margin allowlist: it is not read from the environment at module load,
 * it is handed to the writer. A module that read the environment at import
 * time would make the pin policy depend on when the module was first
 * imported, which is not a property anybody can audit.
 *
 * The production registry below is the app's own pin: the Struct artifact the
 * repository is pinned to. `package-pin.test.ts` checks it against
 * `vendor/struct/provenance.json`, the provenance file of record, so the two
 * cannot drift.
 */
import { z } from 'zod'

import { commitShaSchema, sha256Schema } from './records'

/**
 * One approved package pin.
 *
 * The five fields are the five fields of the release record's source binding.
 * `sequence` is the registry's own and is not part of the binding: it orders
 * the pins, and the binding does not carry it.
 */
export const approvedPackagePinSchema = z
  .object({
    /** The Struct source commit the artifact was built from. */
    sourceCommit: commitShaSchema,
    /** The artifact's file name. */
    artifact: z.string().min(1).max(256),
    /** The artifact's SHA-256. */
    artifactSha256: sha256Schema,
    /** The artifact's integrity string. */
    integrity: z.string().min(1).max(256),
    /** The package's version. */
    version: z.string().min(1).max(64),
    /**
     * The approval order. Higher is newer.
     *
     * A pin with a lower sequence than the current one is a **downgrade**
     * and is refused.
     */
    sequence: z.number().int().nonnegative(),
  })
  .strict()
export type ApprovedPackagePin = z.infer<typeof approvedPackagePinSchema>

/**
 * The registry of approved pins.
 *
 * It is ordered by `sequence`, and the **current** pin is the last one: the
 * only pin a new publication may be cut under.
 *
 * The `pins` property is replaceable on purpose. The registry is app-owned
 * configuration, and a re-pin is a change of configuration: the app is
 * pinned to a newer Struct, and every pin before it becomes older. A reader
 * that captured the pins at construction time would keep serving the old
 * policy forever.
 */
export type PackagePinRegistry = {
  pins: readonly ApprovedPackagePin[]
}

/** The ways a package pin can be refused. */
export const PACKAGE_PIN_REFUSALS = [
  'package_pin_unapproved',
  'package_pin_downgrade',
] as const
export type PackagePinRefusal = (typeof PACKAGE_PIN_REFUSALS)[number]

/** The outcome of checking a source binding against the registry. */
export type PackagePinCheck =
  | { ok: true; pin: ApprovedPackagePin }
  | { ok: false; code: PackagePinRefusal; message: string }

/**
 * The app's own pin: the Struct artifact this repository is pinned to.
 *
 * The values are the ones in `vendor/struct/provenance.json`, the
 * provenance file of record. They are stated here rather than read at import
 * time so that the policy is a compile-time constant of the app and not a
 * file read that could fail at runtime; the test compares the two.
 */
export const APP_PACKAGE_PIN: ApprovedPackagePin = {
  sourceCommit: '90f76f1f80b037cc065169d07b13779c03420026',
  artifact: 'erniesg-struct-0.0.0-90f76f1f80b037cc065169d07b13779c03420026.tgz',
  artifactSha256:
    '42fee58e9b1e1888c53e929ad6367a2c128d1607140225387836ee5da53df8f1',
  integrity:
    'sha512-0WyBLp2PDZr4pOFYhfe6a1IbuZOuBemiR/alDgx73j8JYKZh7m8UthMsimjXp6wt3gUUiNumvXmykYeccnDUBQ==',
  version: '0.0.0',
  sequence: 1,
}

/**
 * The production registry: the app's own pin, and nothing else.
 *
 * A second pin is not in it until the app is actually re-pinned, and a
 * re-pin is a change to `vendor/struct/provenance.json` — which is the
 * pinned artifact and is not touched by E-05.
 */
export const APP_PACKAGE_PIN_REGISTRY: PackagePinRegistry = {
  pins: [APP_PACKAGE_PIN],
}

/** The pins of a registry, ordered by their approval sequence. */
export function orderedPins(
  registry: PackagePinRegistry,
): ApprovedPackagePin[] {
  return [...registry.pins].sort((left, right) => left.sequence - right.sequence)
}

/**
 * The current pin: the one with the highest approval sequence.
 *
 * `null` for an empty registry. An empty registry has no current pin, so
 * every pin is unapproved, and the store publishes nothing — which is the
 * right answer for a registry nobody has filled in.
 */
export function currentPackagePin(
  registry: PackagePinRegistry,
): ApprovedPackagePin | null {
  const ordered = orderedPins(registry)
  return ordered.length === 0 ? null : (ordered[ordered.length - 1] ?? null)
}

/**
 * The binding fields a pin is compared against.
 *
 * It is the five fields of the source binding that name the package. The
 * digests of the *content* are not part of it: they say what was published,
 * not what produced it.
 */
export type PackagePinBinding = {
  packageSourceCommit: string
  packageArtifact: string
  packageArtifactSha256: string
  packageIntegrity: string
  packageVersion: string
}

/** Whether a binding names exactly a pin. */
export function bindingNamesPin(
  binding: PackagePinBinding,
  pin: ApprovedPackagePin,
): boolean {
  return (
    binding.packageSourceCommit === pin.sourceCommit &&
    binding.packageArtifact === pin.artifact &&
    binding.packageArtifactSha256 === pin.artifactSha256 &&
    binding.packageIntegrity === pin.integrity &&
    binding.packageVersion === pin.version
  )
}

/**
 * Whether a binding names a pin in the registry.
 *
 * `null` when it names none. A binding that names a *different* pin — the
 * same commit with a different artifact digest, say — names no approved
 * pin, and is not a near miss.
 */
export function findApprovedPin(
  binding: PackagePinBinding,
  registry: PackagePinRegistry,
): ApprovedPackagePin | null {
  return (
    orderedPins(registry).find((pin) => bindingNamesPin(binding, pin)) ?? null
  )
}

/**
 * Check a binding against the registry.
 *
 * The order of the two refusals is the order a reader cares about:
 *
 * 1. a binding that names **no approved pin** is `package_pin_unapproved` —
 *    the app has never vouched for those bytes;
 * 2. a binding that names an approved pin that is **older than the current
 *    one** is `package_pin_downgrade` — the app did vouch for it, but
 *    publishing under it now would move the pipeline backwards.
 *
 * The current pin itself is allowed: that is the ordinary case.
 */
export function checkPackagePin(
  binding: PackagePinBinding,
  registry: PackagePinRegistry,
): PackagePinCheck {
  const pin = findApprovedPin(binding, registry)
  if (pin !== null) return { ok: true, pin }
  if (pin === null) {
    return {
      ok: false,
      code: 'package_pin_unapproved',
      message:
        'the source binding names a package pin the app has not approved',
    }
  }
  const current = currentPackagePin(registry)
  if (current !== null && pin.sequence < current.sequence) {
    return {
      ok: false,
      code: 'package_pin_downgrade',
      message: `the source binding names package pin ${pin.version} at sequence ${pin.sequence}, and the current pin is ${current.version} at sequence ${current.sequence}: publishing under it would be a downgrade`,
    }
  }
  return { ok: true, pin }
}
