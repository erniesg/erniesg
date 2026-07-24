#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isStrictSemanticTable } from '../src/research/semantic-table.ts'
import { assertAdapterSourceIdentity } from './adapter-source-identity.mjs'

const REQUEST_SCHEMA_VERSIONS = new Set(['1.1.0', '1.2.0'])
const PREDICTIONS_SCHEMA_VERSION = '1.0.0'
const ADAPTER_FORMAT_VERSION = '1.1.0'
const ADAPTER_PATH = fileURLToPath(import.meta.url)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const TASKS = new Set([
  'classification',
  'detection',
  'reading-order',
  'relationship',
])

function invalid(code) {
  throw new Error(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  )
}

function unit(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function validBox(value) {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(unit) &&
    value[2] > 0 &&
    value[3] > 0 &&
    value[0] + value[2] <= 1.000001 &&
    value[1] + value[3] <= 1.000001
  )
}

function normalizedBox(value) {
  const result = [value.x, value.y, value.width, value.height]
  return validBox(result) ? result.map((item) => rounded(item)) : null
}

function rounded(value) {
  return Math.round(value * 100_000_000) / 100_000_000
}

function area(box) {
  return box[2] * box[3]
}

function intersectionArea(left, right) {
  const x1 = Math.max(left[0], right[0])
  const y1 = Math.max(left[1], right[1])
  const x2 = Math.min(left[0] + left[2], right[0] + right[2])
  const y2 = Math.min(left[1] + left[3], right[1] + right[3])
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

function intersectionOverUnion(left, right) {
  const intersection = intersectionArea(left, right)
  const union = area(left) + area(right) - intersection
  return union === 0 ? 0 : intersection / union
}

function overlapScore(left, right) {
  const intersection = intersectionArea(left, right)
  if (intersection === 0) return 0
  return Math.max(
    intersection / Math.min(area(left), area(right)),
    intersectionOverUnion(left, right),
  )
}

function envelope(boxes) {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box[0]))
  const top = Math.min(...boxes.map((box) => box[1]))
  const right = Math.max(...boxes.map((box) => box[0] + box[2]))
  const bottom = Math.max(...boxes.map((box) => box[1] + box[3]))
  const result = [left, top, right - left, bottom - top].map(rounded)
  return validBox(result) ? result : null
}

function sourceBoxesOnPage(values, page) {
  return (values ?? [])
    .filter((value) => value?.page === page)
    .map(normalizedBox)
    .filter((value) => value !== null)
}

function visualPage(relationship, regions, assets) {
  const caption = regions.get(relationship.captionRegionId)
  if (caption) return caption.page
  for (const assetId of relationship.assetIds ?? []) {
    const asset = assets.get(assetId)
    const page = asset?.sourceCropBox?.page ?? asset?.sourceBoxes?.[0]?.page
    if (Number.isInteger(page)) return page
  }
  return relationship.sourceBoxes?.[0]?.page ?? null
}

function visualObjectBox(relationship, page, assets) {
  const relatedAssets = (relationship.assetIds ?? [])
    .map((id) => assets.get(id))
    .filter(Boolean)
  const cropBoxes = relatedAssets
    .map((asset) => asset.sourceCropBox)
    .filter((box) => box?.page === page)
    .map(normalizedBox)
    .filter((box) => box !== null)
  if (cropBoxes.length === 1) return cropBoxes[0]
  if (cropBoxes.length > 1) return envelope(cropBoxes)

  const assetBoxes = relatedAssets.flatMap((asset) =>
    sourceBoxesOnPage(asset.sourceBoxes, page),
  )
  if (assetBoxes.length > 0) return envelope(assetBoxes)

  const candidate = [...(relationship.candidates ?? [])]
    .filter((item) => sourceBoxesOnPage(item.sourceBoxes, page).length > 0)
    .sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )[0]
  return candidate
    ? envelope(sourceBoxesOnPage(candidate.sourceBoxes, page))
    : null
}

