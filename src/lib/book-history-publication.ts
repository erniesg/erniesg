/** Pure sidecar construction. Caller data/fingerprints are not authorization;
 * books.ts owns the pre-execution and final source/dependency witness. */
import { createHash } from 'node:crypto'
import { serializeBookHistory } from './book-history'
import type { RenderedBookHistories } from './book-history-rendered'
import { parseMarginHistoryAsset } from './margin-history-data'
import { safeHistoryHtml, validateHistoryCss, SAFE_HISTORY_PROFILE } from './book-history-safe-html'

export const HISTORY_PUBLICATION_LIMITS = Object.freeze({ versionBytes: 32 * 1024 * 1024, indexBytes: 8 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 })
export type RenderedHistoryAsset = { book: string; node: string; asset: string; pathname: string; json: string }
export const publicationSha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
function fail(): never { throw new Error('rendered history publication binding/shape/bound differs') }
function shape(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) fail()
}
function serialized(value: unknown, limit: number): string {
  const json = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(json) > limit) fail()
  return json
}
export function publishRenderedHistory(bundle: RenderedBookHistories, css: { content: string; scoped: string }, fingerprint: string): RenderedHistoryAsset[] {
  shape(bundle, ['schemaVersion', 'site', 'buildCommit', 'rendererProfile', 'rendererFingerprint', 'rawAssets', 'documents'])
  shape(css, ['content', 'scoped'])
  if (bundle.schemaVersion !== 1 || !oid(bundle.buildCommit) || bundle.rendererProfile !== 'node-content-readonly-v1' || !hash(bundle.rendererFingerprint) || !hash(fingerprint) || !Array.isArray(bundle.rawAssets) || !Array.isArray(bundle.documents) || bundle.rawAssets.length !== bundle.documents.length) fail()
  const site = new URL(bundle.site)
  if (!['https:', 'http:'].includes(site.protocol) || site.origin !== bundle.site || site.username || site.password) fail()
  validateHistoryCss(css.content); validateHistoryCss(css.scoped)
  const output: RenderedHistoryAsset[] = [], seen = new Set<string>(); let total = 0
  for (let i = 0; i < bundle.rawAssets.length; i++) {
    const rawBytes = serializeBookHistory(bundle.rawAssets[i])
    const raw = parseMarginHistoryAsset(Buffer.from(rawBytes), bundle.site, bundle.rawAssets[i].document)
    const documentPath = `/books/${raw.book}/${raw.node}/`, document = new URL(documentPath, site).href
    const doc = bundle.documents[i]
    shape(doc, ['document', 'rawHistorySha256', 'versions'])
    if (raw.document !== document || raw.buildCommit !== bundle.buildCommit || seen.has(document) || doc.document !== document || doc.rawHistorySha256 !== publicationSha(rawBytes) || !Array.isArray(doc.versions) || doc.versions.length !== raw.versions.length) fail()
    seen.add(document)
    const common = { schemaVersion: 1, profile: SAFE_HISTORY_PROFILE, site: bundle.site, document, book: raw.book, node: raw.node, buildCommit: bundle.buildCommit, rendererProfile: bundle.rendererProfile, rendererFingerprint: bundle.rendererFingerprint, publicationFingerprint: fingerprint, rawHistorySha256: doc.rawHistorySha256, contentCssSha256: publicationSha(css.content), scopedCssSha256: publicationSha(css.scoped) }
    const versions: Record<string, unknown>[] = []
    for (let j = 0; j < raw.versions.length; j++) {
      const original = raw.versions[j], version = doc.versions[j]
      if (version.commit !== original.commit || version.sourcePath !== original.path || version.deleted !== original.deleted) fail()
      if (version.deleted) {
        shape(version, ['commit', 'sourcePath', 'deleted', 'render'])
        if (version.render !== null) fail()
        versions.push({ commit: version.commit, deleted: true }); continue
      }
      shape(version, ['commit', 'deleted', 'treeOID', 'sourcePath', 'sourceOID', 'sourceSha256', 'dependencies', 'optionalAbsences', 'render', 'renderSha256'])
      const render = version.render
      shape(render, ['schemaVersion', 'profile', 'sourcePath', 'sourceSha256', 'html', 'blocks', 'reads', 'optionalAbsences'])
      if (!oid(version.treeOID) || !oid(version.sourceOID) || version.treeOID.length !== bundle.buildCommit.length || version.sourceOID.length !== bundle.buildCommit.length || version.sourceSha256 !== publicationSha(original.content!) || !hash(version.renderSha256) || render.schemaVersion !== 1 || render.profile !== bundle.rendererProfile || render.sourcePath !== version.sourcePath || render.sourceSha256 !== version.sourceSha256 || !Array.isArray(render.blocks)) fail()
      const safe = safeHistoryHtml(render.html, `h-${publicationSha(document + '\0' + version.commit).slice(0, 48)}`)
      if (JSON.stringify(safe.blocks.map(({ kind, id, digest }) => ({ kind, id, digest }))) !== JSON.stringify(render.blocks)) fail()
      const value = { kind: 'rendered-history-version', ...common, commit: version.commit, sourcePath: version.sourcePath, sourceOID: version.sourceOID, sourceSha256: version.sourceSha256, treeOID: version.treeOID, renderSha256: version.renderSha256, safeHtml: safe.html, safeHtmlSha256: publicationSha(safe.html), blocks: safe.blocks }
      const json = serialized(value, HISTORY_PUBLICATION_LIMITS.versionBytes), pathname = `${documentPath}history-rendered/${version.commit}.json`
      total += Buffer.byteLength(json)
      if (total > HISTORY_PUBLICATION_LIMITS.totalBytes) fail()
      versions.push({ commit: version.commit, deleted: false, pathname, sha256: publicationSha(json), bytes: Buffer.byteLength(json) })
      output.push({ book: raw.book, node: raw.node, asset: version.commit, pathname, json })
    }
    const json = serialized({ kind: 'rendered-history-index', ...common, scopedCss: css.scoped, versions }, HISTORY_PUBLICATION_LIMITS.indexBytes)
    total += Buffer.byteLength(json)
    if (total > HISTORY_PUBLICATION_LIMITS.totalBytes) fail()
    output.push({ book: raw.book, node: raw.node, asset: 'index', pathname: `${documentPath}history-rendered/index.json`, json })
  }
  return output
}
