import { strToU8, type ZipOptions } from 'fflate'
import { sha256HexSync } from '@erniesg/struct'
import {
  PdfImportError,
  type PdfReconstruction,
  type PublicationAsset,
} from './import-types'
import {
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE,
  PDF_HYPHEN_LEXICAL_MODEL,
  PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE,
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE,
} from './pdf-hyphenation'
import {
  hasValidCanonicalHyphenBoundaryLedger,
  hasValidSourceSemanticFlowBoundaryLedgerCount,
} from './pdf-quality'
import { attribute, stableId, text } from './epub-semantic-links'
import type { ResearchPaper } from './schema'
import { type TargetProfile } from './targets'
import { targetProfileSchema } from './target-schema'
import { downscalePngAsset } from './visual-assets'

const EPUB_EXPORT_POLICY_VERSION = '1.2.0' as const
const COMPACT_RASTER_TABLE_SCROLL_MIN_SOURCE_WIDTH_PX = 1_000
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${canonicalJson(entryValue)}`,
      )
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
function isCompactScrollableTableImage({
  kind,
  mediaType,
  width,
  height,
}: Pick<PublicationAsset, 'kind' | 'mediaType' | 'width' | 'height'>) {
  return (
    kind === 'table' &&
    mediaType.startsWith('image/') &&
    (width / height >= 2 ||
      width >= COMPACT_RASTER_TABLE_SCROLL_MIN_SOURCE_WIDTH_PX)
  )
}
function publicationLanguage(paper: ResearchPaper) {
  return paper.language ?? 'und'
}
function publicationBaseDirection(paper: ResearchPaper) {
  return paper.baseDirection === 'ltr' || paper.baseDirection === 'rtl'
    ? paper.baseDirection
    : undefined
}

type PackagedAsset = {
  source: PublicationAsset
  asset: PublicationAsset
  policy: {
    id:
      'fit-device-content-width-no-upscale' | 'preserve-scrollable-table-source'
    version: typeof EPUB_EXPORT_POLICY_VERSION
    action: 'preserved' | 'downscaled' | 'scalable-source'
    sourceWidth: number
    sourceHeight: number
    packagedWidth: number
    packagedHeight: number
    maximumWidth: number | null
    targetPixelsPerInch: number | null
    sourcePixelsPerInch: number | null
    resampling: 'none' | 'nearest-neighbor-rgba'
    neverUpscaled: true
  }
}

export async function packageVisualAssets(
  assets: readonly PublicationAsset[],
  profile?: TargetProfile,
) {
  const maximumWidth =
    profile?.dimensions.unit === 'device-px'
      ? profile.dimensions.width - profile.margins.left - profile.margins.right
      : null
  const packaged: PackagedAsset[] = []
  for (const source of assets) {
    const preserveScrollableTableSource =
      profile?.id === 'paperProMove' && isCompactScrollableTableImage(source)
    const asset =
      !preserveScrollableTableSource &&
      maximumWidth !== null &&
      profile?.pixelsPerInch !== null &&
      profile?.pixelsPerInch !== undefined
        ? await downscalePngAsset(source, maximumWidth, profile.pixelsPerInch)
        : source
    packaged.push({
      source,
      asset,
      policy: {
        id: preserveScrollableTableSource
          ? 'preserve-scrollable-table-source'
          : 'fit-device-content-width-no-upscale',
        version: EPUB_EXPORT_POLICY_VERSION,
        action:
          source.mediaType === 'image/svg+xml'
            ? 'scalable-source'
            : source.mediaType !== 'image/png' || asset.sha256 === source.sha256
              ? 'preserved'
              : 'downscaled',
        sourceWidth: source.width,
        sourceHeight: source.height,
        packagedWidth: asset.width,
        packagedHeight: asset.height,
        maximumWidth: preserveScrollableTableSource ? null : maximumWidth,
        targetPixelsPerInch: profile?.pixelsPerInch ?? null,
        sourcePixelsPerInch: source.resolutionDpi,
        resampling:
          asset.sha256 === source.sha256 ? 'none' : 'nearest-neighbor-rgba',
        neverUpscaled: true,
      },
    })
  }
  return packaged
}

export function uniqueAssets(packaged: readonly PackagedAsset[]) {
  return [...new Map(packaged.map(({ asset }) => [asset.id, asset])).values()]
}

export function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`
}