function regionLabel(kind, text = '') {
  if (kind === 'body' || kind === 'spanning') return 'prose'
  if (kind === 'endnote') return 'footnote'
  if (
    kind === 'chart-label' &&
    /^[+\-\u2212]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+\-]?\d+)?%?$/u.test(
      text.trim(),
    )
  ) {
    return 'chart-axis-tick'
  }
  if (
    kind === 'caption' ||
    kind === 'footnote' ||
    kind === 'equation' ||
    kind === 'figure'
  ) {
    return kind
  }
  return null
}

function canonicalRegionLabels(reconstruction) {
  const labels = new Map()
  const regions = reconstruction.regions ?? []
  for (const node of reconstruction.paper?.nodes ?? []) {
    const label =
      node.type === 'heading'
        ? 'heading'
        : node.type === 'footnote'
          ? 'footnote'
          : node.type === 'caption'
            ? 'caption'
            : node.type === 'paragraph' && node.list?.ordered
              ? node.list.numberingId === 'references'
                ? 'reference-entry'
                : 'ordered-list-item'
              : node.type === 'paragraph'
                ? 'prose'
                : null
    if (!label) continue
    const evidence = reconstruction.provenance?.[node.id]
    for (const regionId of evidence?.regionIds ?? []) {
      labels.set(regionId, label)
    }
    if ((evidence?.regionIds ?? []).length > 0) continue
    for (const sourceBox of evidence?.boxes ?? []) {
      const box = normalizedBox(sourceBox)
      if (!box) continue
      for (const region of regions) {
        const regionBox = normalizedBox(region.box)
        if (
          region.page === sourceBox.page &&
          regionBox &&
          intersectionOverUnion(box, regionBox) >= 0.9 &&
          !labels.has(region.id)
        ) {
          labels.set(region.id, label)
        }
      }
    }
  }
  return labels
}

function visualCaptionBox(relationship, page, regions, provenance) {
  const evidence = relationship.captionNodeId
    ? provenance?.[relationship.captionNodeId]
    : null
  const evidenceBox = envelope(sourceBoxesOnPage(evidence?.boxes, page))
  if (evidenceBox) return evidenceBox
  const caption = regions.get(relationship.captionRegionId)
  return caption?.page === page ? normalizedBox(caption.box) : null
}

function selectedVisualCandidate(relationship, page) {
  return [...(relationship.candidates ?? [])]
    .filter((item) => sourceBoxesOnPage(item.sourceBoxes, page).length > 0)
    .sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )[0]
}

function equationNumberRegion(region) {
  return /^\(\s*(?:[A-Za-z]+\s*)?\d+(?:[.\-]\d+)*\s*\)$/u.test(
    region.text?.trim() ?? '',
  )
}

function horizontalOverlapRatio(left, right) {
  const overlap = Math.max(
    0,
    Math.min(left[0] + left[2], right[0] + right[2]) -
      Math.max(left[0], right[0]),
  )
  return overlap / Math.min(left[2], right[2])
}

function verticalGap(left, right) {
  return Math.max(
    left[1] - (right[1] + right[3]),
    right[1] - (left[1] + left[3]),
    0,
  )
}

function figureInternalTextGroups(relationship, page, visualBox, regions) {
  const candidate = selectedVisualCandidate(relationship, page)
  const sourceRegionIds =
    relationship.sourceRegionIds?.length > 0
      ? relationship.sourceRegionIds
      : (candidate?.sourceRegionIds ?? [])
  const members = sourceRegionIds
    .map((id) => regions.get(id))
    .filter((region) => {
      const box = region ? normalizedBox(region.box) : null
      return Boolean(
        region &&
        region.id !== relationship.captionRegionId &&
        region.page === page &&
        region.text?.trim() &&
        box &&
        intersectionArea(box, visualBox) / area(box) >= 0.8,
      )
    })
    .map((region) => ({ region, box: normalizedBox(region.box) }))
    .filter((item) => item.box !== null)
    .sort(
      (left, right) =>
        left.box[1] - right.box[1] ||
        left.box[0] - right.box[0] ||
        left.region.id.localeCompare(right.region.id),
    )
  const flowKinds = new Set(['body', 'spanning', 'equation'])
  const assigned = new Set()
  const groups = []
  for (const seed of members.filter(({ region }) =>
    flowKinds.has(region.kind),
  )) {
    if (assigned.has(seed.region.id)) continue
    const group = [seed]
    assigned.add(seed.region.id)
    for (let index = 0; index < group.length; index += 1) {
      const current = group[index]
      for (const member of members) {
        if (
          assigned.has(member.region.id) ||
          verticalGap(current.box, member.box) > 0.006 ||
          horizontalOverlapRatio(current.box, member.box) < 0.25
        ) {
          continue
        }
        assigned.add(member.region.id)
        group.push(member)
      }
    }
    const box = envelope(group.map((item) => item.box))
    if (box) groups.push(box)
  }
  return groups
}

