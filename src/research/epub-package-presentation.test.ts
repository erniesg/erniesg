import { describe, expect, it } from 'vitest'
import { navXhtml } from './epub-package-presentation'
import type { ResearchPaper } from './schema'

describe('EPUB package navigation', () => {
  it('preserves the source heading hierarchy', () => {
    const paper = {
      id: 'navigation-paper',
      title: 'Package Study',
      language: 'en',
      nodes: [
        {
          id: 'package-title',
          type: 'heading',
          level: 1,
          text: 'Package Study',
        },
        { id: 'methods', type: 'heading', level: 2, text: 'Methods' },
        { id: 'sampling', type: 'heading', level: 3, text: 'Sampling' },
      ],
    } as ResearchPaper

    expect(navXhtml(paper)).toContain(
      '<li><a href="content.xhtml#methods">Methods</a><ol><li><a href="content.xhtml#sampling">Sampling</a></li></ol></li>',
    )
  })
})
