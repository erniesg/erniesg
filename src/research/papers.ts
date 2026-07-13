import ifLettersHomeCouldSing from './papers/if-letters-home-could-sing.json'
import rawPaper from './papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from './schema'

export const papers = [
  researchPaperSchema.parse(ifLettersHomeCouldSing),
  researchPaperSchema.parse(rawPaper),
]

export function getPaper(id: string) {
  return papers.find((paper) => paper.id === id)
}
