import { describe, expect, it } from 'vitest'
import rawPaper from '../research/papers/semantic-responsive-typesetting.json'
import { createDemoAnnotations } from '../research/annotations'
import { researchPaperSchema } from '../research/schema'
import {
  annotationBundleSchema,
  createAnnotationBundle,
  serializeAnnotationBundle,
} from './annotation-bundle'
import { researchPaperToPublicationGraph } from './research-paper-adapter'

describe('AnnotationBundle', () => {
  it('round-trips typed annotations and semantic anchors beside the graph', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const annotations = createDemoAnnotations(paper)
    const bundle = createAnnotationBundle(
      researchPaperToPublicationGraph(paper),
      annotations,
    )
    expect(
      annotationBundleSchema.parse(
        JSON.parse(serializeAnnotationBundle(bundle)),
      ),
    ).toEqual(bundle)
    expect(bundle.annotations).toEqual(annotations)
    expect(serializeAnnotationBundle(bundle)).not.toContain('"graph":')
  })

  it('rejects anchors to missing graph nodes', () => {
    const paper = researchPaperSchema.parse(rawPaper)
    const annotations = createDemoAnnotations(paper)
    annotations[0].target.nodeId = 'missing'
    expect(() =>
      createAnnotationBundle(
        researchPaperToPublicationGraph(paper),
        annotations,
      ),
    ).toThrow(/missing/)
  })
})
