/**
 * The cross-module source-binding shape obligation.
 *
 * The design record promised that when the E-04 module landed, the two
 * modules would compare their source-binding shapes so that a change to one
 * would be visible in the other. E-04 has landed, and it produced a **neutral
 * contract fixture**,
 * `tests/fixtures/publication-source-binding-contract-v1.json`, which
 * describes the contract: the variants, their field names, their
 * requiredness and their formats.
 *
 * The fixture is a description and NOT an authority. It carries no package
 * pin, no artifact digest, no document digest and no source identity, and it
 * decides nothing at runtime.
 *
 * The comparison is **test-only on both sides**:
 *
 * - the E-04 side (`src/publication/source-binding.test.ts`) compares the
 *   E-04 schema against the same fixture;
 * - this file compares the E-05 schema against the same fixture.
 *
 * Neither module imports the other, and neither module imports the other's
 * production code. This file proves that: it reads the fixture and the two
 * sides' sources as text and compares them, and it asserts that no
 * production module on either side imports the other side.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  EDITORIAL_SOURCE_BINDING_FIELDS,
  editorialSourceBindingSchema,
} from './records'

/** The neutral contract fixture, relative to the repository root. */
const FIXTURE_PATH = 'tests/fixtures/publication-source-binding-contract-v1.json'

/** The directory the E-05 lane owns. */
const EDITORIAL_DIRECTORY = 'src/editorial'

/** The production directories the E-04 lane owns. */
const E04_DIRECTORIES = [
  'src/publication',
  'src/struct-adapters',
  'src/struct',
  'src/research',
  'src/annotations',
]

type ContractField = {
  type: 'literal' | 'string'
  value?: string
  format?: 'sha256-hex' | 'hex-40' | 'non-empty-string'
  required: boolean
  requiredAt?: string
  maxLength?: number
}

type ContractVariant = {
  kind: string
  strict: boolean
  fields: Record<string, ContractField>
}

type ContractFixture = {
  contract: string
  version: string
  authority: boolean
  discriminator: string
  formats: Record<string, { type: string; pattern?: string; minLength?: number }>
  variants: Record<string, ContractVariant>
}

const contractFixture: ContractFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), FIXTURE_PATH), 'utf8'),
)

const structVariant = contractFixture.variants['struct-cutover']

/** The import specifiers of one source file, as text. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+(?:type\s+)?[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) specifiers.push(specifier)
    }
  }
  return specifiers
}

/** The source files of a directory, recursively. */
function sourceFiles(directory: string): string[] {
  const root = resolve(process.cwd(), directory)
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|mts|mjs|tsx|js)$/.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

/** Whether a relative import specifier resolves inside a directory. */
function resolvesInside(
  file: string,
  specifier: string,
  directory: string,
): boolean {
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(file), specifier)
  const inside = resolve(process.cwd(), directory)
  return target === inside || target.startsWith(`${inside}${sep}`)
}

/** The production source files of a directory: no test files. */
function productionFiles(directory: string): string[] {
  return sourceFiles(directory).filter(
    (file) => !/\.(test|spec)\.[^.]+$/.test(file),
  )
}

describe('the neutral publication source binding contract', () => {
  it('is a description and not an authority', () => {
    expect(contractFixture.contract).toBe('publication-source-binding-contract')
    expect(contractFixture.version).toBe('1.0.0')
    expect(contractFixture.authority).toBe(false)
    expect(contractFixture.discriminator).toBe('kind')
    // The fixture carries no pin and no identity: it names fields, not the
    // values of any real publication.
    const serialized = JSON.stringify(contractFixture)
    expect(serialized).not.toContain('erniesg-struct-')
    expect(serialized).not.toContain('sha512-')
    expect(serialized).not.toContain('3d3a7c95')
  })

  it('names the struct variant this module admits', () => {
    expect(structVariant).toBeDefined()
    expect(structVariant.strict).toBe(true)
    expect(structVariant.kind).toBe('struct-cutover')
  })

  it('names exactly the fields this module states, in the same order', () => {
    expect([...EDITORIAL_SOURCE_BINDING_FIELDS]).toEqual(
      Object.keys(structVariant.fields),
    )
    expect(Object.keys(editorialSourceBindingSchema.shape)).toEqual([
      ...EDITORIAL_SOURCE_BINDING_FIELDS,
    ])
  })
})

