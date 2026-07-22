export const TARGET_PROFILE_IDS = [
  'mobile',
  'paperProMove',
  'paperPro',
  'print',
] as const

export const TARGET_PROFILE_VERSION = '1.1.0' as const

export type TargetProfileId = (typeof TARGET_PROFILE_IDS)[number]
export type TargetLengthUnit = 'css-px' | 'device-px' | 'mm'
export type TargetTruthAuthority =
  | 'authoritative'
  | 'advisory'
  | 'reader-controlled'

export type TargetProfile = {
  id: TargetProfileId
  version: typeof TARGET_PROFILE_VERSION
  label: string
  note: string
  dimensions: {
    width: number
    height: number | null
    unit: TargetLengthUnit
  }
  margins: {
    top: number
    right: number
    bottom: number
    left: number
    unit: TargetLengthUnit
  }
  typography: {
    fontFamily: string
    bodySizeCssPx: number
    lineHeight: number
    titleSizeCssPx: number
    headingSizeCssPx: number
    quoteSizeCssPx: number
  }
  columns: {
    count: number
    gapCssPx: number
  }
  interactionMode: 'continuous-scroll' | 'page-turn' | 'print-static'
  finiteHeight: boolean
  pixelsPerInch: number | null
  manufacturerDisplay?: {
    diagonalInches: number
    listedPixels: { width: number; height: number }
    logicalOrientation: 'portrait'
  }
  epub: {
    fileName: string
    pageProgressionDirection: 'ltr' | 'rtl'
    renditionFlow: 'paginated' | 'scrolled-continuous'
  }
  truth: {
    geometry: TargetTruthAuthority
    typography: TargetTruthAuthority
    pagination: TargetTruthAuthority
    orientation: TargetTruthAuthority
  }
  preview: {
    widthCssPx: number
    heightCssPx: number | null
    continuousWindowHeightCssPx?: number
  }
}

// Keep the two e-ink frames at one relative physical scale. The scale is
// anchored so Paper Pro remains 540 CSS px wide; Move is derived from its
// native pixels-per-inch instead of using the unrelated one-third-pixel scale.
const EINK_PREVIEW_CSS_PIXELS_PER_INCH = 540 / (1620 / 229)

function eInkPreview(width: number, height: number, pixelsPerInch: number) {
  return {
    widthCssPx: Math.round(
      (width / pixelsPerInch) * EINK_PREVIEW_CSS_PIXELS_PER_INCH,
    ),
    heightCssPx: Math.round(
      (height / pixelsPerInch) * EINK_PREVIEW_CSS_PIXELS_PER_INCH,
    ),
  }
}

