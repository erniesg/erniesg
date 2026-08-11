const ASSOCIATION_KINDS = new Set(['note', 'citation'])
const EXPECTED_STATUSES = new Set(['matched', 'ambiguous'])
const ANCHOR_OWNERS = new Set([
  'paragraph',
  'caption',
  'footnote',
  'table-cell',
])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function stringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(nonEmptyString) &&
    new Set(value).size === value.length
  )
}

export function validateAssociationGroundTruth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Association ground truth must be an object')
  }
  if (
    value.schemaVersion !== '1.0.0' ||
    !nonEmptyString(value.fixture) ||
    !/^[a-f0-9]{64}$/u.test(value.fixtureSha256 ?? '') ||
    !/^[a-f0-9]{40}$/u.test(value.baselineRef ?? '') ||
    !Array.isArray(value.associations) ||
    value.associations.length === 0
  ) {
    throw new Error('Association ground truth header is invalid')
  }

  const ids = new Set()
  for (const association of value.associations) {
    if (
      !association ||
      typeof association !== 'object' ||
      Array.isArray(association) ||
      !nonEmptyString(association.id) ||
      ids.has(association.id) ||
      !ASSOCIATION_KINDS.has(association.kind) ||
      !nonEmptyString(association.label) ||
      !EXPECTED_STATUSES.has(association.expectedStatus) ||
      !Number.isInteger(association.page) ||
      association.page < 1 ||
      (!nonEmptyString(association.sourceIncludes) &&
        !stringArray(association.sourceEqualsAny)) ||
      !ANCHOR_OWNERS.has(association.anchorOwner)
    ) {
      throw new Error('Association ground truth entry is invalid')
    }
    if (
      association.expectedStatus === 'matched' &&
      !stringArray(association.targetLabels) &&
      !stringArray(association.targetTextIncludes)
    ) {
      throw new Error(`Matched association ${association.id} lacks targets`)
    }
    if (
      association.expectedStatus === 'ambiguous' &&
      (!Number.isInteger(association.minimumCandidateCount) ||
        association.minimumCandidateCount < 2)
    ) {
      throw new Error(
        `Ambiguous association ${association.id} lacks candidate cardinality`,
      )
    }
    ids.add(association.id)
  }
  return value
}

function normalizedLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^\[|\]$/gu, '')
}

function sourceRegion(reconstruction, relationship) {
  return reconstruction.regions.find(
    (region) => region.id === relationship.referenceRegionId,
  )
}

function relationshipMatches(reconstruction, relationship, expected) {
  const region = sourceRegion(reconstruction, relationship)
  if (
    normalizedLabel(relationship.label) !== normalizedLabel(expected.label) ||
    region?.page !== expected.page
  ) {
    return false
  }
  if (
    expected.sourceIncludes &&
    !region.text.includes(expected.sourceIncludes)
  ) {
    return false
  }
  if (
    expected.sourceEqualsAny &&
    !expected.sourceEqualsAny.includes(region.text.trim())
  ) {
    return false
  }
  return true
}

function nodeById(reconstruction, id) {
  return reconstruction.paper.nodes.find((node) => node.id === id)
}

function anchorOwner(reconstruction, relationship) {
  const anchor = relationship.canonicalAnchor
  if (!anchor || anchor.kind === 'author') return null
  if (anchor.nodeId.includes(':table:')) return 'table-cell'
  const node = nodeById(reconstruction, anchor.nodeId)
  if (node?.type === 'footnote') return 'footnote'
  if (node?.type === 'caption') return 'caption'
  if (node?.type === 'paragraph' || node?.type === 'heading') {
    return 'paragraph'
  }
  return null
}

function targetIds(relationship, kind) {
  return kind === 'note'
    ? relationship.targetNoteId
      ? [relationship.targetNoteId]
      : []
    : relationship.targetNodeIds
}

function candidateCount(relationship, kind) {
  if (kind === 'note') return relationship.candidates?.length ?? 0
  return relationship.candidateNodeIds?.length ?? 0
}

function targetLabel(node) {
  if (!node) return null
  if (node.type === 'footnote') return normalizedLabel(node.label)
  if (node.type === 'paragraph' && node.list?.numberingId === 'references') {
    if (node.list.ordinal) return String(node.list.ordinal)
    if (node.list.markerText) return normalizedLabel(node.list.markerText)
  }
  return null
}

