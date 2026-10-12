import { parse } from '@astrojs/compiler'
import type { Node } from '@astrojs/compiler/types'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { representingTasteProject } from './representing-taste'
import { structProject } from './struct-project'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const source = (relativePath: string) =>
  readFileSync(path.join(ROOT, relativePath), 'utf8')

describe('research programme framing', () => {
  it('keeps REPResenting Taste as the parent programme with an immutable source', () => {
    expect(representingTasteProject.path).toBe('/research/representing-taste/')
    expect(representingTasteProject.sourcePlan).toContain(
      'github.com/erniesg/struct/blob/47741d3ef267af9ce1c7343b7e617b4e926bb2d9/',
    )
    expect(representingTasteProject.question).toBe(
      'How can taste be represented so that creative judgment can be inspected, composed, adapted and reconsidered across changing contexts?',
    )
  })

  it('keeps Struct as the supporting component and preserves its demo route', () => {
    expect(structProject.status).toBe('Supporting component')
    expect(structProject.demoPath).toBe('/research/struct/demo/')
  })

  it('keeps the landing programme-focused while preserving direct paper routes', () => {
    const landing = source('src/pages/research/index.astro')
    const projects = source('src/components/research/ResearchProjects.astro')

    expect(landing).toContain('Research papers and work in progress.')
    expect(landing).not.toContain('@/research/papers')
    expect(landing).not.toContain('research-papers')
    expect(projects).toContain('representingTasteProject')
    expect(projects).toContain('structProject')
    expect(projects).toContain('First supporting milestone')
    expect(projects).toContain('href={structProject.demoPath}')
  })

  it('keeps programme and supporting demo links independent without nested anchors', async () => {
    const { ast } = await parse(
      source('src/components/research/ResearchProjects.astro'),
    )
    const hrefs: string[] = []
    function visit(node: Node, insideAnchor = false) {
      const anchor = node.type === 'element' && node.name === 'a'
      if (anchor) {
        expect(insideAnchor, 'a link must not contain another link').toBe(false)
        hrefs.push(
          node.attributes.find(({ name }) => name === 'href')?.value ?? '',
        )
      }
      if ('children' in node)
        for (const child of node.children) visit(child, insideAnchor || anchor)
    }
    visit(ast)
    expect(hrefs).toEqual([
      'representingTasteProject.path',
      'structProject.demoPath',
    ])
  })

  it('uses the concise REPR programme framing and planned outcome', () => {
    const page = source('src/pages/research/representing-taste/index.astro')

    expect(page).toContain(
      'Much of creative production is a grind of adaptation',
    )
    expect(page).toContain('<h2>Approach</h2>')
    expect(page).toContain('<h2>Why Now</h2>')
    expect(page).toContain('<h2>Outcome</h2>')
    for (const capability of ['Replay', 'Edit', 'Parallel', 'Remix']) {
      expect(page).toContain(`<td>${capability}</td>`)
    }
    expect(page).toContain('The model is extensible with')
    expect(page).toContain('A typed API would apply operations')
    expect(page).toContain('application-owned source of truth')
    expect(page).toMatch(/The proposed initial target is at least 20%/u)
    expect(page).toMatch(/same content briefs, model access, and\s+renderer/u)
    expect(page).toContain(
      'Autonomous creative work now needs explicit shared state',
    )
    expect(page).toContain('Proposed REPResenting Taste software architecture')
    expect(page).toContain('Record operations against a known state')
    expect(page).toContain('published across digital and offline formats')
    expect(page).toMatch(/creative\s+decisions, and dependencies across forms/u)
    expect(page).toContain('href={structProject.demoPath}')
    expect(page).not.toContain('Baddie')
  })
})
