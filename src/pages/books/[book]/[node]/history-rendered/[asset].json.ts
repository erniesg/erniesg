/** Separate site-owned sidecars. Raw-v1 and the service locator are unchanged. */
import { renderedBookHistoryAssets } from '../../../../../lib/books'

export const prerender = true
export function getStaticPaths() {
  return renderedBookHistoryAssets().map(({ book, node, asset, json }) => ({ params: { book, node, asset }, props: { json } }))
}
export function GET({ props }: { props: { json: string } }): Response {
  return new Response(props.json, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })
}
export function HEAD({ props }: { props: { json: string } }): Response {
  const response = GET({ props })
  return new Response(null, { status: response.status, headers: response.headers })
}
