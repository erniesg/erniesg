import { expect, it } from 'vitest'
import {
  readerCss,
  previewDimension,
  STRUCT_DEVICE_MODELS,
} from './struct-reader-settings'

it('bounds custom dimensions and rejects empty or nonfinite input', () => {
  expect(previewDimension('720', 390)).toBe(720)
  expect(previewDimension('', 390)).toBe(390)
  expect(previewDimension('Infinity', 390)).toBe(390)
  expect(previewDimension('1', 390)).toBe(240)
  expect(previewDimension('999999', 390)).toBe(2560)
})
it('applies readable typography without allowing arbitrary CSS', () => {
  const css = readerCss({ fontSize: 22, fontFamily: 'sans', margin: 32 })
  expect(css).toContain('font-size:22px!important')
  expect(css).toContain('padding:32px!important')
  expect(css).toContain('Arial')
  expect(
    readerCss({ fontSize: NaN, fontFamily: 'bad' as 'serif', margin: -5 }),
  ).not.toContain('NaN')
  expect(
    readerCss({ fontSize: 999, fontFamily: 'serif', margin: -5 }),
  ).toContain('font-size:32px!important')
})
it('provides separate device models in each surface group', () => {
  for (const device of ['phone', 'tablet', 'desktop', 'eink']) {
    expect(
      STRUCT_DEVICE_MODELS.filter((model) => model.device === device).length,
    ).toBeGreaterThan(1)
  }
})
