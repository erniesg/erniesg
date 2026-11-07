import { geoContains } from 'd3-geo'
import { describe, expect, it } from 'vitest'
import type { Topology } from 'topojson-specification'
import world from 'world-atlas/countries-50m.json'
import access from '../../data/atlas-access.json'
import {
  ATLAS_DESTINATIONS,
  COUNTRIES_TOTAL,
  COUNTRIES_VISITED,
} from '../../data/atlas'
import { existsSync } from 'node:fs'
import {
  buildAtlasFeatures,
  distanceKm,
  flagUrl,
  pickFeature,
  routeFraming,
} from './geo'

const features = buildAtlasFeatures(world as unknown as Topology)
const named = (name: string) => {
  const found = features.find((f) => f.name === name)
  if (!found) throw new Error(`No geometry for ${name}`)
  return found
}
const contains = (name: string, lon: number, lat: number) =>
  geoContains(
    { type: 'Feature', properties: {}, geometry: named(name).geometry },
    [lon, lat],
  )

describe('atlas destinations', () => {
  it('counts the 25 countries from the evidence, without territories', () => {
    expect(COUNTRIES_VISITED).toBe(25)
  })

  it('has geometry for every destination, including the tiny ones', () => {
    for (const { name } of ATLAS_DESTINATIONS)
      expect(named(name).status).toBe('visited')
  })

  it('never lists a visited place as an access category', () => {
    const listed = [...access.easy, ...access.special, ...access.required]
    for (const { name } of ATLAS_DESTINATIONS)
      expect(listed).not.toContain(name)
  })

  it('resolves every audit destination that has map geometry', () => {
    const unmatched = [
      ...access.easy,
      ...access.special,
      ...access.required,
    ].filter((name) => !features.some((f) => f.name === name))
    // Too small for Natural Earth 50m; they stay in the data for later.
    expect(unmatched).toEqual(['Tuvalu'])
  })
})

describe('France and South America', () => {
  it('keeps metropolitan France and Corsica as France', () => {
    expect(contains('France', 2.35, 48.85)).toBe(true)
    expect(contains('France', 9.1, 42.2)).toBe(true)
  })

  it('splits French Guiana out and classes it as easy access', () => {
    expect(contains('France', -53, 4)).toBe(false)
    expect(contains('French Guiana', -53, 4)).toBe(true)
    expect(named('French Guiana').status).toBe('easy')
  })

  it('has no visited geometry anywhere in South America', () => {
    const southAmerica = features.filter((f) => f.status === 'visited')
    for (const f of southAmerica) {
      const polygons =
        f.geometry.type === 'Polygon'
          ? [f.geometry.coordinates]
          : f.geometry.coordinates
      for (const polygon of polygons) {
        for (const [lon, lat] of polygon[0]) {
          expect(
            lon > -90 && lon < -30 && lat > -60 && lat < 15,
            `${f.name} ${lon},${lat}`,
          ).toBe(false)
        }
      }
    }
  })

  it.each(['Guyana', 'Suriname', 'Brazil', 'Venezuela'])(
    'leaves %s unvisited',
    (name) => {
      expect(named(name).status).not.toBe('visited')
    },
  )
})

describe('access categories', () => {
  it.each([
    ['Peru', 'easy'],
    ['United States', 'easy'],
    ['North Korea', 'required'],
    ['Republic of the Congo', 'required'],
    ['Western Sahara', 'special'],
    ['Antarctica', 'special'],
  ])('%s is %s', (name, status) => {
    expect(named(name).status).toBe(status)
  })
})

describe('picking', () => {
  it('finds a country under a point', () => {
    expect(pickFeature(features, 139.7, 35.7)?.name).toBe('Japan')
  })

  it('finds tiny visited countries with a forgiving radius', () => {
    expect(pickFeature(features, 103.82, 1.35)?.name).toBe('Singapore')
    expect(pickFeature(features, 14.6, 35.6)?.name).toBe('Malta')
  })

  it('returns nothing over open ocean', () => {
    expect(pickFeature(features, -30, 30)).toBeUndefined()
  })
})

describe('total', () => {
  it('counts against all 195 countries', () => {
    expect(COUNTRIES_TOTAL).toBe(195)
    expect(COUNTRIES_VISITED).toBeLessThan(COUNTRIES_TOTAL)
  })
})

describe('flags', () => {
  it('has a flag file for every visited place', () => {
    for (const { name } of ATLAS_DESTINATIONS) {
      const url = flagUrl(name)
      expect(url, name).toBeTruthy()
      expect(existsSync(`public${url}`), name).toBe(true)
    }
  })

  it('has a file behind every mapped destination', () => {
    for (const f of features) {
      const url = flagUrl(f.name)
      if (url) expect(existsSync(`public${url}`), f.name).toBe(true)
    }
  })

  it('splits French Guiana from the French flag', () => {
    expect(flagUrl('France')).toBe('/flags/fr.svg')
    expect(flagUrl('French Guiana')).toBe('/flags/gf.svg')
  })

  it('returns nothing for places without a flag', () => {
    expect(flagUrl('Siachen Glacier')).toBeUndefined()
  })
})

describe('routes from Singapore', () => {
  const home = named('Singapore')

  it.each([
    ['Malaysia', 200, 450],
    ['Indonesia', 800, 1000],
    ['Japan', 4800, 5800],
    ['Australia', 3800, 5000],
    ['Malta', 9400, 10500],
    ['United Kingdom', 10300, 11400],
  ])('%s is a plausible distance', (name, low, high) => {
    const km = distanceKm(home, named(name))
    expect(km).toBeGreaterThan(low)
    expect(km).toBeLessThan(high)
    expect(km % 10).toBe(0)
  })

  it('keeps both ends in view for every visited country', () => {
    const halfView = Math.tan((13 * Math.PI) / 180)
    for (const { name, home: isHome } of ATLAS_DESTINATIONS) {
      if (isHome) continue
      const { fromOffset, toOffset, distance } = routeFraming(home, named(name))
      for (const offset of [fromOffset, toOffset]) {
        // In front of the horizon...
        expect(Math.cos(offset), name).toBeGreaterThan(1 / distance)
        // ...and inside the frame.
        const screen = Math.sin(offset) / (distance - Math.cos(offset))
        expect(screen, name).toBeLessThan(halfView)
      }
    }
  })

  it('keeps the destination in view on a near-antipodal route', () => {
    const { toOffset, distance } = routeFraming(home, named('Ecuador'))
    expect(Math.cos(toOffset)).toBeGreaterThan(1 / distance)
  })
})

describe('route anchors', () => {
  it.each([
    'Malaysia',
    'Indonesia',
    'Japan',
    'United Kingdom',
    'Greece',
    'France',
    'Australia',
  ])('%s lands on its own land, not the sea', (name) => {
    const f = named(name)
    expect(contains(name, f.centroid[0], f.centroid[1])).toBe(true)
  })
})
