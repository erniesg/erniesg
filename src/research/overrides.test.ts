import { describe, expect, it } from 'vitest'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import {
  buildLayoutManifest,
  LAYOUT_TARGETS,
  type LayoutManifest,
} from './manifest'
import {
  DEFAULT_EXPORT_OVERRIDES,
  getDefaultExportOverrides,
} from './overrides'
import { canonicalContentHash } from './canonical-hash'
import { researchPaperSchema } from './schema'

const paper = researchPaperSchema.parse(rawPaper)
const printOverride = DEFAULT_EXPORT_OVERRIDES[0]

function rendition(manifest: LayoutManifest, target: string) {
  const result = manifest.renditions.find(
    (candidate) => candidate.target === target,
  )
  if (!result) throw new Error(`Missing ${target} rendition`)
  return result
}

describe('SRT target-specific overrides', () => {
  it('selects the default print override only for its canonical paper', () => {
    expect(
      getDefaultExportOverrides('semantic-responsive-typesetting'),
    ).toEqual(DEFAULT_EXPORT_OVERRIDES)
    expect(getDefaultExportOverrides('if-letters-home-could-sing')).toEqual([])
  })

  it('changes only the selected A4 rendition without mutating canonical content', () => {
    const sourceHash = canonicalContentHash(paper)
    const baseline = buildLayoutManifest(paper)
    const overridden = buildLayoutManifest(paper, LAYOUT_TARGETS, [
      printOverride,
    ])

    expect(rendition(overridden, 'print')).not.toEqual(
      rendition(baseline, 'print'),
    )
    for (const target of LAYOUT_TARGETS.filter(
      (candidate) => candidate !== 'print',
    )) {
      expect(rendition(overridden, target)).toEqual(rendition(baseline, target))
    }
    expect(canonicalContentHash(paper)).toBe(sourceHash)
  })

  it('records override provenance and changes the affected layout version', () => {
    const baseline = rendition(buildLayoutManifest(paper), 'print')
    const overridden = rendition(
      buildLayoutManifest(paper, LAYOUT_TARGETS, [printOverride]),
      'print',
    )
    const figure = overridden.entries.find(
      (entry) => entry.canonicalId === printOverride.canonicalId,
    )

    expect(figure?.chosenVariant).toBe(printOverride.patch.chosenVariant)
    expect(overridden.overrideSet.applied).toEqual([printOverride])
    expect(overridden.overrideSet.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(overridden.layoutVersion).not.toBe(baseline.layoutVersion)
    expect(overridden.layoutVersion).toContain(
      `override=${overridden.overrideSet.digest}`,
    )
  })

  it('rejects ambiguous or orphaned override selectors', () => {
    expect(() =>
      buildLayoutManifest(paper, LAYOUT_TARGETS, [
        printOverride,
        { ...printOverride, id: 'second-print-pipeline-override' },
      ]),
    ).toThrow(/Duplicate override selector/)

    expect(() =>
      buildLayoutManifest(paper, LAYOUT_TARGETS, [
        { ...printOverride, canonicalId: 'missing-node' },
      ]),
    ).toThrow(/unknown canonical node/)
  })
})
