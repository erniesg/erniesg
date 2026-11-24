import {
  geoArea,
  geoBounds,
  geoCentroid,
  geoContains,
  geoDistance,
  geoInterpolate,
} from 'd3-geo'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import access from '../../data/atlas-access.json'
import flags from '../../data/atlas-flags.json'
import { ATLAS_DESTINATIONS } from '../../data/atlas'

export type AtlasStatus = 'visited' | 'easy' | 'special' | 'required'

export type AtlasFeature = {
  name: string
  status: AtlasStatus
  geometry: Polygon | MultiPolygon
  centroid: [number, number]
  /** Angular radius in radians, from the centroid to the furthest vertex. */
  radius: number
  bounds: [[number, number], [number, number]]
}

/** Natural Earth abbreviations to the names used by the audit and on the page. */
const DISPLAY_NAMES: Record<string, string> = {
  'Antigua and Barb.': 'Antigua and Barbuda',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Br. Indian Ocean Ter.': 'British Indian Ocean Territory',
  'British Virgin Is.': 'British Virgin Islands',
  'Cabo Verde': 'Cape Verde',
  'Cayman Is.': 'Cayman Islands',
  'Central African Rep.': 'Central African Republic',
  Congo: 'Republic of the Congo',
  'Cook Is.': 'Cook Islands',
  "Côte d'Ivoire": 'Ivory Coast',
  'Dem. Rep. Congo': 'Democratic Republic of the Congo',
  'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea',
  eSwatini: 'Eswatini',
  'Faeroe Is.': 'Faroe Islands',
  'Falkland Is.': 'Falkland Islands',
  'Fr. Polynesia': 'French Polynesia',
  'Fr. S. Antarctic Lands': 'French Southern and Antarctic Lands',
  Macedonia: 'North Macedonia',
  'Marshall Is.': 'Marshall Islands',
  'N. Cyprus': 'Northern Cyprus',
  'N. Mariana Is.': 'Northern Mariana Islands',
  'Pitcairn Is.': 'Pitcairn Islands',
  'S. Geo. and the Is.': 'South Georgia and the South Sandwich Islands',
  'S. Sudan': 'South Sudan',
  'Sint Maarten': 'Sint Maarten',
  'Solomon Is.': 'Solomon Islands',
  'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'St. Pierre and Miquelon': 'Saint Pierre and Miquelon',
  'St. Vin. and Gren.': 'Saint Vincent and the Grenadines',
  'St-Barthélemy': 'Saint Barthélemy',
  'St-Martin': 'Saint Martin',
  'São Tomé and Principe': 'Sao Tome and Principe',
  'Turks and Caicos Is.': 'Turks and Caicos Islands',
  'U.S. Virgin Is.': 'U.S. Virgin Islands',
  'United States of America': 'United States',
  Vatican: 'Vatican City',
  'W. Sahara': 'Western Sahara',
  'Wallis and Futuna Is.': 'Wallis and Futuna',
}

const VISITED = new Set(ATLAS_DESTINATIONS.map((d) => d.name))
const ANCHORS = new Map(ATLAS_DESTINATIONS.map((d) => [d.name, d.anchor]))

const ACCESS = new Map<string, AtlasStatus>(
  (['easy', 'special', 'required'] as const).flatMap((status) =>
    access[status].map((name): [string, AtlasStatus] => [name, status]),
  ),
)
// French overseas territory: short stays follow France's visa exemption.
ACCESS.set('French Guiana', 'easy')

export function statusOf(name: string): AtlasStatus {
  if (VISITED.has(name)) return 'visited'
  return ACCESS.get(name) ?? 'special'
}

function polygonsOf(geometry: Polygon | MultiPolygon): Position[][][] {
  return geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates
}

function toFeature(
  name: string,
  geometry: Polygon | MultiPolygon,
): AtlasFeature {
  const geo: Feature<Polygon | MultiPolygon> = {
    type: 'Feature',
    properties: {},
    geometry,
  }
  // A whole country's centre can fall in the sea (Malaysia, Indonesia), so routes
  // land on its largest landmass unless the destination names a better point.
  const largest = polygonsOf(geometry)
    .map((coordinates): Polygon => ({ type: 'Polygon', coordinates }))
    .sort((a, b) => geoArea(b) - geoArea(a))[0]
  const centroid =
    ANCHORS.get(name) ?? (geoCentroid(largest) as [number, number])
  let radius = 0
  for (const polygon of polygonsOf(geometry)) {
    for (const point of polygon[0]) {
      radius = Math.max(
        radius,
        geoDistance(centroid, point as [number, number]),
      )
    }
  }
  return {
    name,
    status: statusOf(name),
    geometry,
    centroid,
    radius,
    bounds: geoBounds(geo) as AtlasFeature['bounds'],
  }
}