function semanticTableEntities(reconstruction) {
  const assets = new Map(
    (reconstruction.assets ?? []).map((asset) => [asset.id, asset]),
  )
  return (reconstruction.paper?.nodes ?? []).flatMap((node) => {
    if (
      node.type !== 'figure' ||
      node.objectType !== 'table' ||
      !isStrictSemanticTable(node.table)
    ) {
      return []
    }
    const evidence = reconstruction.provenance?.[node.id]
    const assetIds = node.relationships?.assets ?? []
    const assetPages = new Set(
      assetIds.flatMap((assetId) => {
        const asset = assets.get(assetId)
        return [asset?.sourceCropBox, ...(asset?.sourceBoxes ?? [])].flatMap(
          (box) => (Number.isInteger(box?.page) ? [box.page] : []),
        )
      }),
    )
    const pages =
      assetPages.size > 0 ? [...assetPages] : [...(evidence?.pages ?? [])]
    return pages.flatMap((page) => {
      const assetBox = visualObjectBox({ assetIds }, page, assets)
      const box = assetBox ?? envelope(sourceBoxesOnPage(evidence?.boxes, page))
      return box
        ? [
            {
              id: `semantic-table:${node.id}`,
              page,
              label: 'semantic-table',
              box,
            },
          ]
        : []
    })
  })
}

function numericRangeEntities(reconstruction) {
  const citations = reconstruction.citationRelationships ?? []
  const entities = []
  for (const region of reconstruction.regions ?? []) {
    const expression =
      /∈\s*\[\s*[−-]?\d+(?:\.\d+)?\s*,\s*[−-]?\d+(?:\.\d+)?\s*\]/gu
    for (const match of region.text?.matchAll(expression) ?? []) {
      const start = match.index ?? 0
      const end = start + match[0].length
      const misclassified = citations.some(
        (citation) =>
          citation.referenceRegionId === region.id &&
          citation.referenceStart < end &&
          citation.referenceEnd > start,
      )
      const box = normalizedBox(region.box)
      if (!misclassified && box) {
        entities.push({
          id: `numeric-range:${region.id}:${String(start).padStart(6, '0')}`,
          page: region.page,
          label: 'numeric-range',
          box,
        })
      }
    }
  }
  return entities
}

function titleInvariant(reconstruction) {
  const title = reconstruction.paper?.title?.trim().replace(/\s+/g, ' ')
  if (!title) return null
  const nodeOccurrences = (reconstruction.paper?.nodes ?? []).filter((node) => {
    const text = typeof node.text === 'string' ? node.text : node.title
    return text?.trim().replace(/\s+/g, ' ') === title
  }).length
  return {
    id: 'title-occurrence',
    label: nodeOccurrences === 0 ? 'not-duplicated' : 'duplicated',
  }
}

