/** Public same-origin history reader. Build fingerprints are consistency data;
 * the trusted static deployment, not this client, supplies publication authority. */
import {
  parseMarginHistoryAsset,
  type MarginHistoryAsset,
} from './margin-history-data'
import {
  readPublishedHistoryHtml,
  validateHistoryCss,
  SAFE_HISTORY_PROFILE,
  type SafeHistoryBlock,
} from './book-history-safe-html'
import { diffHistoryHtml } from './book-history-diff'

export type HistoryPage = {
  site: string
  document: string
  book: string
  node: string
  sourcePath: string
  buildCommit: string
}
type Common = Omit<HistoryPage, 'sourcePath'> & {
  schemaVersion: 1
  profile: string
  rendererProfile: string
  rendererFingerprint: string
  publicationFingerprint: string
  rawHistorySha256: string
  contentCssSha256: string
  scopedCssSha256: string
}
type Row =
  | { commit: string; deleted: true }
  | {
      commit: string
      deleted: false
      pathname: string
      sha256: string
      bytes: number
    }
type Index = Common & { kind: string; scopedCss: string; versions: Row[] }
export type HistoryMetadata = { raw: MarginHistoryAsset; index: Index }
export type HistoryVersion = Common & {
  kind: string
  commit: string
  sourcePath: string
  sourceOID: string
  sourceSha256: string
  treeOID: string
  renderSha256: string
  safeHtml: string
  safeHtmlSha256: string
  blocks: SafeHistoryBlock[]
}
const encoder = new TextEncoder(),
  MiB = 1024 * 1024
