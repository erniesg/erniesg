import { expect, it } from 'vitest'
import { previewScale } from './struct-demo-preview'

it('fits a desktop viewport inside a phone without changing its logical width', () => {
  expect(previewScale(358, 1280)).toBe(0.2796875)
})
it('keeps a phone preview at natural size when the host is wider', () => {
  expect(previewScale(704, 390)).toBe(1)
})
it('keeps hidden previews valid until their container becomes measurable', () => {
  expect(previewScale(0, 768)).toBe(1)
})
