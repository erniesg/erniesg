import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as RuntimeResponse,
} from 'miniflare'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SITE = 'https://ernie.sg'
const CONVERTER = 'https://converter.example'
const SAMPLE = 'https://arxiv.org/pdf/1706.03762v7'
const TOKEN = 'test-only'
type Call = {
  url: string
  auth: string | null
  cookie: string | null
  filename?: string
  profiles?: string
}
let script: string
let runtime: Miniflare
let calls: Call[]
let redirectConverter: boolean
let redirectSource: boolean

beforeAll(async () => {
  // Run the actual gateway in workerd: Node's fetch mocks accept redirect:error,
  // but Workers reject that option before any provider request is dispatched.
  const result = await build({
    stdin: {
      contents:
        'import {handleStructDemoRequest} from "./src/worker/struct-demo/index.ts"; export default { fetch(request, env) { return handleStructDemoRequest(request, env) } };',
      resolveDir: process.cwd(),
      sourcefile: 'runtime-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  })
  script = result.outputFiles[0].text
})
beforeEach(async () => {
  calls = []
  redirectConverter = false
  redirectSource = false
  let sequence = 0
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-07-11',
      script,
      bindings: {
        MARGIN_ENVIRONMENT: 'production',
        STRUCT_DEMO_ORIGIN: CONVERTER,
        STRUCT_DEMO_TOKEN: TOKEN,
      },
      d1Databases: { MARGIN_DB: 'runtime-test-db' },
      outboundService: async (request) => {
        const call: Call = {
          url: request.url,
          auth: request.headers.get('Authorization'),
          cookie: request.headers.get('Cookie'),
        }
        calls.push(call)
        if (request.url === SAMPLE) {
          return redirectSource
            ? new RuntimeResponse(null, {
                status: 302,
                headers: { Location: 'https://redirect.example/source' },
              })
            : new RuntimeResponse('%PDF-1.7\nsample', {
                headers: { 'Content-Type': 'application/pdf' },
              })
        }
        if (request.url === CONVERTER + '/api/jobs') {
          if (redirectConverter)
            return new RuntimeResponse(null, {
              status: 302,
              headers: { Location: 'https://redirect.example/converter' },
            })
          const form = await request.formData()
          const file = form.get('file')
          if (!file || typeof file === 'string')
            throw new Error('Expected a PDF file')
          call.filename = file.name
          call.profiles = String(form.get('profiles'))
          expect(await file.text()).toMatch(/^%PDF-/)
          return RuntimeResponse.json(
            { id: (++sequence).toString(16).padStart(32, '0') },
            { status: 202 },
          )
        }
        return new RuntimeResponse('Unexpected outbound request', {
          status: 500,
        })
      },
    }),
  )
  const database = await runtime.getD1Database('MARGIN_DB')
  for (const statement of readFileSync(
    'migrations/0005_struct_demo.sql',
    'utf8',
  )
    .split(';')
    .filter((s) => s.trim()))
    await database.prepare(statement).run()
})
afterEach(async () => {
  await runtime?.dispose()
})
function post(path: string, body?: string) {
  return runtime.dispatchFetch(SITE + '/api/struct-demo/' + path, {
    method: 'POST',
    headers: {
      Origin: SITE,
      'CF-Connecting-IP': '192.0.2.1',
      'Content-Type': 'application/pdf',
      Cookie: 'must-not-reach-provider=yes',
    },
    body,
  })
}
describe('Struct gateway on the Cloudflare workerd runtime', () => {
  it('submits uploads and the pinned sample with real FormData and converter-only credentials', async () => {
    const upload = await post('jobs', '%PDF-1.7\nupload')
    expect(upload.status).toBe(202)
    const sample = await post('samples/attention-is-all-you-need')
    expect(sample.status).toBe(202)
    expect(calls.map((c) => c.url)).toEqual([
      CONVERTER + '/api/jobs',
      SAMPLE,
      CONVERTER + '/api/jobs',
    ])
    expect(calls[0]).toMatchObject({
      auth: 'Bearer ' + TOKEN,
      cookie: null,
      filename: 'document.pdf',
      profiles: 'paperPro,paperProMove',
    })
    expect(calls[1]).toMatchObject({ auth: null, cookie: null })
    expect(calls[2]).toMatchObject({
      auth: 'Bearer ' + TOKEN,
      cookie: null,
      filename: 'attention-is-all-you-need.pdf',
    })
    expect(await upload.text()).not.toContain(TOKEN)
    expect(await sample.text()).not.toContain(TOKEN)
  })
  it('does not follow converter redirects or forward the token to their destination', async () => {
    redirectConverter = true
    const response = await post('jobs', '%PDF-1.7\nupload')
    expect(response.status).toBe(503)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(CONVERTER + '/api/jobs')
    expect(await response.text()).not.toContain(TOKEN)
  })
  it('does not follow sample redirects or send private credentials to the source', async () => {
    redirectSource = true
    const response = await post('samples/attention-is-all-you-need')
    expect(response.status).toBe(503)
    expect(calls).toEqual([{ url: SAMPLE, auth: null, cookie: null }])
    expect(await response.text()).not.toContain(TOKEN)
  })
})