function targetsMatch(reconstruction, relationship, expected) {
  const nodes = targetIds(relationship, expected.kind).map((id) =>
    nodeById(reconstruction, id),
  )
  if (nodes.some((node) => !node)) return false
  if (expected.targetLabels) {
    const actual = nodes.map(targetLabel)
    if (
      actual.length !== expected.targetLabels.length ||
      actual.some(
        (label, index) =>
          label !== normalizedLabel(expected.targetLabels[index]),
      )
    ) {
      return false
    }
  }
  if (expected.targetTextIncludes) {
    if (
      nodes.length !== 1 ||
      expected.targetTextIncludes.some(
        (fragment) => !String(nodes[0]?.text ?? '').includes(fragment),
      )
    ) {
      return false
    }
  }
  if (expected.targetKind) {
    if (
      nodes.length !== 1 ||
      nodes[0]?.type !== 'footnote' ||
      nodes[0].kind !== expected.targetKind
    ) {
      return false
    }
  }
  return true
}

function observedStatus(relationship) {
  return relationship?.status === 'matched' ||
    relationship?.status === 'ambiguous' ||
    relationship?.status === 'unresolved'
    ? relationship.status
    : relationship
      ? 'other'
      : 'missing'
}

function diagnosticCounts(reconstruction) {
  const counts = new Map()
  for (const diagnostic of reconstruction.diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function canonicalRate(numerator, denominator) {
  return denominator === 0
    ? 0
    : Math.round((numerator / denominator) * 100_000) / 100_000
}

export function auditAssociationReconstruction(reconstruction, groundTruth) {
  validateAssociationGroundTruth(groundTruth)
  const results = []
  for (const expected of groundTruth.associations) {
    const pool =
      expected.kind === 'note'
        ? reconstruction.noteRelationships
        : reconstruction.citationRelationships
    const matches = pool.filter((relationship) =>
      relationshipMatches(reconstruction, relationship, expected),
    )
    const relationship = matches.length === 1 ? matches[0] : null
    const status = observedStatus(relationship)
    let outcome = 'unresolved'
    let reason =
      matches.length > 1
        ? 'non-unique-observed-marker'
        : matches.length === 0
          ? 'marker-not-detected'
          : `observed-${status}`

    if (expected.expectedStatus === 'ambiguous') {
      if (
        relationship &&
        status === 'ambiguous' &&
        targetIds(relationship, expected.kind).length === 0 &&
        candidateCount(relationship, expected.kind) >=
          expected.minimumCandidateCount &&
        anchorOwner(reconstruction, relationship) === expected.anchorOwner
      ) {
        outcome = 'ambiguous'
        reason = 'source-ambiguity-retained'
      } else if (relationship && status === 'matched') {
        outcome = 'false-link'
        reason = 'ambiguous-marker-was-linked'
      }
    } else if (relationship && status === 'matched') {
      const correctTargets = targetsMatch(
        reconstruction,
        relationship,
        expected,
      )
      const correctOwner =
        anchorOwner(reconstruction, relationship) === expected.anchorOwner
      if (correctTargets && correctOwner) {
        outcome = 'matched'
        reason = 'verified-target-and-owner'
      } else {
        outcome = 'false-link'
        reason = correctTargets ? 'incorrect-source-owner' : 'incorrect-target'
      }
    }

    results.push({
      id: expected.id,
      kind: expected.kind,
      expectedStatus: expected.expectedStatus,
      observedStatus: status,
      outcome,
      reason,
    })
  }

  const count = (outcome) =>
    results.filter((result) => result.outcome === outcome).length
  const expectedAssociations = results.length
  const matchedAssociations = count('matched')
  const ambiguousAssociations = count('ambiguous')
  const falseLinkCount = count('false-link')
  const unresolvedAssociations = count('unresolved')
  return {
    counters: {
      expectedAssociations,
      matchedAssociations,
      ambiguousAssociations,
      unresolvedAssociations,
      falseLinkCount,
      resolvedAssociationRate: canonicalRate(
        matchedAssociations,
        expectedAssociations,
      ),
      verifiedAssociationRate: canonicalRate(
        matchedAssociations + ambiguousAssociations,
        expectedAssociations,
      ),
    },
    diagnosticCounts: diagnosticCounts(reconstruction),
    associations: results,
  }
}

export function serializeAssociationAudit(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}
