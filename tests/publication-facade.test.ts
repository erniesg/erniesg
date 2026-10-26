import { describe, expect, it } from 'vitest'
import { loadAdapterCase } from './fixtures/struct-adapter-parity/cases'
import { buildStructDocument } from '../src/struct-adapters'
import { adaptStructDocument } from '../src/publication/struct-adapter'
import {
  structDocumentJson,
  structSemanticReceiptSha256,
} from '../src/publication/struct-source-binding'
import {
  assertPublicationPlanSourceBinding,
  buildPublicationPlan,
  canonicalRouteBodyFingerprint,
  canonicalSubsetSha256ForPlan,
  publicationPlanExpectations,
  publicationPlanFromStructDocument,
  serializeStructDocumentForPersistence,
} from '../src/publication/publishing-facade'

/**
 * The pinned Struct revision the facade tests publish.
 *
 * It is the app's own ingress output for the checked-in fixture, so the plan
 * under test is the plan the production pipeline builds.
 */
async function pinnedStructDocument() {
  return buildStructDocument(await loadAdapterCase('ordinary-pdf'))
}

describe('the app-owned publishing facade', () => {
  it('publishes the pinned Struct revision as the plan identity', async () => {
    const document = await pinnedStructDocument()
    const plan = await buildPublicationPlan({ adapterId: 'struct', document })
    expect(plan.structDocument).toBe(document)
    expect(plan.structDocumentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.sourceBinding.kind).toBe('struct-cutover')
    if (plan.sourceBinding.kind !== 'struct-cutover')
      throw new Error('The plan is not bound to a Struct document')
    // The binding names the very document the plan carries, and the pin of
    // the package that produced it.
    expect(plan.sourceBinding.documentSha256).toBe(plan.structDocumentSha256)
    expect(plan.sourceBinding.packageSourceCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(plan.sourceBinding.packageArtifactSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.sourceBinding.packageIntegrity).toMatch(/^sha512-/)
    expect(plan.structBundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.structBundleSha256).toBe(plan.sourceBinding.bundleSha256)
    expect(plan.assetBundle.descriptor.version).toBe('1.0.0')
    expect(plan.assetBundle.descriptor.assets).toBeInstanceOf(Array)
    expect(plan.diagnostics).toBeInstanceOf(Array)
    expect(plan.provenance.adapterId).toBe('struct-document')
  })

  it('rebuilds the same plan from the persisted document', async () => {
    const document = await pinnedStructDocument()
    const plan = await buildPublicationPlan({ adapterId: 'struct', document })
    const rebuilt = await publicationPlanFromStructDocument(
      document,
      plan.assetBundle,
    )
    // The checker rebuilds the plan from the persisted document alone, so
    // the two plans have to agree on the identity of the publication.
    expect(rebuilt.structDocumentSha256).toBe(plan.structDocumentSha256)
    expect(rebuilt.sourceBinding).toEqual(plan.sourceBinding)
    expect(canonicalSubsetSha256ForPlan(rebuilt)).toBe(
      canonicalSubsetSha256ForPlan(plan),
    )
    expect(serializeStructDocumentForPersistence(rebuilt)).toBe(
      serializeStructDocumentForPersistence(plan),
    )
  })

  it('persists the canonical Struct bytes', async () => {
    const document = await pinnedStructDocument()
    const plan = await buildPublicationPlan({ adapterId: 'struct', document })
    // The persisted document is the canonical form of the pinned package, so
    // the facade and the renderer persist exactly the same bytes.
    expect(serializeStructDocumentForPersistence(plan)).toBe(
      structDocumentJson(document),
    )
  })

  it('derives the artifact expectations from the plan', async () => {
    const document = await pinnedStructDocument()
    const plan = await buildPublicationPlan({ adapterId: 'struct', document })
    const expectations = publicationPlanExpectations(plan)
    const projected = adaptStructDocument(document)
    const required = projected.graph.nodes.filter(
      (node) => node.requirement !== 'optional',
    )
    expect(expectations.title).toBe(projected.graph.metadata.title)
    expect(expectations.locale).toBe(projected.graph.edition.locale)
    expect(expectations.publicationId).toBe(projected.graph.id)
    expect(expectations.headingOrder).toEqual(
      projected.graph.nodes
        .filter((node) => node.type === 'heading')
        .map((node) => node.text),
    )
    expect(expectations.bodyOrder.length).toBeGreaterThan(0)
    // The expectations are the required nodes of the projection, in the
    // order they are rendered.
    expect(expectations.profiles['phone-webpub'].nodes.map((n) => n.id)).toEqual(
      required.map((node) => node.id),
    )
    expect(expectations.profiles['phone-webpub'].nodeOrder.length).toBe(
      required.length,
    )
    // The PDF requirements are the texts the document really carries.
    const pdfTexts = expectations.profiles['a5-pdf'].pdfTextRequirements
    expect(pdfTexts).toContain(projected.graph.metadata.title)
    expect(
      pdfTexts.some((text) =>
        projected.graph.nodes.some(
          (node) => 'text' in node && node.text === text,
        ),
      ),
    ).toBe(true)
    expect(
      expectations.profiles['a5-pdf'].pdfWidowOrphanTexts.every((text) =>
        projected.graph.nodes.some(
          (node) => 'text' in node && node.text === text,
        ),
      ),
    ).toBe(true)
  })
})

describe('the canonical route fingerprint of the facade', () => {
  it('binds the canonical route body semantics to the published plan', () => {
    // The plan derives its body fingerprint from the same semantic tokens
    // the canonical route is compared against, so the two have to agree.
    expect(
      canonicalRouteBodyFingerprint(
        '<article><h1>Heading</h1><p>Body proof</p></article>',
      ),
    ).toEqual(['h1:Heading', 'p:Body proof'])
    expect(
      canonicalRouteBodyFingerprint(
        '<article><h1>Heading</h1><p>Changed</p></article>',
      ),
    ).not.toEqual(['h1:Heading', 'p:Body proof'])
  })

  it('reads a post body inside the reading shell, not the shell around it', () => {
    // ReadingLayout makes the text column the <article>, so the post's own
    // breadcrumb, title and navigation sit beside its prose. The prose is
    // the element marked `data-post-content`.
    const shell = `<article class="reading-text"><nav>Blog › Post</nav>
      <h1>The post title</h1><p>February 10, 2025</p>
      <div class="prose" data-post-content><h1>Heading</h1><p>Body proof</p></div>
      <nav><p>Next post</p></nav></article>`
    expect(canonicalRouteBodyFingerprint(shell)).toEqual([
      'h1:Heading',
      'p:Body proof',
    ])
  })

  it('treats Astro typographic apostrophes as the same authored body text', () => {
    expect(
      canonicalRouteBodyFingerprint(
        '<article><p>Author’s proof</p></article>',
      ),
    ).toEqual(["p:Author's proof"])
  })

  it('normalizes Markdown image titles to the caption semantics of the plan', () => {
    const html =
      '<article><p><img src="/assets/figure.png" alt="Alt text" title="Authored image title"></p></article>'
    expect(canonicalRouteBodyFingerprint(html)).toEqual([
      'figcaption:Authored image title',
    ])
  })
})

describe('the Struct binding of a publication plan', () => {
  it('always carries the bundle and semantic receipt digests', async () => {
    const document = await pinnedStructDocument()
    const plan = await buildPublicationPlan({ adapterId: 'struct', document })
    // A publication plan is always bundle-bound and always carries the
    // package's semantic receipt digest: there is no plan without them.
    expect(plan.structBundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.semanticReceiptSha256).toBe(
      structSemanticReceiptSha256(document),
    )
    if (plan.sourceBinding.kind !== 'struct-cutover')
      throw new Error('The plan is not bound to a Struct document')
    expect(plan.sourceBinding.bundleSha256).toBe(plan.structBundleSha256)
    expect(plan.sourceBinding.semanticReceiptSha256).toBe(
      plan.semanticReceiptSha256,
    )
  })

  it('refuses a receipt that names another bundle or semantic receipt', async () => {
    const document = await pinnedStructDocument()
    const plan = await buildPublicationPlan({ adapterId: 'struct', document })
    const receipt = { sourceBinding: plan.sourceBinding }
    expect(assertPublicationPlanSourceBinding(receipt, plan)).toEqual(
      plan.sourceBinding,
    )
    expect(() =>
      assertPublicationPlanSourceBinding(
        {
          sourceBinding: {
            ...plan.sourceBinding,
            bundleSha256: 'f'.repeat(64),
          },
        },
        plan,
      ),
    ).toThrow(/different Struct bundle/u)
    expect(() =>
      assertPublicationPlanSourceBinding(
        {
          sourceBinding: {
            ...plan.sourceBinding,
            semanticReceiptSha256: 'f'.repeat(64),
          },
        },
        plan,
      ),
    ).toThrow(/different Struct semantic receipt/u)
    expect(() =>
      assertPublicationPlanSourceBinding(
        { sourceBinding: { kind: 'legacy-research-paper' } },
        plan,
      ),
    ).toThrow(/not bound to a Struct document/u)
  })
})
