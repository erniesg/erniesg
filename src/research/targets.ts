export const TARGET_PROFILE_IDS = [
  'mobile',
  'paperProMove',
  'paperPro',
  'print',
] as const

export const TARGET_PROFILE_VERSION = '1.0.0' as const

export type TargetProfileId = (typeof TARGET_PROFILE_IDS)[number]
export type TargetLengthUnit = 'css-px' | 'device-px' | 'mm'

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
  epub: {
    fileName: string
    pageProgressionDirection: 'ltr' | 'rtl'
    renditionFlow: 'paginated' | 'scrolled-continuous'
  }
  preview: {
    widthCssPx: number
    heightCssPx: number | null
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
    preview: { widthCssPx: 390, heightCssPx: null },
  },
  paperProMove: {
    id: 'paperProMove',
    version: TARGET_PROFILE_VERSION,
    label: 'Pro Move',
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
    epub: {
      fileName: 'publication-papermove.epub',
      pageProgressionDirection: 'ltr',
      renditionFlow: 'paginated',
    },
    preview: { widthCssPx: 318, heightCssPx: 565 },
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
    epub: {
      fileName: 'publication-paperpro.epub',
      pageProgressionDirection: 'ltr',
      renditionFlow: 'paginated',
    },
    preview: { widthCssPx: 540, heightCssPx: 720 },
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
