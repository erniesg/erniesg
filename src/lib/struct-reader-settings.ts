import type { StructPreviewDevice } from './struct-demo-preview'

// Logical preview pixels, not panel resolution. E-ink presets use a 2x
// panel-to-layout scale; the preview is an approximation of a reading surface.
export const STRUCT_DEVICE_MODELS: Array<{
  id: string
  label: string
  device: StructPreviewDevice
  width: number
  height: number
}> = [
  {
    id: 'phone',
    label: 'Phone · 390 × 844',
    device: 'phone',
    width: 390,
    height: 844,
  },
  {
    id: 'iphone-se',
    label: 'iPhone SE · 375 × 667',
    device: 'phone',
    width: 375,
    height: 667,
  },
  {
    id: 'iphone-pro-max',
    label: 'iPhone 14 Pro Max · 430 × 932',
    device: 'phone',
    width: 430,
    height: 932,
  },
  {
    id: 'tablet',
    label: 'Tablet · 768 × 1024',
    device: 'tablet',
    width: 768,
    height: 1024,
  },
  {
    id: 'ipad-air',
    label: 'iPad Air 11″ · 820 × 1180',
    device: 'tablet',
    width: 820,
    height: 1180,
  },
  {
    id: 'ipad-pro',
    label: 'iPad Pro 12.9″ · 1024 × 1366',
    device: 'tablet',
    width: 1024,
    height: 1366,
  },
  {
    id: 'desktop',
    label: 'Desktop · 1280 × 800',
    device: 'desktop',
    width: 1280,
    height: 800,
  },
  {
    id: 'laptop',
    label: 'Laptop · 1440 × 900',
    device: 'desktop',
    width: 1440,
    height: 900,
  },
  {
    id: 'full-hd',
    label: 'Full HD · 1920 × 1080',
    device: 'desktop',
    width: 1920,
    height: 1080,
  },
  {
    id: 'eink',
    label: 'E-ink · 600 × 800',
    device: 'eink',
    width: 600,
    height: 800,
  },
  {
    id: 'remarkable-pro',
    label: 'reMarkable Paper Pro · 810 × 1080',
    device: 'eink',
    width: 810,
    height: 1080,
  },
  {
    id: 'remarkable-move',
    label: 'reMarkable Paper Pro Move · 477 × 848',
    device: 'eink',
    width: 477,
    height: 848,
  },
]
export const STRUCT_READER_FONTS = {
  serif: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" },
  sans: { label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  system: { label: 'System', css: 'system-ui, sans-serif' },
  times: { label: 'Times New Roman', css: "'Times New Roman', Times, serif" },
} as const
export type ReaderSettings = {
  fontSize: number
  fontFamily: keyof typeof STRUCT_READER_FONTS
  margin: number
}
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 16,
  fontFamily: 'serif',
  margin: 16,
}
const bound = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback
export function previewDimension(value: string, fallback: number) {
  return value.trim() ? bound(Number(value), 240, 2560, fallback) : fallback
}
export function readerCss(settings: ReaderSettings) {
  const font =
    STRUCT_READER_FONTS[settings.fontFamily] ?? STRUCT_READER_FONTS.serif
  const size = bound(settings.fontSize, 12, 32, 16)
  const margin = bound(settings.margin, 0, 80, 16)
  return `html{font-size:${size}px!important}body{font-size:1rem!important;font-family:${font.css}!important;margin:0!important;padding:${margin}px!important;max-width:none!important;box-sizing:border-box!important}`
}
/** Keep the opaque-origin sandbox; never enable iframe scripts to style it. */
export function readerDocument(
  html: string,
  settings: ReaderSettings,
  source?: string,
) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (source) {
    doc.querySelectorAll('base').forEach((base) => base.remove())
    const base = doc.createElement('base')
    base.href = source
    doc.head.prepend(base)
  }
  const style = doc.createElement('style')
  style.textContent = readerCss(settings)
  doc.head.append(style)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}
