import { describe, expect, it, vi } from 'vitest'
import type { PdfNativeObject } from './import-types'
import { resolveNativeObjects } from './pdf'

function sourceBox(index: number) {
  return {
    page: 1,
    x: 0.02 + index * 0.01,
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

  it('keeps PDF.js source identifiers scoped to one resolution call', async () => {
    const source = 'page-local-image-source'
    const draftForPage = (page: number) => {
      const [draft] = drafts(1)
      const pageId = String(page).padStart(3, '0')
      return [
        {
          ...draft,
          object: {
            ...draft.object,
            id: `image-p${pageId}-001`,
            page,
            box: { ...draft.object.box, page },
          },
          source,
        },
      ]
    }
    const resolve = (page: number, data: number[]) =>
      resolveNativeObjects(
        {
          objs: {
            has: () => true,
            get(id) {
              expect(id).toBe(source)
              return {
                width: 1,
                height: 1,
                kind: 2,
                data: new Uint8Array(data),
              }
            },
          },
        },
        draftForPage(page),
      )

    const first = await resolve(1, [255, 0, 0])
    const second = await resolve(2, [0, 0, 255])

    expect(first.assets).toHaveLength(1)
    expect(second.assets).toHaveLength(1)
    expect(first.assets[0].sha256).not.toBe(second.assets[0].sha256)
    expect(first.assets[0].sourceObjectIds).toEqual(['image-p001-001'])
    expect(second.assets[0].sourceObjectIds).toEqual(['image-p002-001'])
    expect(first.assets[0].sourceBoxes[0].page).toBe(1)
    expect(second.assets[0].sourceBoxes[0].page).toBe(2)
  })

  it('reuses one shared source while matching the complete uncached result', async () => {
    const count = 64
    const decoded = {
      width: 2,
      height: 1,
      kind: 2,
      data: new Uint8Array([255, 0, 0, 0, 128, 255]),
    }
    const repeated = drafts(count).map((draft) => ({
      ...draft,
      source: 'shared-image-source',
    }))
    const uncached = drafts(count).map((draft) => ({
      ...draft,
      source: decoded,
    }))
    let reads = 0
    const digest = vi.spyOn(crypto.subtle, 'digest')
    try {
      const result = await resolveNativeObjects(
        {
          objs: {
            has: () => true,
            get() {
              reads += 1
              return decoded
            },
          },
        },
        repeated,
      )
      const cachedDigestCalls = digest.mock.calls.length
      const reference = await resolveNativeObjects(
        {
          objs: {
            has: () => false,
            get() {
              throw new Error(
                'non-string sources must not use the PDF.js object store',
              )
            },
          },
        },
        uncached,
      )
      const uncachedDigestCalls = digest.mock.calls.length - cachedDigestCalls

      expect(cachedDigestCalls).toBeGreaterThan(0)
      expect(uncachedDigestCalls).toBe(count * cachedDigestCalls)
      expect(reads).toBe(1)
      expect(result).toEqual(reference)
      expect(result.assets).toHaveLength(1)
      expect(result.assets[0].sourceObjectIds).toEqual(
        repeated.map((draft) => draft.object.id),
      )
      expect(result.assets[0].sourceBoxes).toEqual(
        repeated.map((draft) => draft.object.box),
      )
      expect(
        result.objects.every(
          (object) => object.assetId === result.assets[0].id,
        ),
      ).toBe(true)
      expect(result.assets[0].sha256).toBe(
        '5aef7d594dd6d4427308fac6871cafa2a911676ebd75e13f614edb86a397e01e',
      )
    } finally {
      digest.mockRestore()
    }
  })
})
