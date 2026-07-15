import type { ResearchNode } from './schema'
import { getTargetProfile, type TargetProfileId } from './targets'

export const COMPOSITION_POLICY_VERSION = '1.1.0' as const

export const COMPOSITION_DECISION_CODES = [
  'flow-mode',
  'column-count',
  'figure-placement',
  'fragmentation',
] as const

export type CompositionDecisionCode =
  (typeof COMPOSITION_DECISION_CODES)[number]

export type CompositionDecision = {
  code: CompositionDecisionCode
  outcome: string
  reason: string
}

type NodeVariantMap = Record<ResearchNode['type'], string>

type CompositionPolicy = {
  id: string
  version: typeof COMPOSITION_POLICY_VERSION
  flowMode: 'browser-flow' | 'finite-sheet-preview'
  variants: NodeVariantMap
  attemptedFigureVariant?: string
}

const COMPOSITION_POLICIES: Record<TargetProfileId, CompositionPolicy> = {
  mobile: {
    id: 'continuous-mobile',
    version: COMPOSITION_POLICY_VERSION,
    flowMode: 'browser-flow',
    variants: {
      heading: 'section-heading',
      paragraph: 'body-flow',
      quote: 'pull-quote',
      figure: 'edge-to-edge',
      caption: 'figure-caption',
      footnote: 'linked-note',
    },
  },
  paperProMove: {
    id: 'compact-eink',
    version: COMPOSITION_POLICY_VERSION,
    flowMode: 'finite-sheet-preview',
    attemptedFigureVariant: 'dedicated-view',
    variants: {
      heading: 'section-heading-compact',
      paragraph: 'body-compact',
      quote: 'inline-quote',
      figure: 'compact-stack',
      caption: 'figure-caption-compact',
      footnote: 'linked-note-compact',
    },
  },
  paperPro: {
    id: 'large-eink',
    version: COMPOSITION_POLICY_VERSION,
    flowMode: 'finite-sheet-preview',
    variants: {
      heading: 'section-heading',
      paragraph: 'body-flow',
      quote: 'pull-quote',
      figure: 'inline',
      caption: 'figure-caption',
      footnote: 'linked-note',
    },
  },
  print: {
    id: 'a4-two-column',
    version: COMPOSITION_POLICY_VERSION,
    flowMode: 'finite-sheet-preview',
    variants: {
      heading: 'section-heading-compact',
      paragraph: 'body-two-column',
      quote: 'column-quote',
      figure: 'full-span',
      caption: 'figure-caption',
      footnote: 'linked-note-compact',
    },
  },
}

export type NodeComposition = {
  chosenVariant: string
  diagnostics: Array<{
    code: 'variant-unavailable'
    severity: 'info'
    message: string
  }>
  fallback?: {
    fromVariant: string
    diagnosticCode: 'variant-unavailable'
    reason: string
  }
}

export function getCompositionPolicy(target: TargetProfileId) {
  const profile = getTargetProfile(target)
  const policy = COMPOSITION_POLICIES[target]

  const decisions: CompositionDecision[] = [
    {
      code: 'flow-mode',
      outcome: policy.flowMode,
      reason: profile.finiteHeight
        ? 'The target exposes a finite sheet, rendered with browser flow for this milestone.'
        : 'The target has no finite block dimension and uses continuous browser flow.',
    },
    {
      code: 'column-count',
      outcome: String(profile.columns.count),
      reason:
        profile.columns.count > 1
          ? 'The target measure supports a deterministic multi-column reading flow.'
          : 'The target uses a single reading column.',
    },
    {
      code: 'figure-placement',
      outcome: policy.variants.figure,
      reason:
        policy.attemptedFigureVariant !== undefined
          ? `${policy.attemptedFigureVariant} is unavailable; use the compact in-flow variant.`
          : `Use the target policy's ${policy.variants.figure} figure variant.`,
    },
    {
      code: 'fragmentation',
      outcome: profile.finiteHeight ? 'finite-browser-pages' : 'not-applicable',
      reason: profile.finiteHeight
        ? 'A deterministic semantic policy assigns pages and keep rules while browser flow renders measured text fragments.'
        : 'Continuous flow does not require finite-height fragmentation.',
    },
  ]

  return {
    id: policy.id,
    version: policy.version,
    flowMode: policy.flowMode,
    decisions,
  }
}

export function resolveNodeComposition(
  target: TargetProfileId,
  node: ResearchNode,
): NodeComposition {
  const policy = COMPOSITION_POLICIES[target]
  const chosenVariant = policy.variants[node.type]

  if (node.type !== 'figure' || !policy.attemptedFigureVariant) {
    return { chosenVariant, diagnostics: [] }
  }

  return {
    chosenVariant,
    diagnostics: [
      {
        code: 'variant-unavailable',
        severity: 'info',
        message: `${policy.attemptedFigureVariant} is unavailable for ${target}; used ${chosenVariant}.`,
      },
    ],
    fallback: {
      fromVariant: policy.attemptedFigureVariant,
      diagnosticCode: 'variant-unavailable',
      reason: `${policy.attemptedFigureVariant} is unavailable for ${target}; the declared compact in-flow variant is used.`,
    },
  }
}
