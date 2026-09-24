import type { PdfPageRegion } from './import-types'

type PdfFrontMatterBlock = {
  type: 'heading' | 'paragraph' | 'caption' | 'footnote'
  region: PdfPageRegion
  text: string
  noteLabel?: string
  frontMatterRole?:
    'title' | 'author' | 'affiliation' | 'abstract-heading' | 'abstract-body'
}

export function likelyAffiliation(value: string) {
  return (
    /(?:university|institute|department|laborator(?:y|ies)|\blabs?\b|school|college|centre|center|hospital|academy|research (?:group|team)|fellows? program|corporation|\binc\b|compan(?:y|ies)|studios?|technolog(?:y|ies)|@|https?:\/\/)/i.test(
      value,
    ) ||
    /^\s*(?:\d+\s*)?[\p{Lu}\p{N}][\p{Lu}\p{N}*+&.-]{2,}\s+\p{Lu}\p{Ll}[\p{L}.-]*(?:\s+\p{Lu}\p{Ll}[\p{L}.-]*){0,3}\s*$/u.test(
      value,
    )
  )
}

export function normalizedAuthorName(value: string) {
  return value
    .replace(/(?:\s*[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)+\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function likelyPersonName(value: string) {
  const normalized = normalizedAuthorName(value)
  if (!normalized || likelyAffiliation(normalized)) return false
  const words = normalized.split(/\s+/)
  if (words.length < 2 || words.length > 8) return false
  return words.every((word) =>
    /^(?:\p{Lu}[\p{L}'’.-]*|(?:de|del|der|di|du|la|le|van|von))$/u.test(word),
  )
}

export function authorNamesFromLine(value: string) {
  const allCapsWithoutListEvidence =
    /\p{Lu}/u.test(value) &&
    !/\p{Ll}/u.test(value) &&
    !/[,;]|\s+(?:and|&)\s+/iu.test(value)
  if (allCapsWithoutListEvidence) return []
  const hasAttachedAffiliationMarkers =
    /(\p{L})\s*[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s+[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)*\s+(?=\p{Lu}\p{Ll})/u.test(
      value,
    )
  const separated = value
    .replace(
      /(\p{L})\s*[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\s+[\d*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+)*\s+(?=\p{Lu}\p{Ll})/gu,
      '$1; ',
    )
    .replace(/\s+\d+(?=[A-Z]{2,}\b)/g, '; ')
    .split(/\s+(?:and|&)\s+|\s*[;,]\s*(?:(?:and|&)\s+)?/i)
    .map(normalizedAuthorName)
    .filter(Boolean)
  const names = separated.filter(likelyPersonName)
  if (
    names.length > 0 &&
    (!likelyAffiliation(value) || hasAttachedAffiliationMarkers)
  ) {
    return names
  }
  return likelyPersonName(value) ? [normalizedAuthorName(value)] : []
}

function numberedAffiliationsFromLine(line: PdfPageRegion['lines'][number]) {
  const runs = line.runs.filter((run) => run.text.trim())
  const largestFont = Math.max(...runs.map((run) => run.fontSize), 0)
  const isMarker = (run: (typeof runs)[number], index: number) => {
    if (!/^\d{1,3}(?:,\d{1,3})*$/u.test(run.text.trim())) return false
    if (run.fontSize <= largestFont * 0.82 + 0.01) return true
    const next = runs[index + 1]
    if (!next || /^\d{1,3}(?:,\d{1,3})*$/u.test(next.text.trim())) {
      return false
    }
    const runCenter = run.y + run.height / 2
    const nextCenter = next.y + next.height / 2
    const horizontalGap = next.x - (run.x + run.width)
    return (
      run.fontSize <= next.fontSize * 0.92 + 0.01 &&
      runCenter <= nextCenter - Math.max(0.0005, next.height * 0.18) &&
      horizontalGap >= -0.001 &&
      horizontalGap <= 0.012
    )
  }
  if (runs.length < 2 || !isMarker(runs[0], 0)) return []

  const entries: string[] = []
  let parts: string[] = []
  for (const [index, run] of runs.entries()) {
    if (isMarker(run, index)) {
      if (parts.length > 1) entries.push(parts.join(' ').replace(/\s+/gu, ' '))
      parts = [run.text.trim()]
    } else if (parts.length > 0) {
      parts.push(run.text.trim())
    }
  }
  if (parts.length > 1) entries.push(parts.join(' ').replace(/\s+/gu, ' '))
  return entries.map((entry) => entry.trim()).filter(Boolean)
}

export function numberedAffiliationsFromBlock(block: PdfFrontMatterBlock) {
  return block.region.lines.flatMap(numberedAffiliationsFromLine)
}

function markedCollectiveAuthorName(
  line: PdfPageRegion['lines'][number],
  peerAuthorFontSize: number,
) {
  const text = line.text.trim()
  const normalized = normalizedAuthorName(text)
  if (
    peerAuthorFontSize <= 0 ||
    line.fontSize < peerAuthorFontSize * 0.9 ||
    !/[\p{L})]\s*[*∗†‡§⁰¹²³⁴⁵⁶⁷⁸⁹]+\s*$/u.test(text) ||
    !/\b(?:collaboration|consortium|collective|research\s+team)\b/iu.test(
      normalized,
    )
  ) {
    return null
  }
  const words = normalized.split(/\s+/u)
  return words.length >= 2 && words.length <= 10 ? normalized : null
}

export function authorNamesFromBlock(block: PdfFrontMatterBlock) {
  const names: string[] = []
  const authorLineTexts: string[] = []
  let peerAuthorFontSize = 0
  for (const line of block.region.lines) {
    if (
      likelyAffiliation(line.text) ||
      numberedAffiliationsFromLine(line).length > 0
    ) {
      const collective = markedCollectiveAuthorName(line, peerAuthorFontSize)
      if (collective) names.push(collective)
      break
    }
    authorLineTexts.push(line.text.trim())
    const lineNames = authorNamesFromLine(line.text)
    const runNames = line.runs.flatMap((run) => authorNamesFromLine(run.text))
    const selectedNames =
      runNames.length > lineNames.length ? runNames : lineNames
    if (selectedNames.length > 0) {
      names.push(...selectedNames)
      peerAuthorFontSize = Math.max(peerAuthorFontSize, line.fontSize)
    }
  }
  // Author lists commonly wrap a person's given name and family name across
  // two centered PDF lines. Parsing each line independently loses that person
  // (for example, "Pradyumna" / "Shukla³"), so also parse the visible author
  // lines as one source-ordered string.
  const joinedLineNames = authorNamesFromLine(
    authorLineTexts.filter(Boolean).join(' '),
  )
  return [...new Set([...names, ...joinedLineNames])]
}

export function inferredAuthors(blocks: PdfFrontMatterBlock[]) {
  const firstPage = blocks.filter(
    (block) => block.region.page === 1 && block.region.box.y < 0.32,
  )
  const titleIndex = firstPage.findIndex((block) => block.type === 'heading')
  if (titleIndex < 0) return []
  const candidates: string[] = []
  for (const block of firstPage.slice(titleIndex + 1)) {
    if (block.type === 'heading') break
    if (
      block.type !== 'paragraph' ||
      likelyAffiliation(block.text) ||
      numberedAffiliationsFromBlock(block).length > 0
    ) {
      continue
    }
    candidates.push(...authorNamesFromBlock(block))
  }
  return [...new Set(candidates)]
}

export function largestBlockFont(block: PdfFrontMatterBlock) {
  return Math.max(...block.region.lines.map((line) => line.fontSize), 0)
}

function inferredUnlabelledAbstractBlocks(
  firstPage: PdfFrontMatterBlock[],
  visibleMetadataTitleBlocks: PdfFrontMatterBlock[],
) {
  const boundaryIndex = firstPage.findIndex((block, index) => {
    if (index === 0) return false
    const text = block.text.trim()
    return (
      /^(?:CCS\s+Concepts?|Additional\s+Key\s+Words(?:\s+and\s+Phrases)?|Key\s*words?|Index\s+Terms?|Categories\s+and\s+Subject\s+Descriptors|ACM\s+Reference\s+Format)\b/iu.test(
        text,
      ) || /^(?:\d+(?:\.\d+){0,3}|[IVXLCDM]+)[.)]?\s+\p{L}/iu.test(text)
    )
  })
  if (boundaryIndex < 0) return []

  const compactMetadataIndexes = firstPage.flatMap((block, index) => {
    if (index >= boundaryIndex) return []
    const compact =
      block.text.trim().length <= 320 && block.region.lines.length <= 4
    return visibleMetadataTitleBlocks.includes(block) ||
      authorNamesFromBlock(block).length > 0 ||
      (compact &&
        (likelyAffiliation(block.text) ||
          numberedAffiliationsFromBlock(block).length > 0))
      ? [index]
      : []
  })
  const candidateStart = (compactMetadataIndexes.at(-1) ?? -1) + 1
  if (candidateStart >= boundaryIndex) return []

  const candidates = firstPage
    .slice(candidateStart, boundaryIndex)
    .filter(
      (block) =>
        block.type === 'paragraph' &&
        !/^(?:authors?['’]?\s+address|permission\s+to|copyright|©|doi\b|https?:\/\/doi\.org)\b/iu.test(
          block.text.trim(),
        ),
    )
  const candidateText = candidates
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  const wordCount = candidateText.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
  const sentenceCount = candidateText.match(/[.!?](?:\s|$)/gu)?.length ?? 0
  return candidateText.length >= 300 && wordCount >= 40 && sentenceCount >= 2
    ? candidates
    : []
}

export function classifyPdfFrontMatter(
  blocks: PdfFrontMatterBlock[],
  metadataTitle: string | undefined,
) {
  const firstPage = blocks.filter((block) => block.region.page === 1)
  const comparableTitle = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const comparableMetadataTitle = metadataTitle
    ? comparableTitle(metadataTitle)
    : undefined
  const matchingMetadataTitleBlocks = (candidates: PdfFrontMatterBlock[]) => {
    if (!comparableMetadataTitle) return []
    for (let start = 0; start < candidates.length; start += 1) {
      let visible = ''
      for (
        let end = start;
        end < candidates.length && end < start + 4;
        end += 1
      ) {
        visible = [visible, candidates[end].text].filter(Boolean).join(' ')
        const comparableVisible = comparableTitle(visible)
        if (comparableVisible === comparableMetadataTitle) {
          return candidates.slice(start, end + 1)
        }
        if (!comparableMetadataTitle.startsWith(comparableVisible)) break
      }
    }
    return []
  }
  const visibleMetadataTitleBlocks = matchingMetadataTitleBlocks(firstPage)
  const abstractIndex = firstPage.findIndex((block) =>
    /^abstract(?:\s*[:.—-]|\s|$)/i.test(block.text.trim()),
  )
  const inferredAbstractBlocks =
    abstractIndex < 0
      ? inferredUnlabelledAbstractBlocks(firstPage, visibleMetadataTitleBlocks)
      : []
  const inferredAbstractBlockSet = new Set(inferredAbstractBlocks)
  const hasTitlePageEvidence =
    abstractIndex >= 0 ||
    inferredAbstractBlocks.length > 0 ||
    visibleMetadataTitleBlocks.length > 0 ||
    (firstPage.some(
      (block) =>
        block.region.box.y < 0.32 &&
        (likelyAffiliation(block.text) ||
          numberedAffiliationsFromBlock(block).length > 0),
    ) &&
      firstPage.some(
        (block) => block.region.box.y < 0.2 && largestBlockFont(block) >= 14,
      ))
  if (!hasTitlePageEvidence) {
    return {
      detected: false,
      title: undefined,
      authors: [],
      affiliations: [],
      abstract: '',
      inferredAbstract: false,
    }
  }
  const abstractBlock =
    abstractIndex >= 0 ? firstPage[abstractIndex] : undefined
  const beforeAbstract = abstractBlock
    ? firstPage.filter(
        (block) =>
          block !== abstractBlock &&
          block.region.box.y + block.region.box.height <=
            abstractBlock.region.box.y + 0.01,
      )
    : firstPage.filter((block) => block.region.box.y < 0.32)
  const metadataTitleBlocks = matchingMetadataTitleBlocks(beforeAbstract)
  const metadataTitleBlock = metadataTitleBlocks[0]
  const titleBlock =
    metadataTitleBlock ??
    [...beforeAbstract]
      .filter(
        (block) =>
          !inferredAbstractBlockSet.has(block) &&
          !likelyAffiliation(block.text) &&
          numberedAffiliationsFromBlock(block).length === 0,
      )
      .sort(
        (left, right) =>
          largestBlockFont(right) - largestBlockFont(left) ||
          left.region.box.y - right.region.box.y,
      )[0]
  const titleBlocks = new Set(metadataTitleBlocks)
  if (titleBlock) titleBlocks.add(titleBlock)
  for (const block of titleBlocks) block.frontMatterRole = 'title'

  const titleFont = titleBlock ? largestBlockFont(titleBlock) : 0
  for (const block of beforeAbstract) {
    if (titleBlocks.has(block)) continue
    if (block.type === 'footnote' && block.noteLabel === 'Correspondence') {
      continue
    }
    if (inferredAbstractBlockSet.has(block)) {
      block.frontMatterRole = 'abstract-body'
      continue
    }
    const alignedWithTitle = Boolean(
      titleBlock &&
      (Math.abs(block.region.box.x - titleBlock.region.box.x) <= 0.025 ||
        Math.abs(
          block.region.box.x +
            block.region.box.width / 2 -
            (titleBlock.region.box.x + titleBlock.region.box.width / 2),
        ) <= 0.035),
    )
    const strongTitleContinuation = Boolean(
      titleBlock &&
      block.region.box.y > titleBlock.region.box.y &&
      !/^\p{L}$/u.test(block.text.trim()) &&
      !likelyAffiliation(block.text) &&
      numberedAffiliationsFromBlock(block).length === 0 &&
      authorNamesFromBlock(block).length === 0 &&
      alignedWithTitle &&
      largestBlockFont(block) >= titleFont * 0.72 &&
      block.region.box.y < 0.32,
    )
    if (strongTitleContinuation) {
      block.frontMatterRole = 'title'
    } else if (authorNamesFromBlock(block).length > 0) {
      block.frontMatterRole = 'author'
    } else if (
      likelyAffiliation(block.text) ||
      numberedAffiliationsFromBlock(block).length > 0
    ) {
      block.frontMatterRole = 'affiliation'
    }
  }

  let abstractText = inferredAbstractBlocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  if (abstractBlock) {
    const inlineAbstract = abstractBlock.text
      .trim()
      .match(/^abstract\s*[:.—-]?\s+(.+)$/i)?.[1]
    abstractBlock.frontMatterRole = inlineAbstract
      ? 'abstract-body'
      : 'abstract-heading'
    if (inlineAbstract) abstractText = inlineAbstract.trim()
    for (const block of firstPage.slice(abstractIndex + 1)) {
      if (block.region.box.y <= abstractBlock.region.box.y) continue
      const overlap = Math.max(
        0,
        Math.min(
          block.region.box.x + block.region.box.width,
          abstractBlock.region.box.x + abstractBlock.region.box.width,
        ) - Math.max(block.region.box.x, abstractBlock.region.box.x),
      )
      if (
        overlap <
        Math.min(block.region.box.width, abstractBlock.region.box.width) * 0.5
      ) {
        continue
      }
      if (block.type === 'heading') break
      block.frontMatterRole = 'abstract-body'
      abstractText = [abstractText, block.text].filter(Boolean).join(' ')
    }
  }

  const inferredTitle = beforeAbstract
    .filter((block) => block.frontMatterRole === 'title')
    .sort(
      (left, right) =>
        left.region.page - right.region.page ||
        left.region.box.y - right.region.box.y ||
        left.region.box.x - right.region.box.x,
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
  // A matching metadata title corroborates identity, but it is not a
  // typography authority. PDF document properties commonly flatten authored
  // dashes and apostrophes, so retain the exact visible source text whenever
  // the title page supplied it.
  const title =
    inferredTitle || metadataTitle?.trim().replace(/\s+/g, ' ') || undefined
  const authors = beforeAbstract.flatMap((block) =>
    block.frontMatterRole === 'author' ? authorNamesFromBlock(block) : [],
  )
  const affiliations = beforeAbstract.flatMap((block) =>
    block.frontMatterRole === 'author' ||
    block.frontMatterRole === 'affiliation'
      ? (() => {
          const numbered = numberedAffiliationsFromBlock(block)
          if (numbered.length > 0) return numbered
          const collectiveAuthors = new Set(authorNamesFromBlock(block))
          const lines = block.region.lines
            .map((line) => line.text.trim())
            .filter(
              (line) =>
                line &&
                likelyAffiliation(line) &&
                !collectiveAuthors.has(normalizedAuthorName(line)),
            )
          return lines.length > 0
            ? lines
            : block.frontMatterRole === 'affiliation'
              ? [block.text.trim()]
              : []
        })()
      : [],
  )
  return {
    detected: true,
    title,
    authors: [...new Set(authors)],
    affiliations: [...new Set(affiliations)],
    abstract: abstractText.trim(),
    inferredAbstract: inferredAbstractBlocks.length > 0,
  }
}