/** A value that satisfies one field description of the contract fixture. */
function contractValue(field: ContractField): string {
  if (field.type === 'literal') return field.value ?? ''
  switch (field.format) {
    case 'sha256-hex':
      return '1'.repeat(64)
    case 'hex-40':
      return 'b'.repeat(40)
    default:
      return 'contract-value'
  }
}

/** A value that violates one field description of the contract fixture. */
function invalidContractValue(field: ContractField): string {
  if (field.type === 'literal') return 'not-the-declared-literal'
  switch (field.format) {
    case 'sha256-hex':
      return 'x'.repeat(64)
    case 'hex-40':
      return 'z'.repeat(40)
    default:
      return ''
  }
}

function contractBinding(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(structVariant.fields).map(([name, field]) => [
      name,
      contractValue(field),
    ]),
  )
}

describe('the E-05 source binding against the neutral contract', () => {
  it('accepts a binding that satisfies every field of the contract', () => {
    const binding = contractBinding()

    expect(editorialSourceBindingSchema.safeParse(binding).success).toBe(true)
  })

  it('requires exactly the fields the contract requires', () => {
    const binding = contractBinding()
    for (const [name, field] of Object.entries(structVariant.fields)) {
      const without = { ...binding }
      delete without[name]
      const parsed = editorialSourceBindingSchema.safeParse(without)
      if (field.required) expect(parsed.success, name).toBe(false)
      else expect(parsed.success, name).toBe(true)
    }
  })

  it('enforces the formats the contract declares', () => {
    const binding = contractBinding()
    for (const [name, field] of Object.entries(structVariant.fields)) {
      const invalid = { ...binding, [name]: invalidContractValue(field) }
      expect(editorialSourceBindingSchema.safeParse(invalid).success, name).toBe(
        false,
      )
    }
  })

  it('enforces the bounds the contract declares', () => {
    const binding = contractBinding()
    for (const [name, field] of Object.entries(structVariant.fields)) {
      if (field.maxLength === undefined) continue
      const tooLong = {
        ...binding,
        [name]: 'v'.repeat(field.maxLength + 1),
      }
      expect(editorialSourceBindingSchema.safeParse(tooLong).success, name).toBe(
        false,
      )
    }
  })

  it('is strict, exactly as the contract variant is', () => {
    const binding = { ...contractBinding(), notAField: 'x' }

    expect(editorialSourceBindingSchema.safeParse(binding).success).toBe(false)
  })

  it('does not admit the legacy variant of the contract', () => {
    expect(contractFixture.variants['legacy-research-paper']).toBeDefined()
    expect(
      editorialSourceBindingSchema.safeParse({
        kind: 'legacy-research-paper',
      }).success,
    ).toBe(false)
  })
})

describe('the cross-module import boundary', () => {
  it('scans a non-empty set of production modules on both sides', () => {
    // Without this, an empty scan would make the two boundary assertions
    // pass vacuously and the boundary would be unproven.
    expect(productionFiles(EDITORIAL_DIRECTORY).length).toBeGreaterThan(0)
    expect(
      E04_DIRECTORIES.flatMap((directory) => productionFiles(directory)).length,
    ).toBeGreaterThan(0)
  })

  it('has no production import edge from E-05 into E-04', () => {
    const offenders: string[] = []
    for (const file of productionFiles(EDITORIAL_DIRECTORY)) {
      const source = readFileSync(file, 'utf8')
      for (const specifier of importSpecifiers(source)) {
        for (const directory of E04_DIRECTORIES) {
          if (resolvesInside(file, specifier, directory)) {
            offenders.push(
              `${relative(process.cwd(), file)} imports ${specifier}`,
            )
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('has no production import edge from E-04 into E-05', () => {
    const offenders: string[] = []
    for (const directory of E04_DIRECTORIES) {
      for (const file of productionFiles(directory)) {
        const source = readFileSync(file, 'utf8')
        for (const specifier of importSpecifiers(source)) {
          if (resolvesInside(file, specifier, EDITORIAL_DIRECTORY)) {
            offenders.push(
              `${relative(process.cwd(), file)} imports ${specifier}`,
            )
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('reads the contract fixture and not a production module of the other lane', () => {
    // The comparison this file performs is test-only: the fixture is data,
    // and the only modules it imports are this lane's own.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const specifiers = importSpecifiers(source)

    expect(specifiers).not.toContain('../publication/source-binding')
    expect(specifiers).not.toContain('../../src/publication/source-binding')
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        expect(resolvesInside(fileURLToPath(import.meta.url), specifier, EDITORIAL_DIRECTORY)).toBe(
          true,
        )
      }
    }
  })
})
