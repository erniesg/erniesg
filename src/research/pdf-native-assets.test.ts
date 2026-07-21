import { describe, expect, it } from 'vitest'
import type { PdfNativeObject } from './import-types'
import { resolveNativeObjects } from './pdf'

function sourceBox(index: number) {
  return {
    page: 1,
    x: 0.02 + index * 0.03,
    y: 0.2,
    width: 0.02,
    height: 0.02,
    rotation: 0,
    method: 'pdf-object' as const,
  }
}

function drafts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    object: {
      id: `image-p001-${String(index + 1).padStart(3, '0')}`,
      page: 1,
      kind: 'image' as const,
      box: sourceBox(index),
      confidence: 0.98,
      assetId: null,
    } satisfies PdfNativeObject,
    source: `image-source-${String(index + 1).padStart(3, '0')}`,
  }))
}

function objectStore(count: number, reverse: boolean) {
  const values = new Map(
    Array.from({ length: count }, (_, index) => [
      `image-source-${String(index + 1).padStart(3, '0')}`,
      {
        width: 1,
        height: 1,
        kind: 2,
        data: new Uint8Array([index, index, index]),
      },
    ]),
  )
  return {
    has: () => false,
    get(id: string, callback?: (value: unknown) => void) {
      const index = Number.parseInt(id.slice(-3), 10) - 1
      const delay = reverse ? count - index : index + 1
      setTimeout(() => callback?.(values.get(id)), delay)
      return undefined
    },
  }
}

describe('native PDF image payload resolution', () => {
  it('settles dense image sources independent of callback completion order', async () => {
    const count = 17
    const [forward, reverse] = await Promise.all([
      resolveNativeObjects({ objs: objectStore(count, false) }, drafts(count)),
      resolveNativeObjects({ objs: objectStore(count, true) }, drafts(count)),
    ])

    expect(forward.objects.every((object) => object.assetId)).toBe(true)
    expect(reverse.objects.every((object) => object.assetId)).toBe(true)
    expect(forward.objects.map((object) => object.assetId)).toEqual(
      reverse.objects.map((object) => object.assetId),
    )
    expect(
      forward.assets.flatMap((asset) => asset.sourceObjectIds).sort(),
    ).toEqual(reverse.assets.flatMap((asset) => asset.sourceObjectIds).sort())
  })

  it('fails closed before scheduling an unbounded image mosaic', async () => {
    const count = 65
    let callbacks = 0
    const store = objectStore(count, false)
    const result = await resolveNativeObjects(
      {
        objs: {
          has: store.has,
          get(id, callback) {
            callbacks += 1
            return store.get(id, callback)
          },
        },
      },
      drafts(count),
    )

    expect(callbacks).toBe(0)
    expect(result.assets).toEqual([])
    expect(result.objects.every((object) => object.assetId === null)).toBe(true)
  })

  it('fails the page atomically when one bounded callback never settles', async () => {
    const result = await resolveNativeObjects(
      {
        objs: {
          has: () => false,
          get(id, callback) {
            if (id.endsWith('001')) {
              setTimeout(
                () =>
                  callback?.({
                    width: 1,
                    height: 1,
                    kind: 2,
                    data: new Uint8Array([1, 1, 1]),
                  }),
                1,
              )
            }
            return undefined
          },
        },
      },
      drafts(2),
      undefined,
      10,
    )

    expect(result.assets).toEqual([])
    expect(result.objects.every((object) => object.assetId === null)).toBe(true)
  })
})