/**
 * Natural Earth draws French Guiana, and the Caribbean and Indian Ocean
 * departments, as parts of France. Colouring "France" would otherwise paint
 * South America as visited, so only Europe stays France and French Guiana
 * becomes its own destination.
 */
function splitFrance(geometry: MultiPolygon): AtlasFeature[] {
  const all = geometry.coordinates.map((coordinates) => {
    const [lon, lat] = geoCentroid({ type: 'Polygon', coordinates })
    return { coordinates, lon, lat }
  })
  const europe = all.filter(({ lon, lat }) => lat > 35 && lon > -10 && lon < 15)
  const guiana = all.filter(
    ({ lon, lat }) => lat > 0 && lat < 10 && lon > -60 && lon < -50,
  )
  const rest = all.filter(
    (part) => !europe.includes(part) && !guiana.includes(part),
  )
  const multi = (parts: typeof all): MultiPolygon => ({
    type: 'MultiPolygon',
    coordinates: parts.map((part) => part.coordinates),
  })
  const features = [
    toFeature('France', multi(europe)),
    toFeature('French Guiana', multi(guiana)),
  ]
  if (rest.length)
    features.push(toFeature('French overseas departments', multi(rest)))
  return features
}

export function buildAtlasFeatures(topology: Topology): AtlasFeature[] {
  const collection = topology.objects.countries as GeometryCollection<{
    name: string
  }>
  const features: AtlasFeature[] = []
  for (const item of feature(topology, collection).features) {
    const source = item.properties?.name
    const geometry = item.geometry
    if (
      !source ||
      !(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
    )
      continue
    if (source === 'France' && geometry.type === 'MultiPolygon') {
      features.push(...splitFrance(geometry))
      continue
    }
    features.push(toFeature(DISPLAY_NAMES[source] ?? source, geometry))
  }
  return features
}

/** Generous hit radius so tiny countries can actually be clicked. */
const SMALL_HIT = (1.1 * Math.PI) / 180

function inBounds(f: AtlasFeature, lon: number, lat: number) {
  const [[west, south], [east, north]] = f.bounds
  if (lat < south - 1 || lat > north + 1) return false
  return west <= east
    ? lon >= west - 1 && lon <= east + 1
    : lon >= west - 1 || lon <= east + 1
}

export function pickFeature(
  features: AtlasFeature[],
  lon: number,
  lat: number,
) {
  const point: [number, number] = [lon, lat]
  const candidates = features.filter((f) => inBounds(f, lon, lat))
  const exact = candidates
    .filter((f) =>
      geoContains(
        { type: 'Feature', properties: {}, geometry: f.geometry },
        point,
      ),
    )
    .sort((a, b) => geoArea(a.geometry) - geoArea(b.geometry))[0]
  if (exact) return exact
  return features.find(
    (f) =>
      f.status === 'visited' &&
      f.radius < 0.012 &&
      geoDistance(f.centroid, point) < SMALL_HIT,
  )
}

export function flagUrl(name: string) {
  const code = (flags as Record<string, string>)[name]
  return code ? `/flags/${code}.svg` : undefined
}

const EARTH_RADIUS_KM = 6371

/** Great-circle distance between country centres, rounded so it isn't falsely exact. */
export function distanceKm(from: AtlasFeature, to: AtlasFeature) {
  return (
    Math.round(
      (geoDistance(from.centroid, to.centroid) * EARTH_RADIUS_KM) / 10,
    ) * 10
  )
}

export const CAMERA_FOV = 26
export const REST_DISTANCE = 5.05
export const CLOSEST_DISTANCE = 3.05
/** Share of the half-height a framed route may use, clear of the round lens edge. */
const FRAME_FILL = 0.72
/** The furthest a destination may sit from the view's centre and still read clearly. */
const MAX_OFFSET = (70 * Math.PI) / 180

/**
 * Where to point the camera so a route's two ends share the view. Near-antipodal
 * routes cannot both fit on one hemisphere, so the destination wins there.
 */
export function routeFraming(from: AtlasFeature, to: AtlasFeature) {
  const separation = geoDistance(from.centroid, to.centroid)
  const fromOffset = Math.max(separation / 2, separation - MAX_OFFSET)
  const toOffset = separation - fromOffset
  const center = (
    separation > 0
      ? geoInterpolate(from.centroid, to.centroid)(fromOffset / separation)
      : from.centroid
  ) as [number, number]
  const extent = Math.min(
    Math.max(fromOffset, toOffset + Math.min(to.radius, 0.3)),
    Math.PI / 2,
  )
  const halfView = Math.tan((CAMERA_FOV / 2) * (Math.PI / 180)) * FRAME_FILL
  const distance = Math.sin(extent) / halfView + Math.cos(extent)
  return {
    center,
    fromOffset,
    toOffset,
    distance: Math.min(REST_DISTANCE, Math.max(CLOSEST_DISTANCE, distance)),
  }
}
