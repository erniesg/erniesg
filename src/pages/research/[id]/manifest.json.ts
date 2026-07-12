import { papers } from '@/research/papers'
import {
  buildLayoutManifest,
  serializeLayoutManifest,
} from '@/research/manifest'

export function getStaticPaths() {
  return papers.map((paper) => ({ params: { id: paper.id }, props: { paper } }))
}

export function GET({ props }: { props: { paper: (typeof papers)[number] } }) {
  const manifest = buildLayoutManifest(props.paper)
  return new Response(serializeLayoutManifest(manifest), {
    headers: { 'Content-Type': 'application/json' },
  })
}