export function packageOpf(
  paper: ResearchPaper,
  identifier: string,
  modified: string,
  assets: PublicationAsset[] = [],
  profile?: TargetProfile,
) {
  const assetItems = assets
    .map(
      (visualAsset) =>
        `<item id="${attribute(stableId(visualAsset.id))}" href="${attribute(visualAsset.href)}" media-type="${attribute(visualAsset.mediaType)}" />`,
    )
    .join('\n    ')
  const language = publicationLanguage(paper)
  const direction = publicationBaseDirection(paper)
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${attribute(language)}" prefix="schema: http://schema.org/">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${text(identifier)}</dc:identifier>
    <dc:title>${text(paper.title)}</dc:title>
    <dc:language>${text(language)}</dc:language>
    ${paper.authors.map((author) => `<dc:creator>${text(author)}</dc:creator>`).join('\n    ')}
    ${paper.publicationDate ? `<dc:date>${text(paper.publicationDate)}</dc:date>` : ''}
    <meta property="dcterms:modified">${text(modified)}</meta>
    <meta property="schema:accessMode">textual</meta>
    ${assets.length > 0 ? '<meta property="schema:accessMode">visual</meta>' : ''}
    <meta property="schema:accessibilityFeature">structuralNavigation</meta>
    <meta property="schema:accessibilityFeature">tableOfContents</meta>
    ${assets.length > 0 ? '<meta property="schema:accessibilityFeature">alternativeText</meta>' : ''}
    <meta property="schema:accessibilityHazard">none</meta>
    <meta property="schema:accessModeSufficient">${assets.length > 0 ? 'textual,visual' : 'textual'}</meta>
    <meta property="schema:accessibilitySummary">This reflowable publication provides structural navigation${assets.length > 0 ? ' and text alternatives for packaged visual content' : ''}.</meta>
    ${
      profile
        ? `<meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:flow">${profile.epub.renditionFlow}</meta>
    <meta property="rendition:spread">none</meta>`
        : ''
    }
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml" />
    <item id="styles" href="styles.css" media-type="text/css" />
    <item id="export-manifest" href="export.json" media-type="application/json" />
    ${assetItems}
  </manifest>
  <spine${direction ? ` page-progression-direction="${direction}"` : ''}>
    <itemref idref="content" />
  </spine>
</package>
`
}

export function epubArtifactModifiedAt(paper: ResearchPaper) {
  const candidate = paper.artifactModifiedAt ?? `${paper.updated}T00:00:00.000Z`
  const parsed = new Date(candidate)
  const normalized = Number.isNaN(parsed.valueOf())
    ? `${paper.updated}T00:00:00.000Z`
    : parsed.toISOString()
  return normalized.replace(/\.\d{3}Z$/, 'Z')
}

export function entry(
  value: string,
  level: 0 | 6 = 6,
): [Uint8Array, ZipOptions] {
  return [strToU8(value), { level, mtime: ZIP_MTIME }]
}

export function binaryEntry(value: Uint8Array): [Uint8Array, ZipOptions] {
  return [value, { level: 6, mtime: ZIP_MTIME }]
}

export function canonicalJsonSha256(value: unknown) {
  return sha256HexSync(strToU8(canonicalJson(value)))
}

export function opaqueCanonicalHyphenValue(kind: string, value: string) {
  return sha256HexSync(strToU8(`${kind}\0${value}`))
}

export const PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE_SHA256S =
  PDF_HYPHEN_REMOVAL_REQUIRED_EVIDENCE.map((evidence) =>
    opaqueCanonicalHyphenValue('canonical-hyphen-evidence', evidence),
  )
export const PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE_SHA256S =
  PDF_HYPHEN_DERIVED_AFFIX_REMOVAL_REQUIRED_EVIDENCE.map((evidence) =>
    opaqueCanonicalHyphenValue('canonical-hyphen-evidence', evidence),
  )
export const PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE_SHA256S =
  PDF_HYPHEN_REMOVAL_FORBIDDEN_EVIDENCE.map((evidence) =>
    opaqueCanonicalHyphenValue('canonical-hyphen-evidence', evidence),
  )

export function canonicalHyphenDeletionContextCounts(
  records: readonly { context: string }[],
) {
  const counts = new Map<string, number>()
  for (const record of records) {
    counts.set(record.context, (counts.get(record.context) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function canonicalHyphenDeletionManifestReceipt(
  reconstruction: PdfReconstruction,
) {
  if (
    !hasValidCanonicalHyphenBoundaryLedger({
      decisions: reconstruction.canonicalHyphenBoundaryDecisions,
      expectedCount: reconstruction.canonicalHyphenBoundaryDecisionCount,
      regions: reconstruction.regions,
    })
  ) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'EPUB export requires a complete canonical hyphen deletion ledger and count.',
    )
  }
  const records = reconstruction.canonicalHyphenBoundaryDecisions
    .map((decision) => {
      const left = decision.proof.pinnedSplit.left
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
      const right = decision.proof.pinnedSplit.right
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
      const joined = `${left}${right}`
      const hardHyphen = `${left}-${right}`
      return {
        id: opaqueCanonicalHyphenValue(
          'canonical-hyphen-decision',
          decision.id,
        ),
        context: decision.context,
        outcome: decision.outcome,
        fromRegionId: opaqueCanonicalHyphenValue(
          'region',
          decision.fromRegionId,
        ),
        fromLineId: opaqueCanonicalHyphenValue('line', decision.fromLineId),
        toRegionId: opaqueCanonicalHyphenValue('region', decision.toRegionId),
        toLineId: opaqueCanonicalHyphenValue('line', decision.toLineId),
        geometry: {
          from: { ...decision.geometry.from },
          to: { ...decision.geometry.to },
        },
        proof: {
          ...(decision.proof.tier === 'exact-same-document'
            ? {
                tier: 'exact-same-document' as const,
                sourceBoundaryProven: true as const,
                pinnedWordSha256: canonicalJsonSha256(joined),
                pinnedJoinedFormValid: true as const,
                pinnedSplit: {
                  leftSha256: canonicalJsonSha256(left),
                  rightSha256: canonicalJsonSha256(right),
                  index: decision.proof.pinnedSplit.index,
                },
                splitPointValid: true as const,
                exactSameDocumentJoinedFormSha256: canonicalJsonSha256(joined),
                sameDocumentJoinedFormValid: true as const,
              }
            : (() => {
                const derivedWordSha256 = canonicalJsonSha256(joined)
                const baseWord = decision.proof.baseWord
                  .normalize('NFKC')
                  .toLocaleLowerCase('en-US')
                const baseWordSha256 = canonicalJsonSha256(baseWord)
                const productivePrefix = {
                  ...PDF_HYPHEN_PRODUCTIVE_PREFIX_RULE,
                }
                return {
                  tier: 'same-document-derived-affix' as const,
                  sourceBoundaryProven: true as const,
                  derivedWordSha256,
                  productivePrefix,
                  baseWordSha256,
                  derivationBindingSha256: canonicalJsonSha256({
                    derivedWordSha256,
                    productivePrefix,
                    baseWordSha256,
                  }),
                  pinnedBaseWordValid: true as const,
                  pinnedSplit: {
                    leftSha256: canonicalJsonSha256(left),
                    rightSha256: canonicalJsonSha256(right),
                    index: decision.proof.pinnedSplit.index,
                  },
                  splitPointValid: true as const,
                  exactSameDocumentBaseWordSha256: baseWordSha256,
                  sameDocumentBaseWordValid: true as const,
                }
              })()),
          hardHyphenFormSha256: canonicalJsonSha256(hardHyphen),
          hardHyphenCounterproof: null,
          model: { ...decision.proof.model },
          evidenceSha256s: [
            ...new Set(
              decision.proof.evidence.map((evidence) =>
                opaqueCanonicalHyphenValue(
                  'canonical-hyphen-evidence',
                  evidence,
                ),
              ),
            ),
          ].sort(),
        },
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    canonicalHyphenDeletionCount: records.length,
    canonicalHyphenDeletionContextCounts:
      canonicalHyphenDeletionContextCounts(records),
    canonicalHyphenDeletionLedger: records,
    canonicalHyphenDeletionLedgerSha256: canonicalJsonSha256(records),
  }
}

export function sourceSemanticFlowBoundaryManifestReceipt(
  reconstruction: PdfReconstruction,
) {
  if (
    !hasValidSourceSemanticFlowBoundaryLedgerCount({
      decisions: reconstruction.sourceSemanticFlowBoundaryDecisions,
      expectedCount: reconstruction.sourceSemanticFlowBoundaryDecisionCount,
    })
  ) {
    throw new PdfImportError(
      'INCOMPLETE_RECONSTRUCTION',
      'EPUB export requires a complete source semantic-flow boundary ledger and count.',
    )
  }
  const endpoint = (
    value: PdfReconstruction['sourceSemanticFlowBoundaryDecisions'][number]['from'],
  ) => ({
    regionId: opaqueCanonicalHyphenValue('region', value.regionId),
    lineId: opaqueCanonicalHyphenValue('line', value.lineId),
    runIndex: value.runIndex,
    sourceSequenceIndex: value.sourceSequenceIndex,
    sourceRunSha256: value.sourceRunSha256,
    sourceFragmentId: opaqueCanonicalHyphenValue(
      'source-fragment',
      value.sourceFragmentId,
    ),
  })
  const records = reconstruction.sourceSemanticFlowBoundaryDecisions
    .map((decision) => ({
      id: decision.id,
      page: decision.page,
      rotation: decision.rotation,
      method: decision.method,
      topology: decision.topology,
      outcome: decision.outcome,
      from: endpoint(decision.from),
      to: endpoint(decision.to),
      evidenceSha256s: decision.evidence
        .map((evidence) =>
          opaqueCanonicalHyphenValue('semantic-flow-evidence', evidence),
        )
        .sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    sourceSemanticFlowBoundaryCount: records.length,
    sourceSemanticFlowBoundaryLedger: records,
    sourceSemanticFlowBoundaryLedgerSha256: canonicalJsonSha256(records),
  }
}
