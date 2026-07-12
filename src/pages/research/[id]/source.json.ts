import { papers } from '@/research/papers'

export function getStaticPaths() {
  return papers.map((paper) => ({ params: { id: paper.id }, props: { paper } }))
}

export function GET({ props }: { props: { paper: (typeof papers)[number] } }) {
  return new Response(JSON.stringify(props.paper, null, 2), { headers: { 'Content-Type': 'application/json' } })
}
