/**
 * The files an export package holds, and so the files every paper serves
 * under `/papers/<id>/exports/`. Kept apart from `export-package.ts`, with no
 * imports, so the route manifest can read it without loading the exporter.
 */
export const PAYLOAD_PATHS = [
  'source.json',
  'layout-manifest.json',
  'annotations.json',
  'reflowable.html',
  'publication.epub',
  'publication-paperpro.epub',
  'publication-papermove.epub',
  'print.pdf',
] as const

export const EXPORT_PACKAGE_PATHS = [
  ...PAYLOAD_PATHS,
  'export-manifest.json',
  'checksums.sha256',
] as const

export type ExportPackagePath = (typeof EXPORT_PACKAGE_PATHS)[number]