const commonKeys = [
  'schemaVersion',
  'profile',
  'site',
  'document',
  'book',
  'node',
  'buildCommit',
  'rendererProfile',
  'rendererFingerprint',
  'publicationFingerprint',
  'rawHistorySha256',
  'contentCssSha256',
  'scopedCssSha256',
]
const hashes = [
  'rendererFingerprint',
  'publicationFingerprint',
  'rawHistorySha256',
  'contentCssSha256',
  'scopedCssSha256',
]
const shaShape = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const oidShape = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)
function fail(): never {
  throw Error('History data is unavailable or differs from this page build.')
}
function shape(
  v: unknown,
  keys: readonly string[],
): asserts v is Record<string, any> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k))
  )
    fail()
}
function text(v: unknown, max: number): v is string {
  return (
    typeof v === 'string' &&
    v.length <= max &&
    !/[\uD800-\uDFFF]/u.test(v) &&
    encoder.encode(v).length <= max
  )
}
function path(v: unknown): v is string {
  return (
    text(v, 4096) &&
    !!v &&
    !/[\\\x00-\x1f\x7f]/.test(v) &&
    v.split('/').every((x) => !!x && x !== '.' && x !== '..')
  )
}
function pageShape(page: HistoryPage) {
  shape(page, ['site', 'document', 'book', 'node', 'sourcePath', 'buildCommit'])
  if (
    !text(page.site, 2048) ||
    !text(page.document, 2048) ||
    ![page.book, page.node].every(
      (x) =>
        typeof x === 'string' &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x) &&
        x.length <= 128,
    ) ||
    !oidShape(page.buildCommit) ||
    !path(page.sourcePath)
  )
    fail()
  const site = new URL(page.site)
  if (
    !['http:', 'https:'].includes(site.protocol) ||
    site.origin !== page.site ||
    page.document !== page.site + `/books/${page.book}/${page.node}/`
  )
    fail()
}
export async function historyDigest(
  value: string | Uint8Array,
): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}
function decode(bytes: Uint8Array, limit: number): { raw: string; value: any } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) fail()
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes,
  )
  return { raw, value: JSON.parse(raw) }
}
function canonical(raw: string, value: unknown) {
  if (JSON.stringify(value) + '\n' !== raw) fail()
}
function common(value: Record<string, any>, page: HistoryPage) {
  if (
    value.schemaVersion !== 1 ||
    value.profile !== SAFE_HISTORY_PROFILE ||
    value.rendererProfile !== 'node-content-readonly-v1' ||
    !hashes.every((k) => shaShape(value[k]))
  )
    fail()
  for (const k of ['site', 'document', 'book', 'node', 'buildCommit'] as const)
    if (value[k] !== page[k]) fail()
}
export async function decodeHistoryMetadata(
  rawBytes: Uint8Array,
  indexBytes: Uint8Array,
  page: HistoryPage,
): Promise<HistoryMetadata> {
  pageShape(page)
  const raw = parseMarginHistoryAsset(rawBytes, page.site, page.document)
  if (
    raw.book !== page.book ||
    raw.node !== page.node ||
    raw.buildCommit !== page.buildCommit ||
    raw.sourcePath !== page.sourcePath
  )
    fail()
  const decoded = decode(indexBytes, 8 * MiB),
    value = decoded.value
  shape(value, ['kind', ...commonKeys, 'scopedCss', 'versions'])
  common(value, page)
  if (
    value.kind !== 'rendered-history-index' ||
    !text(value.scopedCss, 65536) ||
    !Array.isArray(value.versions) ||
    value.versions.length !== raw.versions.length
  )
    fail()
  validateHistoryCss(value.scopedCss)
  for (let i = 0; i < raw.versions.length; i++) {
    const row = value.versions[i],
      original = raw.versions[i]
    shape(
      row,
      original.deleted
        ? ['commit', 'deleted']
        : ['commit', 'deleted', 'pathname', 'sha256', 'bytes'],
    )
    if (
      row.commit !== original.commit ||
      row.deleted !== original.deleted ||
      row.commit.length !== page.buildCommit.length
    )
      fail()
    if (
      !row.deleted &&
      (row.pathname !==
        `/books/${page.book}/${page.node}/history-rendered/${original.commit}.json` ||
        !shaShape(row.sha256) ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes <= 0 ||
        row.bytes > 32 * MiB)
    )
      fail()
  }
  canonical(decoded.raw, value)
  if (
    value.rawHistorySha256 !== (await historyDigest(rawBytes)) ||
    value.scopedCssSha256 !== (await historyDigest(value.scopedCss))
  )
    fail()
  return { raw, index: value as Index }
}
export async function decodeHistoryVersion(
  bytes: Uint8Array,
  commit: string,
  metadata: HistoryMetadata,
  page: HistoryPage,
): Promise<HistoryVersion> {
  const at = metadata.index.versions.findIndex((x) => x.commit === commit),
    row = metadata.index.versions[at],
    original = metadata.raw.versions[at]
  if (
    !row ||
    row.deleted ||
    original.deleted ||
    bytes.length !== row.bytes ||
    (await historyDigest(bytes)) !== row.sha256
  )
    fail()
  const decoded = decode(bytes, 32 * MiB),
    value = decoded.value
  shape(value, [
    'kind',
    ...commonKeys,
    'commit',
    'sourcePath',
    'sourceOID',
    'sourceSha256',
    'treeOID',
    'renderSha256',
    'safeHtml',
    'safeHtmlSha256',
    'blocks',
  ])
  common(value, page)
  for (const key of commonKeys)
    if (value[key] !== (metadata.index as any)[key]) fail()
  if (
    value.kind !== 'rendered-history-version' ||
    value.commit !== commit ||
    value.sourcePath !== original.path ||
    ![value.sourceOID, value.treeOID].every(
      (x) => oidShape(x) && x.length === page.buildCommit.length,
    ) ||
    ![value.sourceSha256, value.renderSha256, value.safeHtmlSha256].every(
      shaShape,
    ) ||
    !text(value.safeHtml, 4 * MiB) ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > 100000
  )
    fail()
  for (const block of value.blocks) {
    shape(block, ['kind', 'id', 'digest', 'domId'])
    if (
      !text(block.kind, 64) ||
      !/^[a-z-]{1,64}$/.test(block.kind) ||
      !text(block.id, 256) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(block.id) ||
      !text(block.domId, 256) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(block.domId) ||
      typeof block.digest !== 'string' ||
      !/^[a-f0-9]{12}$/.test(block.digest)
    )
      fail()
  }
  canonical(decoded.raw, value)
  if (
    value.sourceSha256 !== (await historyDigest(original.content!)) ||
    value.safeHtmlSha256 !== (await historyDigest(value.safeHtml))
  )
    fail()
  const checked = readPublishedHistoryHtml(value.safeHtml, 'history-check')
  if (
    checked.blocks.length !== value.blocks.length ||
    checked.blocks.some(
      (b, i) =>
        b.id !== value.blocks[i].domId ||
        b.kind !== value.blocks[i].kind ||
        b.digest !== value.blocks[i].digest,
    )
  )
    fail()
  return value as HistoryVersion
}

