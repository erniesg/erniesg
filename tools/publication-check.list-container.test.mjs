import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderPublicationXhtml } from '@erniesg/struct/renderers/xhtml'
import { buildAstroStructDocument } from '../src/struct-adapters/from-markdown.ts'
import { createAssetBundle } from '../src/publication/asset-bundle.ts'
import {
  publicationPlanExpectations,
  publicationPlanFromStructDocument,
} from '../src/publication/publishing-facade.ts'
import {
  canonicalRequiredNodeExpectations,
  validatePublicationProfileContent,
} from './publication-check.mjs'

/**
 * The required-node set of the release check, measured over a real canonical
 * document.
 *
 * The document is a real Struct document built by the app's own MDX ingress
 * and accepted by the pinned package's codec, the expectations are the ones
 * the publishing facade derives from the plan, and the rendered output is the
 * pinned package renderer's own output of that document: the production
 * renderer, not a fixture.
 *
 * The seam under test is the required-node set. The projection mints a
 * list-container node for every list group, the canonical document carries no
 * such block, and the package renderer publishes the list structure without
 * an identifier for it. The required-node set must therefore be derived from
 * the canonical document, and the derivation must not excuse any canonical
 * content.
 */

const entryId = 'list-container-fixture'

const markdown = `---
title: 'The required node set'
description: 'A document whose list structure the release check must accept'
date: 2026-01-02
authors: ['erniesg']
---

# The required node set

A paragraph that the published document must carry.

1. The first ordered item
2. The second ordered item
   - The nested bullet item
3. The third ordered item
`

let contentRoot = ''
let document
let plan
let expectations
let rendered = ''

beforeAll(async () => {
  contentRoot = await mkdtemp(resolve(tmpdir(), 'e04-list-container-'))
  await mkdir(resolve(contentRoot, entryId), { recursive: true })
  await writeFile(resolve(contentRoot, entryId, 'index.mdx'), markdown)
  const conversion = await buildAstroStructDocument({
    entryId,
    contentRoot,
  })
  document = conversion.document
  const assetBundle = createAssetBundle(
    { version: '1.0.0', assets: [] },
    async () => {
      throw new Error('the fixture carries no asset bytes')
    },
  )
  plan = await publicationPlanFromStructDocument(document, assetBundle)
  expectations = publicationPlanExpectations(plan)
  rendered = renderPublicationXhtml(document)
})

afterAll(async () => {
  if (contentRoot) await rm(contentRoot, { recursive: true, force: true })
})

const canonicalBlockIds = () => document.blocks.map((block) => block.id)
const listItemIds = () =>
  document.blocks
    .filter((block) => block.kind === 'list-item')
    .map((block) => block.id)
const profile = (name = 'phone-webpub') => expectations.profiles[name]
const requiredProfile = (name = 'phone-webpub') =>
  canonicalRequiredNodeExpectations(expectations, document, plan.diagnostics)
    .profiles[name]

/** The rendered output without the element that carries the given id. */
function withoutElement(html, id) {
  return html.replace(
    new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</\\1>`, 'u'),
    '',
  )
}

describe('the required-node set of the release check', () => {
  it('measures the seam: the plan expects a list container the canonical document does not carry', () => {
    const planIds = profile().nodes.map((node) => node.id)
    const canonicalIds = canonicalBlockIds()
    const containerIds = planIds.filter((id) => !canonicalIds.includes(id))
    expect(containerIds.length).toBeGreaterThan(0)
    for (const containerId of containerIds)
      expect(containerId.endsWith('-list')).toBe(true)
    // The production renderer publishes the list structure without an
    // identifier for the container, so the plan-derived requirement set
    // rejects the real output. This is the measured release-check failure.
    expect(() =>
      validatePublicationProfileContent(profile(), rendered, 'phone-webpub'),
    ).toThrow(/dropped required node .*-list/u)
  })

  it('requires every canonical block and no list container', () => {
    const required = requiredProfile()
    expect(required.nodes.map((node) => node.id)).toEqual(canonicalBlockIds())
    expect(required.nodeOrder).toEqual(canonicalBlockIds())
    for (const id of listItemIds())
      expect(required.nodes.some((node) => node.id === id)).toBe(true)
  })

  it('accepts the rendered output of the pinned package renderer', () => {
    expect(() =>
      validatePublicationProfileContent(
        requiredProfile(),
        rendered,
        'phone-webpub',
      ),
    ).not.toThrow()
    expect(() =>
      validatePublicationProfileContent(
        requiredProfile('eink-epub'),
        rendered,
        'eink-epub',
      ),
    ).not.toThrow()
  })

  it('keeps the canonical text of every list item', () => {
    const required = requiredProfile()
    for (const block of document.blocks) {
      if (block.kind !== 'list-item') continue
      const node = required.nodes.find((candidate) => candidate.id === block.id)
      expect(node?.texts).toEqual([block.text])
    }
  })

  it('rejects a rendered output that dropped a canonical list item', () => {
    const dropped = listItemIds()[listItemIds().length - 1]
    const without = withoutElement(rendered, dropped)
    expect(without).not.toBe(rendered)
    expect(() =>
      validatePublicationProfileContent(
        requiredProfile(),
        without,
        'phone-webpub',
      ),
    ).toThrow(new RegExp(`dropped required node ${dropped}`, 'u'))
  })

  it('rejects a rendered output that dropped another canonical block', () => {
    const dropped = document.blocks.find(
      (block) => block.kind === 'paragraph',
    ).id
    const without = withoutElement(rendered, dropped)
    expect(without).not.toBe(rendered)
    expect(() =>
      validatePublicationProfileContent(
        requiredProfile(),
        without,
        'phone-webpub',
      ),
    ).toThrow(new RegExp(`dropped required node ${dropped}`, 'u'))
  })

  it('rejects a rendered output that changed the text of a canonical list item', () => {
    const item = document.blocks.find((block) => block.kind === 'list-item')
    const without = rendered.replace(item.text, 'a different item text')
    expect(without).not.toBe(rendered)
    expect(() =>
      validatePublicationProfileContent(
        requiredProfile(),
        without,
        'phone-webpub',
      ),
    ).toThrow(/dropped required node content/u)
  })

  it('refuses to excuse a node that is not a canonical list container', () => {
    const invented = {
      ...profile(),
      nodes: [
        ...profile().nodes,
        { id: 'invented-node', texts: [], alternativeText: '' },
      ],
    }
    expect(() =>
      canonicalRequiredNodeExpectations(
        { ...expectations, profiles: { 'phone-webpub': invented } },
        document,
        plan.diagnostics,
      ),
    ).toThrow(/requires a node that is not canonical content: invented-node/u)
  })

  it('refuses to excuse a canonical block the projection reported no reason for', () => {
    const dropped = document.blocks.find(
      (block) => block.kind === 'paragraph',
    ).id
    const without = {
      ...profile(),
      nodes: profile().nodes.filter((node) => node.id !== dropped),
      nodeOrder: profile().nodeOrder.filter((id) => id !== dropped),
    }
    expect(() =>
      canonicalRequiredNodeExpectations(
        { ...expectations, profiles: { 'phone-webpub': without } },
        document,
        plan.diagnostics,
      ),
    ).toThrow(
      new RegExp(
        `does not require the canonical block ${dropped} and the projection reported no reason`,
        'u',
      ),
    )
  })
})