export function observeDeterministicReconstruction(reconstruction) {
  const pageCount = reconstruction.source?.pageCount
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    invalid('INVALID_DETERMINISTIC_RECONSTRUCTION')
  }
  const regions = new Map(
    (reconstruction.regions ?? []).map((region) => [region.id, region]),
  )
  const assets = new Map(
    (reconstruction.assets ?? []).map((asset) => [asset.id, asset]),
  )
  const canonicalLabels = canonicalRegionLabels(reconstruction)
  const orderPosition = new Map(
    (reconstruction.readingOrder?.order ?? []).map((id, index) => [id, index]),
  )
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    entities: [],
    objects: [],
    relationships: [],
    order: [],
    visualOrder: [],
  }))
  const pageByNumber = new Map(pages.map((page) => [page.page, page]))

  for (const region of regions.values()) {
    const label =
      canonicalLabels.get(region.id) ?? regionLabel(region.kind, region.text)
    const box = normalizedBox(region.box)
    const page = pageByNumber.get(region.page)
    if (!label || !box || !page) continue
    page.entities.push({ id: region.id, label, box })
    if (orderPosition.has(region.id)) page.order.push(region.id)
  }

  for (const entity of [
    ...semanticTableEntities(reconstruction),
    ...numericRangeEntities(reconstruction),
  ]) {
    pageByNumber.get(entity.page)?.entities.push({
      id: entity.id,
      label: entity.label,
      box: entity.box,
    })
  }

  for (const relationship of reconstruction.noteRelationships ?? []) {
    if (relationship.status !== 'matched' || !relationship.targetNoteId) {
      continue
    }
    const reference = regions.get(relationship.referenceRegionId)
    const target = (relationship.candidates ?? []).find(
      (candidate) => candidate.targetNoteId === relationship.targetNoteId,
    )
    const note = target ? regions.get(target.targetRegionId) : null
    const referenceBox = reference ? normalizedBox(reference.box) : null
    const noteBox = note ? normalizedBox(note.box) : null
    if (
      !reference ||
      !note ||
      reference.page !== note.page ||
      !referenceBox ||
      !noteBox
    ) {
      continue
    }
    const page = pageByNumber.get(reference.page)
    const referenceId = `note-reference:${relationship.id}`
    if (!page) continue
    page.entities.push({
      id: referenceId,
      label: 'note-reference',
      box: referenceBox,
    })
    page.relationships.push({
      type: 'note-body-of',
      sourceId: note.id,
      targetId: referenceId,
    })
  }

  for (const relationship of reconstruction.visualRelationships ?? []) {
    const pageNumber = visualPage(relationship, regions, assets)
    const page = pageByNumber.get(pageNumber)
    const box = page ? visualObjectBox(relationship, pageNumber, assets) : null
    if (!page) continue

    let captionId = null
    if (relationship.kind !== 'equation') {
      const captionBox = visualCaptionBox(
        relationship,
        pageNumber,
        regions,
        reconstruction.provenance,
      )
      if (captionBox) {
        captionId = `caption:${relationship.id}`
        const caption = { id: captionId, label: 'caption', box: captionBox }
        page.entities.push(caption)
        page.objects.push(caption)
      }
    }

    let visualEntityId = null
    if (box) {
      visualEntityId =
        relationship.status === 'matched'
          ? relationship.id
          : `visual-evidence:${relationship.id}`
      const object = {
        id: visualEntityId,
        label: relationship.kind,
        box,
      }
      page.entities.push(object)
      if (relationship.status === 'matched') {
        page.objects.push(object)
        page.visualOrder.push(visualEntityId)
      }
    }
    if (
      relationship.status === 'matched' &&
      relationship.kind !== 'equation' &&
      captionId &&
      visualEntityId
    ) {
      page.relationships.push({
        type: 'caption-of',
        sourceId: captionId,
        targetId: visualEntityId,
      })
    }

    if (relationship.status === 'matched' && relationship.kind === 'equation') {
      const equation = regions.get(relationship.captionRegionId)
      if (equation?.page === pageNumber) {
        for (const regionId of relationship.sourceRegionIds ?? []) {
          const number = regions.get(regionId)
          if (
            number &&
            number.id !== equation.id &&
            number.page === equation.page &&
            equationNumberRegion(number)
          ) {
            page.relationships.push({
              type: 'equation-number-of',
              sourceId: number.id,
              targetId: equation.id,
            })
          }
        }
      }
    }

    if (
      relationship.kind === 'figure' &&
      relationship.sourceText?.trim() &&
      visualEntityId &&
      box
    ) {
      for (const [index, sourceBox] of figureInternalTextGroups(
        relationship,
        pageNumber,
        box,
        regions,
      ).entries()) {
        const sourceId = `figure-internal-text:${relationship.id}:${String(index + 1).padStart(3, '0')}`
        page.entities.push({
          id: sourceId,
          label: 'figure-internal-text',
          box: sourceBox,
        })
        page.relationships.push({
          type: 'figure-internal-text-of',
          sourceId,
          targetId: visualEntityId,
        })
      }
    }
  }

  for (const page of pages) {
    page.entities.sort((left, right) => left.id.localeCompare(right.id))
    page.objects.sort((left, right) => left.id.localeCompare(right.id))
    page.relationships.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
    page.order.sort(
      (left, right) =>
        (orderPosition.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (orderPosition.get(right) ?? Number.MAX_SAFE_INTEGER) ||
        left.localeCompare(right),
    )
  }

  const fact = titleInvariant(reconstruction)
  return {
    source: {
      sha256: reconstruction.source.sha256,
      byteLength: reconstruction.source.byteLength,
      pageCount,
    },
    facts: fact ? [fact] : [],
    pages,
  }
}

