import rawPaper from './papers/semantic-responsive-typesetting.json'
import { researchPaperSchema } from './schema'

export const papers = [researchPaperSchema.parse(rawPaper)]

export function getPaper(id: string) {
  return papers.find((paper) => paper.id === id)
}