export const TARGET_PROFILES: Record<TargetProfileId, TargetProfile> = {
  mobile: {
    id: 'mobile',
    version: TARGET_PROFILE_VERSION,
    label: 'Mobile',
    note: 'Continuous · 390 CSS px',
    dimensions: { width: 390, height: null, unit: 'css-px' },
    margins: {
      top: 35,
      right: 31,
      bottom: 35,
      left: 31,
      unit: 'css-px',
    },
    typography: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      bodySizeCssPx: 15,
      lineHeight: 1.65,
      titleSizeCssPx: 36,
      headingSizeCssPx: 20,
      quoteSizeCssPx: 20,
    },
    columns: { count: 1, gapCssPx: 0 },
    interactionMode: 'continuous-scroll',
    finiteHeight: false,
    pixelsPerInch: null,
    epub: {
      fileName: 'publication-mobile.epub',
      pageProgressionDirection: 'ltr',
      renditionFlow: 'scrolled-continuous',
    },
    truth: {
      geometry: 'authoritative',
      typography: 'advisory',
      pagination: 'reader-controlled',
      orientation: 'reader-controlled',
    },
    preview: {
      widthCssPx: 390,
      heightCssPx: null,
      continuousWindowHeightCssPx: 844,
    },
  },
  paperProMove: {
    id: 'paperProMove',
    version: TARGET_PROFILE_VERSION,
    label: 'Paper Pro Move',
    note: '7.3″ · 954 × 1696 · 264 PPI',
    dimensions: { width: 954, height: 1696, unit: 'device-px' },
    margins: {
      top: 108,
      right: 84,
      bottom: 108,
      left: 84,
      unit: 'device-px',
    },
    typography: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      bodySizeCssPx: 14,
      lineHeight: 1.65,
      titleSizeCssPx: 30,
      headingSizeCssPx: 20,
      quoteSizeCssPx: 14,
    },
    columns: { count: 1, gapCssPx: 0 },
    interactionMode: 'page-turn',
    finiteHeight: true,
    pixelsPerInch: 264,
    manufacturerDisplay: {
      diagonalInches: 7.3,
      listedPixels: { width: 1696, height: 954 },
      logicalOrientation: 'portrait',
    },
    epub: {
      fileName: 'publication-papermove.epub',
      pageProgressionDirection: 'ltr',
      renditionFlow: 'paginated',
    },
    truth: {
      geometry: 'authoritative',
      typography: 'advisory',
      pagination: 'reader-controlled',
      orientation: 'reader-controlled',
    },
    preview: eInkPreview(954, 1696, 264),
  },
  paperPro: {
    id: 'paperPro',
    version: TARGET_PROFILE_VERSION,
    label: 'Paper Pro',
    note: '11.8″ · 1620 × 2160 · 229 PPI',
    dimensions: { width: 1620, height: 2160, unit: 'device-px' },
    margins: {
      top: 145,
      right: 130,
      bottom: 145,
      left: 130,
      unit: 'device-px',
    },
    typography: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      bodySizeCssPx: 15,
      lineHeight: 1.65,
      titleSizeCssPx: 36,
      headingSizeCssPx: 20,
      quoteSizeCssPx: 20,
    },
    columns: { count: 1, gapCssPx: 0 },
    interactionMode: 'page-turn',
    finiteHeight: true,
    pixelsPerInch: 229,
    manufacturerDisplay: {
      diagonalInches: 11.8,
      listedPixels: { width: 2160, height: 1620 },
      logicalOrientation: 'portrait',
    },
    epub: {
      fileName: 'publication-paperpro.epub',
      pageProgressionDirection: 'ltr',
      renditionFlow: 'paginated',
    },
    truth: {
      geometry: 'authoritative',
      typography: 'advisory',
      pagination: 'reader-controlled',
      orientation: 'reader-controlled',
    },
    preview: eInkPreview(1620, 2160, 229),
  },
  print: {
    id: 'print',
    version: TARGET_PROFILE_VERSION,
    label: 'A4',
    note: '210 × 297 mm · paged',
    dimensions: { width: 210, height: 297, unit: 'mm' },
    margins: {
      top: 19,
      right: 17,
      bottom: 19,
      left: 17,
      unit: 'mm',
    },
    typography: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      bodySizeCssPx: 15,
      lineHeight: 1.65,
      titleSizeCssPx: 36,
      headingSizeCssPx: 20,
      quoteSizeCssPx: 20,
    },
    columns: { count: 2, gapCssPx: 48 },
    interactionMode: 'print-static',
    finiteHeight: true,
    pixelsPerInch: null,
    epub: {
      fileName: 'publication-print.epub',
      pageProgressionDirection: 'ltr',
      renditionFlow: 'paginated',
    },
    truth: {
      geometry: 'authoritative',
      typography: 'advisory',
      pagination: 'reader-controlled',
      orientation: 'reader-controlled',
    },
    preview: { widthCssPx: 794, heightCssPx: 1123 },
  },
}

export function getTargetProfile(id: TargetProfileId) {
  return TARGET_PROFILES[id]
}

export function getPreviewMetrics(profile: TargetProfile) {
  const scale = profile.preview.widthCssPx / profile.dimensions.width

  return {
    widthCssPx: profile.preview.widthCssPx,
    minHeightCssPx: profile.preview.heightCssPx ?? undefined,
    marginTopCssPx: profile.margins.top * scale,
    marginRightCssPx: profile.margins.right * scale,
    marginBottomCssPx: profile.margins.bottom * scale,
    marginLeftCssPx: profile.margins.left * scale,
  }
}
