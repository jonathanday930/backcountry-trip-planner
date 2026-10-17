export interface ParkConfig {
  id: string
  name: string
  /** Subdirectory of backend/data holding this park's campsites.json and trails.geojson */
  dataDir: string
  center: [number, number]
  /** The park's own "current conditions" / trail-status page, read by the chat agent's
   * `get_trail_closures` tool as a fallback when `npsParkCode` isn't set. Optional — a park with
   * neither just gets "not configured yet". */
  trailStatusUrl?: string
  /** 4-letter NPS unit code (e.g. "glac", "yell") for parks that are actual National Park Service
   * units. When set, `get_trail_closures` uses NPS's official structured alerts feed instead of
   * `trailStatusUrl` — real closures/hazards/conditions, not scraped page text. Only NPS units have
   * one; national forests, BLM land, etc. have no equivalent shared feed and stay on the scrape
   * fallback. Find a park's code in its nps.gov URL, e.g. nps.gov/glac -> "glac". */
  npsParkCode?: string
  /** Recreation.gov permit(s) covering this park's backcountry sites, for the chat agent's
   * `check_permit_availability` tool. Some parks (e.g. Zion, Canyonlands) have more than one. */
  permits?: { id: string; label: string }[]
}

export const PARKS: ParkConfig[] = [
  {
    id: 'yellowstone',
    name: 'Yellowstone National Park',
    dataDir: 'yellowstone-national-park-backcountry-permits',
    center: [44.606, -110.4831],
    npsParkCode: 'yell',
  },
  {
    id: 'grand-canyon-full',
    name: 'Grand Canyon National Park (Full Permit System)',
    dataDir: 'grand-canyon-national-park-backcountry-permits',
    center: [36.2796, -112.7976],
    npsParkCode: 'grca',
  },
  {
    id: 'mount-rainier',
    name: 'Mount Rainier National Park',
    dataDir: 'mount-rainier-national-park-wilderness-and-climbing-permits',
    center: [46.8519, -121.7174],
    npsParkCode: 'mora',
  },
  {
    id: 'north-cascades',
    name: 'North Cascades National Park',
    dataDir: 'north-cascades-national-park-backcountry-permits',
    center: [48.6473, -121.3214],
    npsParkCode: 'noca',
  },
  {
    id: 'zion',
    name: 'Zion National Park',
    dataDir: 'zion-national-park',
    center: [37.3116, -113.0322],
    npsParkCode: 'zion',
  },
  {
    id: 'sequoia-kings-canyon',
    name: 'Sequoia & Kings Canyon National Parks',
    dataDir: 'sequoia-kings-canyon-national-parks',
    center: [36.582, -118.7361],
    npsParkCode: 'seki',
  },
  {
    id: 'joshua-tree',
    name: 'Joshua Tree National Park',
    dataDir: 'joshua-tree-national-park-wilderness-backpacking-permits',
    center: [33.5865, -115.9504],
    npsParkCode: 'jotr',
  },
  // 'inyo-national-forest' archived (not important for target market, and by far the
  // heaviest park in memory: ~1.4M-node graph + 1.5GB DEM on disk). Data left untouched at
  // backend/data/inyo-national-forest-wilderness-permits/ in case it's wanted again later.
  {
    id: 'sierra-national-forest',
    name: 'Sierra National Forest',
    dataDir: 'sierra-national-forest',
    center: [37.2486, -119.1829],
  },
  {
    id: 'rocky-mountain-full',
    name: 'Rocky Mountain National Park (Full Permit System)',
    dataDir: 'rocky-mountain-national-park-wilderness-permits',
    center: [40.3722, -105.6705],
    npsParkCode: 'romo',
  },
  {
    id: 'grand-teton',
    name: 'Grand Teton National Park',
    dataDir: 'grand-teton',
    center: [43.8029, -110.7716],
    npsParkCode: 'grte',
  },
  {
    id: 'glacier',
    name: 'Glacier National Park',
    dataDir: 'glacier',
    center: [48.6402, -113.8659],
    trailStatusUrl: 'https://www.nps.gov/glac/planyourvisit/trailstatusreports.htm',
    npsParkCode: 'glac',
    permits: [{ id: '4675321', label: 'Glacier National Park Wilderness Permits' }],
  },
  {
    id: 'olympic',
    name: 'Olympic National Park',
    dataDir: 'olympic-national-park',
    center: [48.1323, -123.8181],
    npsParkCode: 'olym',
    permits: [{ id: '4098362', label: 'Olympic National Park Wilderness Permit' }],
  },
  {
    id: 'canyonlands',
    name: 'Canyonlands National Park',
    dataDir: 'canyonlands-national-park-overnight-backcountry-permits',
    center: [38.2456, -109.8802],
    npsParkCode: 'cany',
    permits: [{ id: '4675315', label: 'Canyonlands National Park Overnight Backcountry Permits' }],
  },
  {
    id: 'yosemite',
    name: 'Yosemite National Park',
    dataDir: 'yosemite-national-park',
    center: [37.8651, -119.5383],
    npsParkCode: 'yose',
  },
]