/** Occupancy belongs to this panel, not a generation. Logical abort/timeout
 * rejects the caller immediately but retains a slot until the owned pipeline
 * actually settles, including late-body cancellation. */
export class HistoryRequests {
  #outstanding = 0
  constructor(
    private origin: string,
    private fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
      fail()
  }
  get outstanding() {
    return this.#outstanding
  }
  read(
    pathname: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !/^\/books\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:history\.json|history-rendered\/(?:index|[a-f0-9]{40}|[a-f0-9]{64})\.json)$/.test(
        pathname,
      ) ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > 32 * MiB
    )
      return Promise.reject(Error('Invalid history request.'))
    if (signal.aborted)
      return Promise.reject(Error('History request cancelled.'))
    if (this.#outstanding >= 2)
      return Promise.reject(
        Error(
          'History is busy completing earlier requests. Retry after they settle.',
        ),
      )
    this.#outstanding++
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      let cancelled = false,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        cancellation: Promise<void> | undefined
      const cancelReader = () =>
        (cancellation ??= reader
          ? reader.cancel().catch(() => {})
          : Promise.resolve())
      const abort = (message = 'History request cancelled.') => {
        cancelled = true
        controller.abort()
        if (reader) void cancelReader()
        reject(Error(message))
      }
      const listener = () => abort(),
        timer = setTimeout(() => abort('History request timed out.'), 20000)
      signal.addEventListener('abort', listener, { once: true })
      const owned = async () => {
        const expected = this.origin + pathname
        // Native Window.fetch must not receive this HistoryRequests instance.
        const fetcher = this.fetcher
        const response = await fetcher(expected, {
          method: 'GET',
          credentials: 'omit',
          mode: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (cancelled) {
          await response.body?.cancel()
          throw Error('History request cancelled.')
        }
        if (
          response.status !== 200 ||
          response.redirected ||
          response.url !== expected ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            response.headers.get('Content-Type') ?? '',
          )
        ) {
          await response.body?.cancel()
          fail()
        }
        const length = response.headers.get('Content-Length')
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > limit)
        ) {
          await response.body?.cancel()
          fail()
        }
        if (!response.body) fail()
        reader = response.body.getReader()
        // A fixed byte ceiling also bounds memory for adversarially tiny or
        // empty chunks; retaining an array per chunk would not.
        const output = new Uint8Array(limit),
          started = performance.now()
        let total = 0
        try {
          while (true) {
            const item = await reader.read()
            if (performance.now() - started >= 20000)
              abort('History request timed out.')
            if (cancelled) {
              await cancelReader()
              throw Error('History request cancelled.')
            }
            if (item.done) break
            if (
              !(item.value instanceof Uint8Array) ||
              total + item.value.length > limit
            ) {
              await cancelReader()
              fail()
            }
            output.set(item.value, total)
            total += item.value.length
          }
          return output.slice(0, total)
        } finally {
          if (cancellation) await cancellation
          reader.releaseLock()
        }
      }
      void owned()
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer)
          signal.removeEventListener('abort', listener)
          this.#outstanding--
        })
    })
  }
}

