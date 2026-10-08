/** Site-owned build artifact, not the private service history endpoint. */
import { bookHistoryAssets } from '../../../../lib/books'
import { serializeBookHistory } from '../../../../lib/book-history'

export const prerender = true

export function getStaticPaths() {
  // Nothing is exposed until the entire strict collection succeeds.
  return bookHistoryAssets().map((asset) => ({
    params: { book: asset.book, node: asset.node },
    props: { json: serializeBookHistory(asset) },
  }))
}

export function GET({ props }: { props: { json: string } }): Response {
  return new Response(props.json, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