function observationsFor(value) {
  return Array.isArray(value?.pages)
    ? value
    : observeDeterministicReconstruction(value)
}

function bestEntity(entities, target, allowedIds = null) {
  if (!target.box) return null
  return entities
    .filter((entity) => !allowedIds || allowedIds.has(entity.id))
    .map((entity) => ({
      entity,
      score: overlapScore(entity.box, target.box),
      iou: intersectionOverUnion(entity.box, target.box),
      areaDelta: Math.abs(area(entity.box) - area(target.box)),
    }))
    .filter(({ score }) => score >= 0.25)
    .sort(
      (left, right) =>
        right.iou - left.iou ||
        right.score - left.score ||
        left.areaDelta - right.areaDelta ||
        Number(right.entity.label === 'semantic-table') -
          Number(left.entity.label === 'semantic-table') ||
        left.entity.id.localeCompare(right.entity.id),
    )[0]?.entity
}

function uniqueRelationships(values) {
  const seen = new Set()
  return values.filter((value) => {
    const key = JSON.stringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function bestTargetForEntity(entity, targets, excludedId = null) {
  return targets
    .filter(({ id, box }) => id !== excludedId && box !== null)
    .map((candidate) => ({
      candidate,
      score: overlapScore(entity.box, candidate.box),
      iou: intersectionOverUnion(entity.box, candidate.box),
      areaDelta: Math.abs(area(entity.box) - area(candidate.box)),
    }))
    .sort(
      (left, right) =>
        right.iou - left.iou ||
        right.score - left.score ||
        left.areaDelta - right.areaDelta ||
        left.candidate.id.localeCompare(right.candidate.id),
    )[0]
}

function classifyTarget(item, target, observations, page) {
  if (target.box) {
    return (
      bestEntity(
        page.entities.filter(({ label }) => label !== 'numeric-range'),
        target,
      )?.label ?? null
    )
  }
  if (item.stratum === 'document-invariant') {
    const labels = new Set(observations.facts.map(({ label }) => label))
    return labels.size === 1 ? [...labels][0] : null
  }
  if (item.stratum === 'semantic-type-confusion') {
    const labels = new Set(
      page.entities
        .filter(({ label }) => label === 'numeric-range')
        .map(({ label }) => label),
    )
    return labels.size === 1 ? [...labels][0] : null
  }
  return null
}

export function predictDeterministicCase(item, reconstruction) {
  const observations = observationsFor(reconstruction)
  if (item.task === 'reading-order') {
    const matches = item.targets.flatMap((target) => {
      const sourcePage = target.sourcePage ?? item.page
      const targetPage = observations.pages.find(
        (candidate) => candidate.page === sourcePage,
      )
      if (!targetPage) return []
      const visualPositions = new Map(
        (targetPage.visualOrder ?? []).map((id, index) => [id, index]),
      )
      const visualEntity = bestEntity(
        targetPage.entities,
        target,
        new Set(visualPositions.keys()),
      )
      if (visualEntity) {
        return [
          {
            id: target.id,
            sourcePage,
            position: visualPositions.get(visualEntity.id),
          },
        ]
      }
      const positions = new Map(
        targetPage.order.map((id, index) => [id, index]),
      )
      const entity = bestEntity(
        targetPage.entities,
        target,
        new Set(targetPage.order),
      )
      return entity
        ? [
            {
              id: target.id,
              sourcePage,
              position: positions.get(entity.id),
            },
          ]
        : []
    })
    return {
      order: matches
        .sort(
          (left, right) =>
            left.sourcePage - right.sourcePage ||
            left.position - right.position ||
            left.id.localeCompare(right.id),
        )
        .map(({ id }) => id),
    }
  }
  const page = observations.pages.find(
    (candidate) => candidate.page === item.page,
  )
  if (!page) {
    if (item.task === 'classification') return { labels: [] }
    if (item.task === 'reading-order') return { order: [] }
    if (item.task === 'relationship') return { relationships: [] }
    return { objects: [] }
  }
  if (item.task === 'detection') {
    return { objects: page.objects.map((object) => ({ ...object })) }
  }
  if (item.task === 'classification') {
    return {
      labels: item.targets.flatMap((target) => {
        const label = classifyTarget(item, target, observations, page)
        return label ? [{ targetId: target.id, label }] : []
      }),
    }
  }
  if (item.task === 'relationship') {
    const entities = new Map(page.entities.map((entity) => [entity.id, entity]))
    const relationships = page.relationships.flatMap((relationship) => {
      const source = entities.get(relationship.sourceId)
      const target = entities.get(relationship.targetId)
      if (!source || !target) return []
      const sourceCandidate = bestTargetForEntity(source, item.targets)
      const targetCandidate = bestTargetForEntity(
        target,
        item.targets,
        sourceCandidate?.candidate.id,
      )
      if (
        !sourceCandidate ||
        !targetCandidate ||
        sourceCandidate.score < 0.25 ||
        targetCandidate.score < 0.25
      ) {
        return []
      }
      return [
        {
          type: relationship.type,
          sourceId: sourceCandidate.candidate.id,
          targetId: targetCandidate.candidate.id,
        },
      ]
    })
    return { relationships: uniqueRelationships(relationships) }
  }
  invalid('INVALID_DETERMINISTIC_EVAL_REQUEST')
}

function validateRequest(request) {
  const valid =
    exactKeys(request, [
      'schemaVersion',
      'privacy',
      'evalSet',
      'candidate',
      'documents',
      'cases',
    ]) &&
    REQUEST_SCHEMA_VERSIONS.has(request.schemaVersion) &&
    request.privacy ===
      'owner-local-paths-present-ephemeral-delete-after-run' &&
    exactKeys(request.evalSet, ['id', 'sha256']) &&
    SAFE_ID.test(request.evalSet.id) &&
    SHA256.test(request.evalSet.sha256) &&
    exactKeys(request.candidate, ['id', 'version', 'adapterSha256']) &&
    SAFE_ID.test(request.candidate.id) &&
    SAFE_ID.test(request.candidate.version) &&
    SHA256.test(request.candidate.adapterSha256) &&
    Array.isArray(request.documents) &&
    request.documents.every(
      (document) =>
        exactKeys(document, [
          'id',
          'path',
          'byteLength',
          'sha256',
          'pageCount',
        ]) &&
        SAFE_ID.test(document.id) &&
        typeof document.path === 'string' &&
        document.path.length > 0 &&
        Number.isSafeInteger(document.byteLength) &&
        document.byteLength > 0 &&
        SHA256.test(document.sha256) &&
        Number.isSafeInteger(document.pageCount) &&
        document.pageCount > 0,
    ) &&
    Array.isArray(request.cases) &&
    request.cases.every(
      (item) =>
        exactKeys(item, [
          'id',
          'documentId',
          'page',
          'stratum',
          'task',
          'targets',
        ]) &&
        SAFE_ID.test(item.id) &&
        SAFE_ID.test(item.documentId) &&
        Number.isSafeInteger(item.page) &&
        item.page > 0 &&
        SAFE_ID.test(item.stratum) &&
        TASKS.has(item.task) &&
        Array.isArray(item.targets) &&
        (item.task !== 'detection' || item.targets.length === 0) &&
        item.targets.every((target) => {
          const keys =
            request.schemaVersion === '1.2.0'
              ? ['id', 'kind', 'sourcePage', 'box']
              : ['id', 'kind', 'box']
          return (
            exactKeys(target, keys) &&
            SAFE_ID.test(target.id) &&
            target.kind === 'candidate' &&
            (request.schemaVersion !== '1.2.0' ||
              (Number.isSafeInteger(target.sourcePage) &&
                target.sourcePage > 0)) &&
            (target.box === null || validBox(target.box))
          )
        }),
    )
  if (!valid) invalid('INVALID_DETERMINISTIC_EVAL_REQUEST')
}

export function createDeterministicPredictions(request, reconstructions) {
  validateRequest(request)
  const documents = new Map(request.documents.map((item) => [item.id, item]))
  const observations = new Map()
  for (const [documentId, document] of documents) {
    const reconstruction = reconstructions.get(documentId)
    if (
      !reconstruction ||
      reconstruction.source?.sha256 !== document.sha256 ||
      reconstruction.source?.byteLength !== document.byteLength ||
      reconstruction.source?.pageCount !== document.pageCount
    ) {
      invalid('SOURCE_IDENTITY_MISMATCH')
    }
    observations.set(
      documentId,
      observeDeterministicReconstruction(reconstruction),
    )
  }
  return {
    schemaVersion: PREDICTIONS_SCHEMA_VERSION,
    evalSetId: request.evalSet.id,
    evalSetSha256: request.evalSet.sha256,
    candidate: {
      id: request.candidate.id,
      version: request.candidate.version,
      format: 'srt-pdf-reconstruction',
      formatVersion: ADAPTER_FORMAT_VERSION,
      adapterSha256: request.candidate.adapterSha256,
      runtimeIdentity: {
        status: 'not-applicable',
        tool: null,
        model: null,
      },
    },
    cases: request.cases.map((item) => ({
      caseId: item.id,
      output: predictDeterministicCase(item, observations.get(item.documentId)),
    })),
  }
}

function parseArguments(arguments_) {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== '--request' ||
    arguments_[2] !== '--output' ||
    !arguments_[1] ||
    !arguments_[3]
  ) {
    invalid('INVALID_USAGE')
  }
  return { request: arguments_[1], output: arguments_[3] }
}

async function main() {
  const paths = parseArguments(process.argv.slice(2))
  const request = JSON.parse(await readFile(paths.request, 'utf8'))
  validateRequest(request)
  await assertAdapterSourceIdentity(
    ADAPTER_PATH,
    request.candidate.adapterSha256,
    'DETERMINISTIC_ADAPTER_IDENTITY_MISMATCH',
  )
  const { createPdfPipeline } = await import('./pdf-corpus-audit-lib.mjs')
  const pipeline = await createPdfPipeline()
  const reconstructions = new Map()
  try {
    for (const document of request.documents) {
      const bytes = await readFile(document.path)
      const reconstruction = await pipeline.reconstructPdf(
        new File([bytes], `${document.id}.pdf`, {
          type: 'application/pdf',
          lastModified: 0,
        }),
        undefined,
        { standardFontDataUrl: pipeline.standardFontDataUrl },
      )
      reconstructions.set(document.id, reconstruction)
    }
    const predictions = createDeterministicPredictions(request, reconstructions)
    await writeFile(paths.output, `${JSON.stringify(predictions)}\n`, {
      mode: 0o600,
    })
  } finally {
    await pipeline.close()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const code = SAFE_ID.test(error?.message ?? '')
      ? error.message
      : 'DETERMINISTIC_EVAL_ADAPTER_FAILED'
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`)
    process.exitCode = 2
  })
}