export const HISTORY_DIFF_CSS = `.history-content{font-family:system-ui,sans-serif;padding:1rem;overflow-wrap:anywhere;color:#202020;background:#fff}.history-content strong{font-weight:700}.history-content em{font-style:italic}.history-content p{margin:1em 0}.history-content ul{list-style:disc;padding-left:1.5em}.history-content ol{list-style:decimal;padding-left:1.5em}.history-content svg{max-width:100%}.history-diff-add{background:#dcfce7;color:#14532d;text-decoration:underline}.history-diff-remove{background:#fee2e2;color:#7f1d1d;text-decoration:line-through}.history-diff-block{margin:1rem 0;padding:.75rem;border:2px solid}.history-diff-before{border-color:#991b1b}.history-diff-after{border-color:#166534}.history-diff-format{font-weight:700}`
async function styleHash(css: string) {
  const raw = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(css)),
  )
  return 'sha256-' + btoa(String.fromCharCode(...raw))
}
async function historyFrameDocument(
  html: string,
  css: string,
): Promise<string> {
  validateHistoryCss(css)
  const styles = await Promise.all([
    styleHash(css),
    styleHash(HISTORY_DIFF_CSS),
  ])
  const csp = `default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; style-src '${styles[0]}' '${styles[1]}'`
  // html is exclusively a diffHistoryHtml result; input assets never bypass
  // that shared validation path. Generated wrappers have no active attrs.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}</style><style>${HISTORY_DIFF_CSS}</style></head><body><div class="history-content">${html}</div></body></html>`
}

// Astro can dispose and remount a persisted element. Its outstanding work
// still belongs to that panel; remounting must not mint another two slots.
const panelRequests = new WeakMap<
  HTMLElement,
  { origin: string; pool: HistoryRequests }
>()

