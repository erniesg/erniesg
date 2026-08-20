import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import manifest from './model-receipt-boundary-manifest.json'

type BoundaryManifest = {
  schemaVersion: number
  generic: string[]
  appShared: string[]
  appOnly: string[]
}

const boundary = manifest as BoundaryManifest

function exportedNames(source: string) {
  const names = new Set<string>()
  for (const match of source.matchAll(
    /^export\s+(?:const|type|function|class)\s+([A-Za-z0-9_]+)/gmu,
  ))
    names.add(match[1]!)
  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/gmu))
    for (const name of match[1]!.split(',')) {
      const symbol = name.trim().split(/\s+as\s+/u)[0]
      if (symbol) names.add(symbol)
    }
  return [...names].sort()
}

const genericSource = readFileSync(
  new URL('../struct/model-consultation-receipt.ts', import.meta.url),
  'utf8',
)
const appSource = readFileSync(
  new URL('./model-fallback-receipt.ts', import.meta.url),
  'utf8',
)

describe('model receipt generic/app boundary inventory', () => {
  it('classifies every exported symbol in the checked manifest', () => {
    expect(boundary.schemaVersion).toBe(1)
    const generic = exportedNames(genericSource)
    const app = exportedNames(appSource)
    expect(generic).toEqual([...boundary.generic].sort())
    expect(app).toEqual(
      [...new Set([...boundary.appShared, ...boundary.appOnly])].sort(),
    )
    expect(
      boundary.generic.some((symbol) => boundary.appOnly.includes(symbol)),
    ).toBe(false)
    expect(
      boundary.appShared.some((symbol) => boundary.appOnly.includes(symbol)),
    ).toBe(false)
  })

  it('keeps PDF/provider policy symbols out of the generic core module', () => {
    const genericExports = new Set(exportedNames(genericSource))
    for (const symbol of boundary.appOnly)
      if (genericExports.has(symbol))
        throw new Error(
          `app-only symbol leaked into generic exports: ${symbol}`,
        )
  })
})
