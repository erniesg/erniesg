import { describe, expect, it } from 'vitest'
import { PublicationAdapterRegistry } from './adapter-registry'
import { payloadLexicalSourceAdapter } from './adapters/payload-lexical'

describe('publication source adapter conformance', () => {
  it('registers Payload through the same validated bundle boundary', async () => {
    const registry = new PublicationAdapterRegistry().register(payloadLexicalSourceAdapter)
    const bundle = await registry.resolve('payload-lexical', {
      id: 'conformance',
      title: 'Conformance',
      content: { root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'One' }] }] } },
    })
    expect(bundle.provenance.sourceType).toBe('payload')
    expect(bundle.graph.nodes[0].provenance.adapterId).toBe('payload-lexical')
  })

  it('rejects duplicate registrations and unknown adapters', async () => {
    const registry = new PublicationAdapterRegistry().register(payloadLexicalSourceAdapter)
    expect(() => registry.register(payloadLexicalSourceAdapter)).toThrow(/already registered/)
    await expect(registry.resolve('missing', {})).rejects.toThrow(/Unknown publication source adapter/)
  })
})
