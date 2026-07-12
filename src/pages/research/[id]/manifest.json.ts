import { papers } from '@/research/papers'

export function getStaticPaths() {
  return papers.map((paper) => ({ params: { id: paper.id }, props: { paper } }))
}

export function GET({ props }: { props: { paper: (typeof papers)[number] } }) {
  const manifest = {
    document: props.paper.id,
    version: props.paper.version,
    generatedAt: props.paper.updated,
    profiles: ['mobile', 'einkSmall', 'einkLarge', 'print'],
    nodes: props.paper.nodes.map((node, order) => ({ id: node.id, type: node.type, order, source: node.source })),
  }
  return new Response(JSON.stringify(manifest, null, 2), { headers: { 'Content-Type': 'application/json' } })
}
