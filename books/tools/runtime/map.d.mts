/** Types for `map.mjs`. */
export type MapTopic = {
  id: string
  title: string
  part: number
  partName: string
  agent: string
  requires: string[]
  requiresIds: string[]
  unlocks: string[]
  nodes: { id: string; title: string; kind: string }[]
}

export function topicStates(topics: MapTopic[], solved: string[]): Map<string, string>
export function mapElements(topics: MapTopic[], solved: string[]): unknown[]
export function mapCounts(
  topics: MapTopic[],
  solved: string[],
): { topics: number; cleared: number; written: number }
export function drawMap(
  doc: Document,
  options: {
    topics: MapTopic[]
    solved: string[]
    href: (nodeId: string) => string
    cytoscape?: unknown
    dagre?: unknown
  },
): { destroy(): void } | null
