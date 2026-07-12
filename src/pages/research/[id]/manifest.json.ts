import { papers } from '@/research/papers'

export function getStaticPaths() {
  return papers.map((paper) => ({ params: { id: paper.id }, props: { paper } }))
}

export function GET({ props }: { props: { paper: (typeof papers)[number] } }) {
  const manifest = {
    document: props.paper.id,
    version: props.paper.version,
    generatedAt: props.paper.updated,
    profiles: [
      { id: 'mobile', mode: 'continuous', viewportCssPx: { width: 390 } },
      { id: 'paperProMove', device: 'reMarkable Paper Pro Move', diagonalInches: 7.3, resolutionPx: { width: 954, height: 1696 }, ppi: 264 },
      { id: 'paperPro', device: 'reMarkable Paper Pro', diagonalInches: 11.8, resolutionPx: { width: 1620, height: 2160 }, ppi: 229 },
      { id: 'print', medium: 'A4', dimensionsMm: { width: 210, height: 297 } },
    ],
    nodes: props.paper.nodes.map((node, order) => ({ id: node.id, type: node.type, order, source: node.source })),
  }
  return new Response(JSON.stringify(manifest, null, 2), { headers: { 'Content-Type': 'application/json' } })
}