export function mountBookHistory(
  panel: HTMLElement,
  page: HistoryPage,
  origin = location.origin,
) {
  const prior = panelRequests.get(panel)
  if (prior && prior.origin !== origin) fail()
  const pool = prior?.pool ?? new HistoryRequests(origin)
  panelRequests.set(panel, { origin, pool })
  const get = <T extends Element>(selector: string) => {
    const el = panel.querySelector<T>(selector)
    if (!el) throw Error('History panel markup differs.')
    return el
  }
  const toggle = get<HTMLButtonElement>('[data-history-toggle]'),
    body = get<HTMLElement>('[data-history-body]'),
    status = get<HTMLElement>('[data-history-status]'),
    retry = get<HTMLButtonElement>('[data-history-retry]'),
    controls = get<HTMLElement>('[data-history-controls]'),
    list = get<HTMLOListElement>('[data-history-list]'),
    more = get<HTMLButtonElement>('[data-history-more]'),
    before = get<HTMLSelectElement>('[data-history-before]'),
    after = get<HTMLSelectElement>('[data-history-after]'),
    frameBefore = get<HTMLIFrameElement>('[data-history-frame-before]'),
    frameAfter = get<HTMLIFrameElement>('[data-history-frame-after]')
  let generation = 0,
    disposed = false,
    opened = false,
    controller = new AbortController(),
    metadata: HistoryMetadata | undefined,
    shown = 0
  const current = (n: number) => !disposed && opened && n === generation
  const check = (n: number, started: number) => {
    if (!current(n)) return false
    if (performance.now() - started > 20000)
      throw Error('History comparison timed out.')
    return true
  }
  const reset = () => {
    generation++
    controller.abort()
    controller = new AbortController()
    frameBefore.removeAttribute('srcdoc')
    frameAfter.removeAttribute('srcdoc')
    frameBefore.hidden = frameAfter.hidden = true
    retry.hidden = true
    return generation
  }
  const unavailable = (n: number, error: unknown) => {
    if (current(n)) {
      status.textContent =
        error instanceof Error && /busy|timed out/.test(error.message)
          ? error.message
          : 'History unavailable. The data may differ from this page build.'
      retry.hidden = false
    }
  }
  const showRows = () => {
    if (!metadata) return
    const end = Math.min(shown + 100, metadata.raw.versions.length)
    for (; shown < end; shown++) {
      const v = metadata.raw.versions[shown],
        li = document.createElement('li')
      li.textContent = `${v.commit.slice(0, 12)} · ${v.author} · ${v.date} · ${v.message}${v.deleted ? ' — Deleted in this commit' : ''}`
      list.append(li)
    }
    more.hidden = shown >= metadata.raw.versions.length
  }
  const pair = async () => {
    const n = reset(),
      data = metadata,
      started = performance.now()
    if (!data) return
    status.textContent = 'Loading selected versions…'
    try {
      const commits = [...new Set([before.value, after.value])]
      const versions = await Promise.all(
        commits.map(async (commit) => {
          const row = data.index.versions.find((v) => v.commit === commit)
          if (!row || row.deleted) fail()
          const bytes = await pool.read(
            row.pathname,
            row.bytes,
            controller.signal,
          )
          if (!check(n, started)) throw Error('stale generation')
          const version = await decodeHistoryVersion(bytes, commit, data, page)
          if (!check(n, started)) throw Error('stale generation')
          return version
        }),
      )
      if (!check(n, started)) return
      const left = versions.find((v) => v.commit === before.value)!,
        right = versions.find((v) => v.commit === after.value)!
      status.textContent = 'Comparing selected versions…'
      const result = diffHistoryHtml(left.safeHtml, right.safeHtml)
      if (!check(n, started)) return
      const documents = await Promise.all([
        historyFrameDocument(result.before, data.index.scopedCss),
        historyFrameDocument(result.after, data.index.scopedCss),
      ])
      if (!check(n, started)) return
      frameBefore.srcdoc = documents[0]
      frameAfter.srcdoc = documents[1]
      frameBefore.hidden = frameAfter.hidden = false
      status.textContent =
        (data.index.versions.filter((v) => !v.deleted).length === 1
          ? 'Only one live version is available. '
          : '') + result.notice
    } catch (error) {
      unavailable(n, error)
    }
  }
  const load = async () => {
    const n = reset(),
      started = performance.now()
    metadata = undefined
    controls.hidden = true
    list.replaceChildren()
    more.hidden = true
    shown = 0
    status.textContent = 'Loading public history…'
    try {
      pageShape(page)
      const base = `/books/${page.book}/${page.node}/`
      const [raw, index] = await Promise.all([
        pool.read(base + 'history.json', 8 * MiB, controller.signal),
        pool.read(
          base + 'history-rendered/index.json',
          8 * MiB,
          controller.signal,
        ),
      ])
      if (!check(n, started)) return
      const data = await decodeHistoryMetadata(raw, index, page)
      if (!check(n, started)) return
      metadata = data
      before.replaceChildren()
      after.replaceChildren()
      showRows()
      const live = data.raw.versions.filter((v) => !v.deleted)
      for (const v of live)
        for (const select of [before, after]) {
          const option = document.createElement('option')
          option.value = v.commit
          option.textContent = `${v.commit.slice(0, 12)} · ${v.date} · ${v.message.slice(0, 120)}`
          select.append(option)
        }
      if (!live.length) {
        status.textContent = data.raw.versions.length
          ? 'No live versions are available for comparison.'
          : 'No versions are recorded.'
        return
      }
      controls.hidden = false
      after.value = live[0].commit
      before.value = live[1]?.commit ?? live[0].commit
      await pair()
    } catch (error) {
      unavailable(n, error)
    }
  }
  const onToggle = () => {
    opened = !opened
    toggle.setAttribute('aria-expanded', String(opened))
    body.hidden = !opened
    if (opened) void load()
    else reset()
  }
  const onRetry = () => {
      if (opened) void load()
    },
    onPair = () => {
      if (opened) void pair()
    },
    onMore = () => showRows()
  toggle.addEventListener('click', onToggle)
  retry.addEventListener('click', onRetry)
  before.addEventListener('change', onPair)
  after.addEventListener('change', onPair)
  more.addEventListener('click', onMore)
  return () => {
    disposed = true
    reset()
    toggle.removeEventListener('click', onToggle)
    retry.removeEventListener('click', onRetry)
    before.removeEventListener('change', onPair)
    after.removeEventListener('change', onPair)
    more.removeEventListener('click', onMore)
  }
}
