/**
 * Places Ernie has been. Add to a destination freely: `note` shows on its card,
 * and new fields only need rendering in `src/pages/atlas.astro`.
 *
 * `name` matches the display name from `src/lib/atlas/geo.ts`.
 * Territories can be shown without counting towards the country total.
 */
export type AtlasRegion = 'Asia' | 'Europe' | 'Oceania'

export type AtlasDestination = {
  name: string
  region: AtlasRegion
  places: string[]
  note?: string
  home?: boolean
  /** Longitude, latitude for routes, where the largest landmass isn't where the trip went. */
  anchor?: [number, number]
  territory?: boolean
}

export const ATLAS_DESTINATIONS: AtlasDestination[] = [
  { name: 'Singapore', region: 'Asia', places: [], home: true },
  {
    name: 'China',
    region: 'Asia',
    places: [
      'Beijing',
      'Shanghai',
      'Guangzhou',
      'Chengdu',
      'Chongqing',
      'Hangzhou',
      'Nanjing',
      'Suzhou',
      'Ningbo',
      'Tianjin',
      'Harbin',
      'Changsha',
      'Guiyang',
      'Liuzhou',
      'Sanya',
      'Yangshuo',
      'Zhangjiajie',
      'Qikou',
    ],
  },
  { name: 'Hong Kong', region: 'Asia', places: ['Hong Kong'], territory: true },
  {
    name: 'Indonesia',
    region: 'Asia',
    anchor: [106.85, -6.21],
    places: [
      'Jakarta',
      'Bandung',
      'Surabaya',
      'Yogyakarta',
      'Prambanan',
      'Ubud',
      'Legian',
      'Madura',
    ],
  },
  { name: 'Japan', region: 'Asia', places: ['Tokyo'] },
  {
    name: 'Malaysia',
    region: 'Asia',
    anchor: [101.69, 3.14],
    places: [
      'Kuala Lumpur',
      'Petaling Jaya',
      'Shah Alam',
      'Cyberjaya',
      'Kajang',
      'Rawang',
    ],
  },
  { name: 'South Korea', region: 'Asia', places: ['Seoul', 'Ganghwa'] },
  { name: 'Thailand', region: 'Asia', places: ['Bangkok'] },
  { name: 'Turkey', region: 'Asia', places: ['Istanbul'] },
  { name: 'Vietnam', region: 'Asia', places: ['Hanoi', 'Ho Chi Minh City'] },
  { name: 'Austria', region: 'Europe', places: ['Vienna', 'Salzburg'] },
  { name: 'Belgium', region: 'Europe', places: ['Brussels'] },
  { name: 'Cyprus', region: 'Europe', places: ['Larnaca'] },
  { name: 'Czechia', region: 'Europe', places: ['Prague'] },
  {
    name: 'France',
    region: 'Europe',
    places: ['Paris', 'Fontainebleau', 'Barbizon'],
  },
  { name: 'Germany', region: 'Europe', places: ['Berlin', 'Berchtesgaden'] },
  {
    name: 'Greece',
    region: 'Europe',
    places: ['Thessaloniki', 'Andros', 'Artemida'],
  },
  { name: 'Hungary', region: 'Europe', places: ['Budapest'] },
  { name: 'Iceland', region: 'Europe', places: ['Vík'] },
  {
    name: 'Italy',
    region: 'Europe',
    places: [
      'Milan',
      'Bologna',
      'Brisighella',
      'San Candido',
      'Sexten',
      'Valle di Casies',
    ],
  },
  { name: 'Luxembourg', region: 'Europe', places: ['Vianden', 'Berdorf'] },
  { name: 'Malta', region: 'Europe', places: ['Sliema'] },
  { name: 'Poland', region: 'Europe', places: ['Gdańsk'] },
  { name: 'Spain', region: 'Europe', places: ['Barcelona'] },
  {
    name: 'United Kingdom',
    region: 'Europe',
    places: ['London', 'Oxford', 'Coventry'],
  },
  { name: 'Australia', region: 'Oceania', places: ['Melbourne', 'Perth'] },
]

export const ATLAS_REGIONS: AtlasRegion[] = ['Asia', 'Europe', 'Oceania']

/** Sovereign countries only; territories are shown but not counted. */
export const COUNTRIES_VISITED = ATLAS_DESTINATIONS.filter(
  (d) => !d.territory,
).length

/** UN members plus observers; all 25 visited countries are within it. */
export const COUNTRIES_TOTAL = 195

/** Too small to find on the globe without a marker. */
export const ATLAS_MARKED = [
  'Singapore',
  'Malta',
  'Luxembourg',
  'Cyprus',
  'Hong Kong',
]
