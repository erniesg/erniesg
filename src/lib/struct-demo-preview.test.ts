import { expect, it } from 'vitest'
import { previewScale, createPreviewRequestGuard } from './struct-demo-preview'

it('fits a desktop viewport inside a phone without changing its logical width', () => {
  expect(previewScale(358, 1280)).toBe(0.2796875)
})
it('keeps a phone preview at natural size when the host is wider', () => {
  expect(previewScale(704, 390)).toBe(1)
})
it('keeps hidden previews valid until their container becomes measurable', () => {
  expect(previewScale(0, 768)).toBe(1)
})

it('keeps a current completed preview available without overriding a newer sample choice', () => {
  const guard = createPreviewRequestGuard()
  guard.start('A')
  guard.selectionChanged()
  expect(guard.accepts('A')).toBe(true)
  expect(guard.shouldActivate('A')).toBe(false)
})
it('ignores both success and failure from an older request after a new request begins', () => {
  const guard = createPreviewRequestGuard()
  guard.start('A')
  guard.start('B')
  expect(guard.accepts('A')).toBe(false)
  expect(guard.shouldActivate('A')).toBe(false)
  expect(guard.shouldActivate('B')).toBe(true)
})
it('does not reset a reader choice when the current start notification is repeated', () => {
  const guard = createPreviewRequestGuard()
  guard.start('A')
  guard.selectionChanged()
  guard.start('A')
  expect(guard.shouldActivate('A')).toBe(false)
})
