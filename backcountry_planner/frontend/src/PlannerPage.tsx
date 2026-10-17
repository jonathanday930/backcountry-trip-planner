import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Popup, Polyline, GeoJSON, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import type { FeatureCollection } from 'geojson'
import ChatWidget from './ChatWidget'
import { RotatedImageOverlay } from './RotatedImageOverlay'

interface Campsite {
  id: string
  name: string
  lat: number
  lon: number
  type: string
  context?: string
  closed?: boolean
  closedAsOf?: string
}

interface Park {
  id: string
  name: string
  center: [number, number]
}

interface HazardPin {
  id: string
  lat: number
  lon: number
  title: string
  description: string
  category: string
  url: string
  source: 'road-event' | 'alert-match'
}

interface UnlocatedHazard {
  title: string
  description: string
  category: string
  url: string
}

interface HazardsResult {
  pinned: HazardPin[]
  unlocated: UnlocatedHazard[]
}

interface User {
  id: string
  email: string
  name: string
  picture: string | null
}

interface SavedRoute {
  id: string
  parkId: string
  name: string
  stops: string[]
  sleepStops: string[]
  createdAt: string
}

interface RouteLeg {
  from: string
  to: string
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
  coordinates: [number, number][]
}

interface RouteResult {
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
  routeGeoJson: { type: 'LineString'; coordinates: [number, number][] }
  legs: RouteLeg[]
  customPointSnaps: {
    pointToken: string
    distanceMeters: number
    nearestTrailPoint: [number, number]
  }[]
}

interface KnownRoute {
  id: string
  name: string
  typicalNights: number
  notes: string
  stops: string[]
  campsiteStops: string[]
  campsites: { id: string; name: string; type: string; closed?: boolean }[]
  totalDistanceMiles: number
  totalElevationGainFt: number
  totalElevationLossFt: number
  legs: { from: string; to: string; distanceMiles: number; elevationGainFt: number; elevationLossFt: number }[]
}

interface StopActions {
  onSetStart: (value: string) => void
  onSetDestination: (value: string) => void
  onSetNewDestination: (value: string) => void
  onAddStop: (value: string) => void
  onRemoveStop: (index: number) => void
}

const TYPE_COLORS: Record<string, string> = {
  trailhead: '#2b6cb0',
  designated_campsite: '#2f855a',
  corridor_campground: '#dd6b20',
  at_large: '#805ad5',
}

/** Distinct hues for shaded zone polygons, so neighboring zones (e.g. Joshua Tree's 14 at-large
 * zones) are visually distinguishable instead of blending into one wash of a single color. */
const ZONE_FILL_COLORS = [
  '#e53e3e', '#dd6b20', '#d69e2e', '#38a169', '#319795', '#3182ce', '#5a67d8',
  '#805ad5', '#d53f8c', '#c05621', '#2c7a7b', '#2b6cb0', '#6b46c1', '#b83280',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function zoneColor(name: string): string {
  return ZONE_FILL_COLORS[hashString(name) % ZONE_FILL_COLORS.length]
}

/** Trail/road line style. A plain module-level function (not a closure recreated on every
 * `PlannerPage` render) so react-leaflet's `GeoJSON` sees a stable `style` prop reference and
 * never calls `layer.setStyle()` (which restyles *every* feature in the layer — 10k+ for a park
 * like Grand Canyon Full) on renders that have nothing to do with the trail network. The
 * inside/outside-boundary classification itself is precomputed once at server boot
 * (`backend/src/parkNetwork.ts`) into `properties.insideBoundary` — this used to run a
 * point-in-polygon check here on every call, which is what made the whole map lag. */
function trailStyle(feature?: { properties?: { kind?: string; insideBoundary?: boolean } }): L.PathOptions {
  if (feature?.properties?.kind !== 'road') {
    return { color: '#e67e22', weight: 3, opacity: 0.85, dashArray: '6,5' }
  }
  return feature.properties.insideBoundary === false
    ? { color: '#9a9a9a', weight: 2, opacity: 0.45 }
    : { color: '#7a5230', weight: 3, opacity: 0.85 }
}

/** Zone shading style — same stable-reference rationale as `trailStyle`. */
function zoneStyle(feature?: { properties?: { name?: string } }): L.PathOptions {
  const color = zoneColor(feature?.properties?.name ?? '')
  return { color: '#1a202c', weight: 1.5, opacity: 0.75, fillColor: color, fillOpacity: 0.28 }
}

const TYPE_LABELS: Record<string, string> = {
  trailhead: 'Trailhead',
  designated_campsite: 'Designated campsite',
  corridor_campground: 'Corridor campground',
  at_large: 'At-large camping area',
}

/** NPS alert/road-event categories, from most to least severe. Anything not in this map (NPS
 * adds new category strings occasionally) falls back to the Information color. */
const HAZARD_COLORS: Record<string, string> = {
  'Park Closure': '#b42318',
  Danger: '#e53e3e',
  Caution: '#dd6b20',
  Information: '#3182ce',
}
const HAZARD_FALLBACK_COLOR = '#3182ce'

function hazardColor(category: string): string {
  return HAZARD_COLORS[category] ?? HAZARD_FALLBACK_COLOR
}

/** Trailheads are the natural starting point for most trips, so they're listed first in the starting-point search. */
const STARTING_POINT_TYPE_ORDER = ['trailhead', 'designated_campsite', 'corridor_campground', 'at_large']

/** Each additional stop costs another shortest-path + live elevation lookup, so routes are capped well short of unusable. */
const MAX_STOPS = 25
const METERS_TO_MILES = 1 / 1609.344

function CampsiteOption({ campsite }: { campsite: Campsite }) {
  return (
    <>
      <span>{campsite.name}</span>
      {campsite.closed && <span className="closed-badge">Closed</span>}
    </>
  )
}

/** Cached by (color, highlighted) — there are only ever a handful of distinct combinations (one
 * per campsite type, times highlighted/not), so building a fresh `L.divIcon` on every render of
 * every marker (as this used to do) just means Leaflet's marker hook calls `setIcon()` — and
 * swaps DOM nodes — for every visible campsite on every unrelated re-render (a search keystroke,
 * a drag-reorder, a route resolving), for no reason: the icon for a given (color, highlighted)
 * pair never actually changes. */
const markerIconCache = new Map<string, L.DivIcon>()

function markerIcon(color: string, highlighted: boolean): L.DivIcon {
  const key = `${color}|${highlighted}`
  const cached = markerIconCache.get(key)
  if (cached) return cached
  const size = highlighted ? 20 : 14
  const border = highlighted ? '3px solid #1a73e8' : '2px solid white'
  const icon = L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border};box-shadow:0 0 3px rgba(0,0,0,0.6);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
  markerIconCache.set(key, icon)
  return icon
}

/** A large green flag used to mark the route's starting point, so it stands out from ordinary stop markers. */
function flagIconHtml(fill: string, stroke: string) {
  return `<svg width="36" height="36" viewBox="0 0 36 36" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));">
    <line x1="8" y1="4" x2="8" y2="33" stroke="#1a4d2e" stroke-width="3" stroke-linecap="round"/>
    <path d="M8 5 L31 12 L8 19 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`
}

const START_FLAG_ICON = L.divIcon({
  className: '',
  html: flagIconHtml('#22c55e', '#15803d'),
  iconSize: [36, 36],
  iconAnchor: [8, 33],
})

const DESTINATION_FLAG_ICON = L.divIcon({
  className: '',
  html: flagIconHtml('#e34948', '#a82c2b'),
  iconSize: [36, 36],
  iconAnchor: [8, 33],
})

/** A warning-triangle marker for park hazards/closures — deliberately distinct from the round
 * campsite/stop pins so a hazard reads as "not a place you're planning to visit" at a glance. */
function hazardIconHtml(fill: string): string {
  return `<svg width="28" height="28" viewBox="0 0 28 28" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));">
    <path d="M14 2 L26 24 L2 24 Z" fill="${fill}" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="14" y1="10" x2="14" y2="17" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="14" cy="20.5" r="1.6" fill="#fff"/>
  </svg>`
}

const hazardIconCache = new Map<string, L.DivIcon>()
function hazardIcon(color: string): L.DivIcon {
  const cached = hazardIconCache.get(color)
  if (cached) return cached
  const icon = L.divIcon({ className: '', html: hazardIconHtml(color), iconSize: [28, 28], iconAnchor: [14, 24] })
  hazardIconCache.set(color, icon)
  return icon
}

/**
 * Colors for successive days of a multi-day trek, applied to the route once via-stops are marked
 * as overnight stays. Fixed order from the validated categorical palette (dataviz skill); Day 1's
 * blue is a deliberate change from the old single-color red route line — red is now reserved for
 * the destination flag. Beyond 8 days the sequence repeats.
 */
const DAY_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']

function dayColor(day: number): string {
  return DAY_COLORS[day % DAY_COLORS.length]
}

/** Small flag icon used in the stop list next to the start/destination rows. */
function FlagIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <line x1="5" y1="2" x2="5" y2="22" stroke="#555" strokeWidth="2" strokeLinecap="round" />
      <path d="M5 3 L20 8 L5 13 Z" fill={color} />
    </svg>
  )
}

/** Tent icon shown on a via-stop row — on hover as a preview, permanently once marked as an overnight stay. */
function TentIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 L22 20 H2 Z" fill={color} />
      <path d="M9.3 20 L12 10.5 L14.7 20 Z" fill="white" fillOpacity="0.55" />
    </svg>
  )
}

const DEFAULT_MAP_CENTER: [number, number] = [39, -105.5]

interface ZoneMapOverlayConfig {
  url: string
  topLeft: [number, number]
  topRight: [number, number]
  bottomLeft: [number, number]
}

/** Scanned official zone maps, georeferenced against known trailhead coordinates: the pixel
 * position of each map's "B" (backcountry trailhead board) icons was matched against the lat/lon
 * of our own `type: 'trailhead'` campsites for that park (10 correspondences for Joshua Tree —
 * every trailhead-typed campsite that has a matching icon on the scan), then fit to a 3-corner
 * affine (see `RotatedImageOverlay`) rather than an axis-aligned rectangle, since the scan has a
 * slight rotation/skew a rectangle can't absorb. An alternative to `zones.geojson` shading for
 * parks where our own zone polygons are still inaccurate. */
const ZONE_MAP_OVERLAYS: Record<string, ZoneMapOverlayConfig> = {
  'joshua-tree': {
    url: '/zone-overlays/joshua-tree.jpg',
    topLeft: [34.24101, -116.51484],
    topRight: [34.2265, -115.18998],
    bottomLeft: [33.6046, -116.52248],
  },
  /* NPS "Backcountry Use Area Map" (nps.gov/grca/planyourvisit/upload/useAreaMap.pdf). This is an
   * ArcMap export with real text objects, so `pdftotext -bbox` cheaply finds every use-area code
   * label (e.g. `SE1`, `BL7`) and its approximate location, no manual pixel-picking needed — but the
   * label's own bounding box is NOT the correspondence point: ArcMap offsets each label from its
   * campsite pictogram (a black square with a white tent glyph) by a park-wide-but-not-identical
   * amount, in whichever direction avoids overlapping neighboring labels — up-left for most of the
   * `BL`/`BM` corridor cluster, but e.g. straight down for `BF5` (Horseshoe Mesa). Fitting on label
   * position directly baked that offset into the affine as noise: 18 correspondences (only the small
   * blue "Designated Campsite" codes — matched against `campsites.json` names containing "Campsite" —
   * since the large black/red "At-Large Camping" zone codes like `AA9`/`BO9` mark wherever the
   * cartographer had room in a use area sometimes several km across, not a point) gave a 165m mean /
   * 851m worst residual. Detecting each pictogram directly — threshold near-black pixels on the
   * 300dpi source raster, connected-component label, keep ~33x33px blobs with fill ratio ~0.69 (the
   * tent cutout), nearest-neighbor match each to its label's `pdftotext` position — and fitting on
   * *those* centroids instead dropped it to 81m mean / 193m worst, `BL6` itself down to 17m. */
  'grand-canyon-full': {
    url: '/zone-overlays/grand-canyon-full.jpg',
    topLeft: [36.493939, -112.897912],
    topRight: [36.503047, -111.679555],
    bottomLeft: [35.914191, -112.889379],
  },
  /* NPS "Backcountry Camping Zones and Sites" map (nps.gov/grte/planyourvisit/upload/
   * grte_backcountry_map_2012.jpg). 6 correspondences: the filled-circle trailhead icon for
   * every `type: 'trailhead'` campsite whose icon could be pinned down unambiguously. Two
   * trailheads (Leigh Lake, String Lake) sit only ~660m apart in reality but compress to ~15px
   * on this scan — too tight to reliably distinguish which icon is which, so only one of that
   * pair was kept rather than risk a mismatched correspondence.
   *
   * Unlike Joshua Tree/Grand Canyon above, this map's own printed North arrow points exactly
   * straight up — a simple single-page reference map, not a rotated/skewed scan — so fitting a
   * full 3-corner affine here just let pixel-picking noise masquerade as a false rotation
   * (visibly tilted overlay, first attempt: `topRight`'s latitude differed from `topLeft`'s).
   * Fit `lon` against `px` and `lat` against `py` independently instead (decoupled, no
   * cross-term), which can't produce spurious rotation/shear, then use the same `topLeft` lon/lat
   * for `bottomLeft`/lat for `topRight` to force true right angles. 161m mean / 255m worst
   * residual — a bit looser than the other two since the axis-aligned fit has less freedom to
   * absorb pixel-picking noise, but correct in orientation, which matters more here. Still had a
   * consistent ~146m residual bias in one direction after that (visible as the scan's own
   * trailhead icon sitting off-center from our real marker) — measured precisely via Leaflet's
   * own `containerPointToLatLng` at a fixed zoom (comparing the known marker latlng against the
   * icon's pixel centroid, found by color-thresholding + eroding away the trail-line it touches)
   * rather than re-picking more source pixels, and applied as a uniform correction to all three
   * corners below. */
  'grand-teton': {
    url: '/zone-overlays/grand-teton.jpg',
    topLeft: [44.1383, -110.98212],
    topRight: [44.1383, -110.41473],
    bottomLeft: [43.52985, -110.98212],
  },
  /* Official NPS "Backcountry Map" (nps.gov/glac/planyourvisit/upload/
   * Wilderness-Campground-Map-2024_accessible.pdf, also mirrored by cleverhiker.com) — a
   * hand-illustrated schematic, not a GIS-drafted map like the others above. 55 correspondences
   * (every `designated_campsite`'s black triangle icon, auto-detected by color-blob connected-
   * component labeling on the cropped scan, matched to real coordinates via a bootstrap affine,
   * same technique as Joshua Tree/Grand Canyon) gave only ~1.5km median / several km worst
   * residual, confirmed NOT a matching artifact: pairwise on-map distances between icons are
   * internally consistent (~8% CV against real distances), so this is the icons' own hand-placed
   * schematic wobble on the source artwork itself, not a fittable error. Checked for a better
   * source first — the official NPS PDF turned out to be the identical artwork (same illustration,
   * not independently surveyed), and no ArcGIS/GIS layer exists publicly for these permit-zone
   * boundaries specifically. Ship anyway per explicit user call: useful as a rough visual
   * reference, but don't expect it to align tightly with our own trails/campsites data the way
   * the other parks' overlays do.
   */
  glacier: {
    url: '/zone-overlays/glacier.jpg',
    topLeft: [49.01323, -114.54639],
    topRight: [49.02576, -113.20823],
    bottomLeft: [48.19928, -114.53959],
  },
  /* Official NPS Yosemite Wilderness Trailheads map (wildernesstrailheads.pdf). This is a
   * geographic park map with trailhead-specific dispersed-camping arrows, not a GIS zone
   * polygon layer; keep it as a visual permit-planning reference and do not treat its arrows
   * as exact campsite boundaries. Corners are aligned to the map's surrounding Yosemite extent. */
  yosemite: {
    url: '/zone-overlays/yosemite-trailheads.jpg',
    topLeft: [38.17699, -120.16089],
    topRight: [38.17699, -118.82269],
    bottomLeft: [37.32052, -120.16089],
  },
}

/** Our own generated zone polygons are still being tuned; keep them fetched (harmless) but
 * hidden while `ZONE_MAP_OVERLAYS` is being A/B tested against them. */
const SHOW_GENERATED_ZONES = false

/** A stop is either a known campsite id, or a raw "lat,lon" point the user clicked on the map. */
const RAW_POINT_RE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/

function parseRawPoint(stopValue: string): { lat: number; lon: number } | null {
  const match = stopValue.match(RAW_POINT_RE)
  if (!match) return null
  return { lat: Number(match[1]), lon: Number(match[2]) }
}

function stopLabel(stopValue: string, campsiteById: Map<string, Campsite>): string {
  const campsite = campsiteById.get(stopValue)
  if (campsite) return campsite.name
  const raw = parseRawPoint(stopValue)
  if (raw) return `Custom point (${raw.lat.toFixed(4)}, ${raw.lon.toFixed(4)})`
  return stopValue
}

/**
 * Fits the map to all campsites once they load, padding the left edge so markers don't land
 * under the sidebar. Also caps how far out the map can be zoomed/panned — a generously-padded
 * box around the park's campsites, rather than the whole state/country — and locks panning to
 * that same area so the view stays focused on the park.
 */
function FitBoundsToCampsites({ campsites }: { campsites: Campsite[] }) {
  const map = useMap()
  useEffect(() => {
    if (campsites.length === 0) return
    const bounds = L.latLngBounds(campsites.map((c) => [c.lat, c.lon] as [number, number]))
    map.fitBounds(bounds, { paddingTopLeft: [40, 40], paddingBottomRight: [40, 40] })

    const maxBounds = bounds.pad(0.5)
    map.setMaxBounds(maxBounds)
    map.setMinZoom(map.getBoundsZoom(maxBounds))
  }, [campsites, map])
  return null
}

/** Renders a `ZoneMapOverlayConfig` via `RotatedImageOverlay` (see that file for why a plain
 * react-leaflet `<ImageOverlay>` rectangle isn't warped enough to line up a scanned paper map). */
function ZoneMapOverlayLayer({ overlay, opacity }: { overlay: ZoneMapOverlayConfig; opacity: number }) {
  const map = useMap()
  useEffect(() => {
    const layer = new RotatedImageOverlay(overlay.url, overlay.topLeft, overlay.topRight, overlay.bottomLeft, {
      opacity,
    })
    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, overlay, opacity])
  return null
}

/**
 * Lets the user click any spot on the map to open a "custom point" popup for it — but if a card
 * (campsite or custom-point popup) is already open, the first blank-map click should just close
 * it rather than immediately opening a new one in its place. `preclick` fires before Leaflet's own
 * popup auto-close logic runs, so it's used to snapshot "was something open" ahead of that.
 */
function MapClickHandler({ onPick, onDismissPending }: { onPick: (lat: number, lon: number) => void; onDismissPending: () => void }) {
  const popupOpenRef = useRef(false)
  const suppressNextClickRef = useRef(false)

  useMapEvents({
    popupopen() {
      popupOpenRef.current = true
    },
    popupclose() {
      popupOpenRef.current = false
    },
    preclick() {
      suppressNextClickRef.current = popupOpenRef.current
    },
    click(e) {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        onDismissPending()
        return
      }
      onPick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

/** The Set as start / Add to route / Set as (new) destination buttons shown in every marker popup. */
function StopActionButtons({
  value,
  stops,
  onSetStart,
  onSetDestination,
  onSetNewDestination,
  onAddStop,
  onRemoveStop,
  onDone,
}: StopActions & { value: string; stops: (string | null)[]; onDone: () => void }) {
  const stopIndex = stops.indexOf(value)
  const isSelected = stopIndex !== -1
  const isStart = stops[0] === value
  const isDestination = stops[stops.length - 1] === value
  const destinationSet = stops[stops.length - 1] !== null
  const atStopLimit = stops.length >= MAX_STOPS
  return (
    <div className="popup-actions">
      <button
        disabled={isStart}
        onClick={() => {
          onSetStart(value)
          onDone()
        }}
      >
        Set as start
      </button>
      {destinationSet && (
        <button
          disabled={atStopLimit}
          title={atStopLimit ? `Routes are limited to ${MAX_STOPS} stops` : undefined}
          onClick={() => {
            onAddStop(value)
            onDone()
          }}
        >
          Add to route
        </button>
      )}
      {destinationSet ? (
        <button
          disabled={isDestination || atStopLimit}
          title={atStopLimit ? `Routes are limited to ${MAX_STOPS} stops` : undefined}
          onClick={() => {
            onSetNewDestination(value)
            onDone()
          }}
        >
          Set as new destination
        </button>
      ) : (
        <button
          disabled={isDestination}
          onClick={() => {
            onSetDestination(value)
            onDone()
          }}
        >
          Set as destination
        </button>
      )}
      {isSelected && (
        <button
          className="popup-remove"
          onClick={() => {
            onRemoveStop(stopIndex)
            onDone()
          }}
        >
          Remove waypoint
        </button>
      )}
    </div>
  )
}

function HazardMarker({ hazard }: { hazard: HazardPin }) {
  return (
    <Marker position={[hazard.lat, hazard.lon]} icon={hazardIcon(hazardColor(hazard.category))}>
      <Popup>
        <strong>{hazard.title}</strong>
        <br />
        <span className="popup-type">{hazard.category}</span>
        {hazard.source === 'alert-match' && (
          <>
            <br />
            <span className="popup-hazard-approx">Approximate location, matched automatically — not an official NPS pin.</span>
          </>
        )}
        {hazard.description && (
          <>
            <br />
            {hazard.description}
          </>
        )}
        {hazard.url && (
          <>
            <br />
            <a href={hazard.url} target="_blank" rel="noreferrer">
              View official NPS alert
            </a>
          </>
        )}
      </Popup>
    </Marker>
  )
}

function CampsiteMarker({
  campsite,
  stops,
  highlighted,
  actions,
}: {
  campsite: Campsite
  stops: (string | null)[]
  highlighted: boolean
  actions: StopActions
}) {
  const markerRef = useRef<L.Marker>(null)
  const isStart = stops[0] === campsite.id
  const isDestination = stops[stops.length - 1] === campsite.id
  const icon = isStart
    ? START_FLAG_ICON
    : isDestination
      ? DESTINATION_FLAG_ICON
      : markerIcon(TYPE_COLORS[campsite.type] ?? '#666', highlighted)
  return (
    <Marker
      position={[campsite.lat, campsite.lon]}
      icon={icon}
      zIndexOffset={isStart || isDestination ? 1000 : 0}
      ref={markerRef}
    >
      <Popup>
        <strong>{campsite.name}</strong>
        <br />
        <span className="popup-type">{TYPE_LABELS[campsite.type] ?? campsite.type}</span>
        {campsite.closed && (
          <>
            <br />
            <span className="popup-closure">Currently marked closed{campsite.closedAsOf ? ` (checked ${campsite.closedAsOf})` : ''}</span>
          </>
        )}
        {campsite.context && (
          <>
            <br />
            {campsite.context}
          </>
        )}
        <StopActionButtons value={campsite.id} stops={stops} {...actions} onDone={() => markerRef.current?.closePopup()} />
      </Popup>
    </Marker>
  )
}

/** A raw lat/lon stop already selected on the route (not a known campsite). */
function SelectedPointMarker({
  value,
  lat,
  lon,
  stops,
  actions,
}: {
  value: string
  lat: number
  lon: number
  stops: (string | null)[]
  actions: StopActions
}) {
  const markerRef = useRef<L.Marker>(null)
  const isStart = stops[0] === value
  const isDestination = stops[stops.length - 1] === value
  const icon = isStart ? START_FLAG_ICON : isDestination ? DESTINATION_FLAG_ICON : markerIcon('#4a5568', true)
  return (
    <Marker position={[lat, lon]} icon={icon} zIndexOffset={isStart || isDestination ? 1000 : 0} ref={markerRef}>
      <Popup>
        Custom point
        <br />
        {lat.toFixed(5)}, {lon.toFixed(5)}
        <StopActionButtons value={value} stops={stops} {...actions} onDone={() => markerRef.current?.closePopup()} />
      </Popup>
    </Marker>
  )
}

function PendingPointMarker({
  point,
  stops,
  actions,
  onDismiss,
}: {
  point: { lat: number; lon: number }
  stops: (string | null)[]
  actions: StopActions
  onDismiss: () => void
}) {
  const markerRef = useRef<L.Marker>(null)

  useEffect(() => {
    markerRef.current?.openPopup()
  }, [point])

  const value = `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`

  return (
    <Marker position={[point.lat, point.lon]} icon={markerIcon('#4a5568', false)} ref={markerRef}>
      <Popup eventHandlers={{ remove: onDismiss }}>
        Custom point
        <br />
        {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
        <StopActionButtons
          value={value}
          stops={stops}
          {...actions}
          onDone={() => {
            markerRef.current?.closePopup()
            onDismiss()
          }}
        />
      </Popup>
    </Marker>
  )
}

export default function PlannerPage() {
  const { parkId } = useParams<{ parkId: string }>()
  const navigate = useNavigate()

  const [parks, setParks] = useState<Park[]>([])
  const [campsites, setCampsites] = useState<Campsite[]>([])
  const [trails, setTrails] = useState<FeatureCollection | null>(null)
  const [zones, setZones] = useState<FeatureCollection | null>(null)
  const [showZoneMapOverlay, setShowZoneMapOverlay] = useState(true)
  const [hazards, setHazards] = useState<HazardsResult | null>(null)
  const [showParkAlerts, setShowParkAlerts] = useState(false)
  const [stops, setStops] = useState<(string | null)[]>([null, null])
  const [pendingPoint, setPendingPoint] = useState<{ lat: number; lon: number } | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [searchText, setSearchText] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  /** Via-stop values (not indices, so marks survive reordering/add/remove) marked as an overnight stay. */
  const [sleepStops, setSleepStops] = useState<Set<string>>(new Set())

  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [view, setView] = useState<'planner' | 'explore' | 'routes'>('planner')
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [savedRoutesLoading, setSavedRoutesLoading] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  /** Set right before switching parks to load a saved route, so the park-switch effect applies
   * these stops (and which of them are overnight stays) instead of resetting to blank. */
  const [pendingLoadRoute, setPendingLoadRoute] = useState<{ stops: string[]; sleepStops: string[] } | null>(null)
  const [knownRoutes, setKnownRoutes] = useState<KnownRoute[]>([])
  const [knownRoutesLoading, setKnownRoutesLoading] = useState(false)
  const [knownRoutesError, setKnownRoutesError] = useState<string | null>(null)
  const [selectedKnownRouteId, setSelectedKnownRouteId] = useState<string | null>(null)
  const [previewRoute, setPreviewRoute] = useState<RouteResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    fetch('/api/parks')
      .then((res) => res.json())
      .then((data: Park[]) => setParks(data))
      .catch(() => setError('Failed to load parks from the server.'))

    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true))
  }, [])

  // If the park in the URL isn't a real park once the list loads, bounce back to the homepage.
  useEffect(() => {
    if (parks.length === 0) return
    if (!parks.some((p) => p.id === parkId)) navigate('/')
  }, [parks, parkId, navigate])

  useEffect(() => {
    const park = parks.find((p) => p.id === parkId)
    document.title = park ? `${park.name} Trip Planner` : 'Backcountry Trip Planner'
  }, [parks, parkId])

  useEffect(() => {
    if (!parkId || parks.length === 0 || !parks.some((p) => p.id === parkId)) return
    setPendingPoint(null)
    setRoute(null)
    setLoading(false)
    setError(null)
    setEditingIndex(null)
    setSaveStatus('idle')
    setSaveName('')
    setKnownRoutes([])
    setKnownRoutesError(null)
    setSelectedKnownRouteId(null)
    setPreviewRoute(null)
    setPreviewLoading(false)
    if (pendingLoadRoute) {
      setStops(pendingLoadRoute.stops)
      setSleepStops(new Set(pendingLoadRoute.sleepStops))
      setPendingLoadRoute(null)
    } else {
      setStops([null, null])
      setSleepStops(new Set())
    }
    fetch(`/api/campsites?park=${parkId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad response'))))
      .then(setCampsites)
      .catch(() => setError('Failed to load campsites from the server.'))
    fetch(`/api/trails?park=${parkId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad response'))))
      .then(setTrails)
      .catch(() => {
        /* trail overlay is a nice-to-have; routing still works without it */
      })
    fetch(`/api/zones?park=${parkId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad response'))))
      .then(setZones)
      .catch(() => {
        /* zone overlay is a nice-to-have; not every park has mapped zone boundaries */
      })
    setHazards(null)
    setShowParkAlerts(false)
    fetch(`/api/hazards?park=${parkId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad response'))))
      .then(setHazards)
      .catch(() => {
        /* hazard layer is a nice-to-have; only National Park Service units have it at all */
      })
  }, [parkId, parks])

  function loadSavedRoutes() {
    setSavedRoutesLoading(true)
    fetch('/api/saved-routes')
      .then((res) => (res.ok ? res.json() : []))
      .then(setSavedRoutes)
      .catch(() => setSavedRoutes([]))
      .finally(() => setSavedRoutesLoading(false))
  }

  function loadKnownRoutes() {
    if (!parkId) return
    setKnownRoutesLoading(true)
    setKnownRoutesError(null)
    fetch(`/api/known-routes?park=${encodeURIComponent(parkId)}`)
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? 'Failed to load known routes')
        return body
      })
      .then((data: { routes: KnownRoute[] }) => setKnownRoutes(data.routes))
      .catch((err) => setKnownRoutesError(err.message))
      .finally(() => setKnownRoutesLoading(false))
  }

  function openView(next: 'planner' | 'explore' | 'routes') {
    setView(next)
    if (next === 'routes' && user) loadSavedRoutes()
    if (next === 'explore' && knownRoutes.length === 0 && !knownRoutesLoading) loadKnownRoutes()
  }

  function previewKnownRoute(knownRoute: KnownRoute) {
    setSelectedKnownRouteId(knownRoute.id)
    setPreviewLoading(true)
    setPreviewRoute(null)
    fetch(`/api/route?park=${encodeURIComponent(parkId ?? '')}&stops=${knownRoute.stops.map(encodeURIComponent).join('|')}`)
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? 'Preview could not be computed')
        return body as RouteResult
      })
      .then(setPreviewRoute)
      .catch(() => setPreviewRoute(null))
      .finally(() => setPreviewLoading(false))
  }

  function planKnownRoute(knownRoute: KnownRoute) {
    setStops(knownRoute.stops)
    setSleepStops(new Set())
    setPreviewRoute(null)
    setSelectedKnownRouteId(null)
    setView('planner')
  }

  function openSavedRoute(saved: SavedRoute) {
    setView('planner')
    if (saved.parkId === parkId) {
      setStops(saved.stops)
      setSleepStops(new Set(saved.sleepStops))
    } else {
      setPendingLoadRoute({ stops: saved.stops, sleepStops: saved.sleepStops })
      navigate(`/park/${saved.parkId}`)
    }
  }

  function deleteSavedRoute(id: string) {
    setSavedRoutes((prev) => prev.filter((r) => r.id !== id))
    fetch(`/api/saved-routes/${id}`, { method: 'DELETE' }).catch(() => loadSavedRoutes())
  }

  function saveCurrentRoute() {
    const stopIds = stops.filter((s): s is string => s !== null)
    if (!saveName.trim() || stopIds.length < 2 || !parkId) return
    setSaveStatus('saving')
    fetch('/api/saved-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parkId, name: saveName.trim(), stops: stopIds, sleepStops: [...sleepStops] }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('save failed')
        setSaveStatus('saved')
        setSaveName('')
      })
      .catch(() => setSaveStatus('idle'))
  }

  function signOut() {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(() => setUser(null))
      .catch(() => setUser(null))
  }

  const campsiteById = useMemo(() => new Map(campsites.map((c) => [c.id, c])), [campsites])
  const zoneMapOverlay = parkId ? ZONE_MAP_OVERLAYS[parkId] : undefined
  /** Whether this park has any road tagged outside its boundary (see `trailStyle`/`parkNetwork.ts`) — controls the legend entry. */
  const hasOutsideRoads = useMemo(
    () => trails?.features.some((f) => f.properties?.kind === 'road' && f.properties?.insideBoundary === false) ?? false,
    [trails],
  )

  useEffect(() => {
    const stopIds = stops.filter((s): s is string => s !== null)
    if (!parkId || stopIds.length < 2 || stopIds.length !== stops.length) {
      setRoute(null)
      setLoading(false)
      return
    }
    // Guards against out-of-order responses: e.g. switching to a saved route in a different park
    // changes `parkId` and `stops` in separate renders, so a transient (stale-stops, new-park)
    // request can briefly fire, 400, and — if that fast error response arrives after a slower but
    // correct one — clobber the valid result. Once this effect reruns (deps changed again), the
    // cleanup below marks this run's callbacks as stale so they no longer touch state.
    let cancelled = false
    setLoading(true)
    setError(null)
    setRoute(null)
    fetch(`/api/route?park=${parkId}&stops=${stopIds.map(encodeURIComponent).join('|')}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? 'Failed to compute route')
        }
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setRoute(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [stops, parkId])

  function setAsStart(value: string) {
    setStops((prev) => {
      const next = [...prev]
      next[0] = value
      return next
    })
  }

  function changePark(nextParkId: string) {
    if (nextParkId === parkId) return
    const hasPlan = stops.some((stop) => stop !== null)
    if (hasPlan && !window.confirm('Switch parks? Your current route will be cleared.')) return
    navigate(`/park/${nextParkId}`)
  }

  function setAsDestination(value: string) {
    setStops((prev) => {
      const next = [...prev]
      next[next.length - 1] = value
      return next
    })
  }

  /** Appends a new destination after the current one, keeping the old destination in the route as a
   * via-stop rather than overwriting it. */
  function setAsNewDestination(value: string) {
    setStops((prev) => {
      if (prev.length >= MAX_STOPS) return prev
      return [...prev, value]
    })
  }

  function addAsStop(value: string) {
    setStops((prev) => {
      if (prev.length >= MAX_STOPS) return prev
      const next = [...prev]
      next.splice(next.length - 1, 0, value)
      return next
    })
  }

  /** Appends a blank stop after the current destination — it becomes the new destination, and the
   * old destination becomes a via-stop. Opens its search box right away. */
  function addBlankStop() {
    if (stops.length >= MAX_STOPS) return
    const newIndex = stops.length
    setStops((prev) => {
      if (prev.length >= MAX_STOPS) return prev
      return [...prev, null]
    })
    startEditing(newIndex)
  }

  const stopActions: StopActions = {
    onSetStart: setAsStart,
    onSetDestination: setAsDestination,
    onSetNewDestination: setAsNewDestination,
    onAddStop: addAsStop,
    onRemoveStop: clearOrRemoveStop,
  }

  function setSlot(index: number, value: string | null) {
    setStops((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }

  /** Endpoints (start/destination) are cleared in place; via-stops in the middle are removed entirely. */
  function clearOrRemoveStop(index: number) {
    if (index === 0 || index === stops.length - 1) {
      setSlot(index, null)
    } else {
      setStops((prev) => prev.filter((_, i) => i !== index))
    }
  }

  function toggleSleepStop(value: string) {
    setSleepStops((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  /** Moves the stop at `from` to position `to`, shifting the rest — used by drag-and-drop reordering.
   * Whichever stop ends up at index 0 or at the end automatically becomes the new start/destination,
   * since those roles are derived from position rather than tracked separately. */
  function moveStop(from: number, to: number) {
    setStops((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setEditingIndex(null)
  }

  function handleStopDragStart(index: number, e: DragEvent) {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }

  function handleStopDragOver(index: number, e: DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragIndex === null || dragIndex === index) return
    setDragOverIndex(index)
  }

  function handleStopDrop(index: number, e: DragEvent) {
    e.preventDefault()
    if (dragIndex !== null && dragIndex !== index) moveStop(dragIndex, index)
    setDragIndex(null)
    setDragOverIndex(null)
  }

  function handleStopDragEnd() {
    setDragIndex(null)
    setDragOverIndex(null)
  }

  function startEditing(index: number) {
    setEditingIndex(index)
    setSearchText('')
  }

  const searchResults = useMemo(() => {
    if (editingIndex === null || editingIndex === 0) return []
    const q = searchText.trim().toLowerCase()
    const results = q ? campsites.filter((c) => c.name.toLowerCase().includes(q)) : campsites
    return results.slice(0, 8)
  }, [editingIndex, searchText, campsites])

  /** For the initial stop, trailheads are the natural starting point, so they're grouped first,
   * then the rest of the campsite types, each under its own labeled heading. */
  const startSearchGroups = useMemo(() => {
    if (editingIndex !== 0) return []
    const q = searchText.trim().toLowerCase()
    const matches = q ? campsites.filter((c) => c.name.toLowerCase().includes(q)) : campsites
    return STARTING_POINT_TYPE_ORDER.map((type) => ({
      type,
      label: TYPE_LABELS[type] ?? type,
      items: matches.filter((c) => c.type === type).slice(0, 8),
    })).filter((group) => group.items.length > 0)
  }, [editingIndex, searchText, campsites])

  /** Indices (within `stops`) of via-stops marked as an overnight stay — each one ends a "day" of the trek. */
  const sleepBreakIndices = useMemo(() => {
    const idxs: number[] = []
    for (let i = 1; i < stops.length - 1; i++) {
      const value = stops[i]
      if (value && sleepStops.has(value)) idxs.push(i)
    }
    return idxs
  }, [stops, sleepStops])

  /** Plain-text summary of the current route, sent as chat context — cheap context injection, not RAG.
   * Includes per-leg and total distance/elevation once the route has been computed. */
  const routeSummary = useMemo(() => {
    const stopIds = stops.filter((s): s is string => s !== null)
    if (stopIds.length < 2 || stopIds.length !== stops.length) return undefined

    const stopLabels = stopIds.map((stopId, i) => {
      const label = stopLabel(stopId, campsiteById)
      if (i === 0) return `${label} (Start)`
      if (i === stopIds.length - 1) return `${label} (End)`
      return sleepStops.has(stopId) ? `${label} (overnight)` : label
    })

    const dayCount = sleepBreakIndices.length + 1
    const dayPart = dayCount > 1 ? `, ${dayCount} days` : ''

    if (!route) {
      return `${stopLabels.join(' → ')}, ${stopIds.length} stops${dayPart}`
    }

    const legParts = route.legs.map(
      (leg, i) =>
        `${stopLabels[i]} → ${stopLabels[i + 1]}: ${leg.distanceMiles.toFixed(1)}mi, +${Math.round(leg.elevationGainFt)}/-${Math.round(leg.elevationLossFt)}ft`,
    )

    return `${legParts.join('; ')}. Total: ${stopIds.length} stops${dayPart}, ${route.distanceMiles.toFixed(1)}mi, +${Math.round(route.elevationGainFt)}/-${Math.round(route.elevationLossFt)}ft`
  }, [stops, sleepStops, campsiteById, sleepBreakIndices, route])

  /** Which day (0-indexed) the leg connecting stop[legIndex] to stop[legIndex + 1] falls on. */
  function dayIndexForLeg(legIndex: number): number {
    let day = 0
    for (const breakIndex of sleepBreakIndices) {
      if (legIndex >= breakIndex) day++
    }
    return day
  }

  /** Route legs grouped into per-day polylines (lat,lng) for map rendering, split at overnight stays. */
  const dayPolylines = useMemo<[number, number][][]>(() => {
    if (!route) return []
    const groups: [number, number][][] = []
    route.legs.forEach((leg, legIndex) => {
      const day = dayIndexForLeg(legIndex)
      if (!groups[day]) groups[day] = []
      const legLatLngs: [number, number][] = leg.coordinates.map(([lon, lat]) => [lat, lon])
      const tail = groups[day][groups[day].length - 1]
      const head = legLatLngs[0]
      if (tail && head && tail[0] === head[0] && tail[1] === head[1]) {
        groups[day].push(...legLatLngs.slice(1))
      } else {
        groups[day].push(...legLatLngs)
      }
    })
    return groups
  }, [route, sleepBreakIndices])

  /** Per-day distance/elevation subtotals, for the day-by-day breakdown in the results panel. */
  const dayTotals = useMemo(() => {
    if (!route) return []
    const totals: { distanceMiles: number; elevationGainFt: number; elevationLossFt: number; legs: RouteLeg[] }[] = []
    route.legs.forEach((leg, legIndex) => {
      const day = dayIndexForLeg(legIndex)
      if (!totals[day]) totals[day] = { distanceMiles: 0, elevationGainFt: 0, elevationLossFt: 0, legs: [] }
      totals[day].distanceMiles += leg.distanceMiles
      totals[day].elevationGainFt += leg.elevationGainFt
      totals[day].elevationLossFt += leg.elevationLossFt
      totals[day].legs.push(leg)
    })
    return totals
  }, [route, sleepBreakIndices])

  const selectedClosedSites = useMemo(
    () => stops.map((stop) => (stop ? campsiteById.get(stop) : undefined)).filter((site): site is Campsite => !!site?.closed),
    [stops, campsiteById],
  )

  const previewPolyline = useMemo<[number, number][]>(() => {
    if (!previewRoute) return []
    return previewRoute.legs.flatMap((leg, index) => {
      const points = leg.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])
      return index > 0 && points.length > 0 ? points.slice(1) : points
    })
  }, [previewRoute])

  return (
    <div className="app">
      <div className="sidebar">
        <div className="top-row">
          <a className="home-link" href="#/" onClick={(e) => { e.preventDefault(); navigate('/') }} aria-label="Back to homepage">
            &larr;
          </a>
          <select className="park-select" value={parkId ?? ''} onChange={(e) => changePark(e.target.value)}>
            {parks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {authChecked && (
            <div className="auth-box">
              {user ? (
                <div className="user-chip">
                  {user.picture && <img src={user.picture} alt="" className="user-avatar" />}
                  <span className="user-name">{user.name}</span>
                  <button className="link-button" onClick={signOut}>
                    Log out
                  </button>
                </div>
              ) : (
                <a className="sign-in-link" href="/api/auth/google">
                  Sign in with Google
                </a>
              )}
            </div>
          )}
        </div>
        <p className="subtitle">Backcountry trip planner &mdash; on-trail distance &amp; elevation</p>

        <div className="view-tabs">
          <button className={view === 'planner' ? 'active' : ''} onClick={() => openView('planner')}>
            Build a route
          </button>
          <button className={view === 'explore' ? 'active' : ''} onClick={() => openView('explore')}>
            Explore routes
          </button>
          <button className={view === 'routes' ? 'active' : ''} onClick={() => openView('routes')}>
            My Routes
          </button>
        </div>

        {view === 'routes' ? (
          <div className="saved-routes-panel">
            {!user && <p className="hint">Sign in to save and view routes.</p>}
            {user && savedRoutesLoading && <p className="hint">Loading&hellip;</p>}
            {user && !savedRoutesLoading && savedRoutes.length === 0 && <p className="hint">No saved routes yet.</p>}
            {user &&
              !savedRoutesLoading &&
              savedRoutes.map((r) => (
                <div className="saved-route-card" key={r.id}>
                  <div className="saved-route-info">
                    <div className="saved-route-name">{r.name}</div>
                    <div className="saved-route-meta">
                      {parks.find((p) => p.id === r.parkId)?.name ?? r.parkId} &middot; {r.stops.length} stops
                      {r.sleepStops.length > 0 && <> &middot; {r.sleepStops.length + 1} days</>}
                    </div>
                  </div>
                  <div className="saved-route-actions">
                    <button onClick={() => openSavedRoute(r)}>Open</button>
                    <button className="stop-remove" onClick={() => deleteSavedRoute(r.id)} aria-label="Delete route">
                      &times;
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ) : view === 'explore' ? (
          <div className="explore-panel">
            <div className="explore-intro">
              <h2>Known routes</h2>
              <p>Start with a classic route, preview its corridor, then customize the campsites and overnight stops.</p>
            </div>
            {knownRoutesLoading && <p className="hint">Computing route catalog&hellip;</p>}
            {knownRoutesError && <div className="results error">{knownRoutesError}</div>}
            {!knownRoutesLoading && !knownRoutesError && knownRoutes.length === 0 && (
              <p className="hint">No curated routes are available for this park yet.</p>
            )}
            <div className="known-route-list">
              {knownRoutes.map((knownRoute) => {
                const isSelected = selectedKnownRouteId === knownRoute.id
                const isLoop = knownRoute.stops.length > 1 && knownRoute.stops[0] === knownRoute.stops[knownRoute.stops.length - 1]
                const hasClosedSite = knownRoute.campsites.some((site) => site.closed)
                const exceedsPlannerLimit = knownRoute.stops.length > MAX_STOPS
                return (
                  <article className={`known-route-card ${isSelected ? 'selected' : ''}`} key={knownRoute.id}>
                    <button className="known-route-summary" onClick={() => previewKnownRoute(knownRoute)} aria-expanded={isSelected}>
                      <span className="known-route-title">{knownRoute.name}</span>
                      <span className="known-route-meta">
                        {knownRoute.totalDistanceMiles.toFixed(1)} mi &middot; {knownRoute.typicalNights} {knownRoute.typicalNights === 1 ? 'night' : 'nights'}
                      </span>
                      <span className="known-route-stats">
                        +{Math.round(knownRoute.totalElevationGainFt).toLocaleString()} ft gain &middot; {isLoop ? 'Loop' : 'Point-to-point'} &middot; {knownRoute.stops.length} waypoints
                      </span>
                    </button>
                    <div className="known-route-badges">
                      <span className="route-badge">{knownRoute.campsiteStops.length} campsite options</span>
                      {isLoop && <span className="route-badge">Loop</span>}
                      {hasClosedSite && <span className="route-badge warning">Closure to check</span>}
                    </div>
                    {isSelected && (
                      <div className="known-route-detail">
                        <p>{knownRoute.notes}</p>
                        {previewLoading ? <p className="loading-note">Drawing route preview&hellip;</p> : previewRoute ? <p className="preview-note">Route corridor shown on the map.</p> : <p className="preview-note">Stats are available, but the map preview could not be loaded.</p>}
                        {exceedsPlannerLimit && <p className="preview-note warning-text">This corridor has {knownRoute.stops.length} waypoints, above the planner limit of {MAX_STOPS}. Use the Build a route tab to create a shorter itinerary from it.</p>}
                        <button className="primary-route-button" disabled={exceedsPlannerLimit} onClick={() => planKnownRoute(knownRoute)}>Plan this route</button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </div>
        ) : (
          <>
            <p className="hint">Search for a location, then select it from the list — or click a campsite marker or any spot on the map.</p>

            <div className="stops-list">
              {stops.map((stopId, i) => {
                const label = stopId ? stopLabel(stopId, campsiteById) : null
                const isFirst = i === 0
                const isLast = i === stops.length - 1
                const isEditing = editingIndex === i
                const isSleepStop = !isFirst && !isLast && !!stopId && sleepStops.has(stopId)
                return (
                  <div
                    key={i}
                    className={`stop-item ${dragOverIndex === i ? 'drag-over' : ''} ${dragIndex === i ? 'dragging' : ''} ${isSleepStop ? 'stop-item-sleep' : ''}`}
                    onDragOver={(e) => handleStopDragOver(i, e)}
                    onDrop={(e) => handleStopDrop(i, e)}
                  >
                    <div className="stop-row">
                      <div
                        className="stop-drag-handle"
                        draggable
                        onDragStart={(e) => handleStopDragStart(i, e)}
                        onDragEnd={handleStopDragEnd}
                        aria-label="Drag to reorder stop"
                      >
                        &#8942;&#8942;
                      </div>
                      <div className="stop-marker-col">
                        {isFirst ? (
                          <FlagIcon color="#22c55e" />
                        ) : isLast ? (
                          <FlagIcon color="#e34948" />
                        ) : <TentIcon color={isSleepStop ? '#8a5a12' : '#777'} />}
                      </div>
                      <div className={`stop-input ${!label ? 'empty' : ''} ${isEditing ? 'editing' : ''}`}>
                        {isEditing ? (
                          <input
                            className="stop-search-input"
                            autoFocus
                            value={searchText}
                            placeholder={i === 0 ? 'Search trailheads or campsites…' : 'Search campsites…'}
                            onChange={(e) => setSearchText(e.target.value)}
                            onBlur={() => setTimeout(() => setEditingIndex(null), 150)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') setEditingIndex(null)
                            }}
                          />
                        ) : (
                          <>
                            <span onClick={() => startEditing(i)}>{label ?? 'Click to search, or pick on the map…'}</span>
                            {!isFirst && !isLast && stopId && (
                              <button
                                type="button"
                                className={`overnight-button ${isSleepStop ? 'marked' : ''}`}
                                onClick={() => toggleSleepStop(stopId)}
                                aria-label={isSleepStop ? 'Unmark overnight stay' : 'Make this an overnight stay'}
                              >
                                <TentIcon color={isSleepStop ? '#8a5a12' : '#555'} />
                                {isSleepStop ? 'Overnight' : 'Make overnight'}
                              </button>
                            )}
                            {label && (
                              <button className="stop-remove" onClick={() => clearOrRemoveStop(i)} aria-label="Remove stop">
                                &times;
                              </button>
                            )}
                          </>
                        )}
                        {isEditing && i === 0 && startSearchGroups.length > 0 && (
                          <div className="stop-suggestions">
                            {startSearchGroups.map((group) => (
                              <div key={group.type}>
                                <div className="stop-suggestion-group-header">{group.label}</div>
                                {group.items.map((c) => (
                                  <div
                                    key={c.id}
                                    className="stop-suggestion"
                                    onMouseDown={() => {
                                      setSlot(0, c.id)
                                      setEditingIndex(null)
                                    }}
                                  >
                                    <CampsiteOption campsite={c} />
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                        {isEditing && i !== 0 && searchResults.length > 0 && (
                          <div className="stop-suggestions">
                            {searchResults.map((c) => (
                              <div
                                key={c.id}
                                className="stop-suggestion"
                                onMouseDown={() => {
                                  setSlot(i, c.id)
                                  setEditingIndex(null)
                                }}
                              >
                                <CampsiteOption campsite={c} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {!isLast && (
                      <div className="stop-connector-row">
                        <div className="stop-drag-handle-spacer" />
                        <div className="stop-marker-col">
                          <div className="stop-connector" style={{ borderLeftColor: dayColor(dayIndexForLeg(i)) }} />
                        </div>
                        <div className="spacer" />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {selectedClosedSites.length > 0 && (
              <div className="closure-warning" role="status">
                <strong>Closure notice:</strong> {selectedClosedSites.map((site) => site.name).join(', ')} {selectedClosedSites.length === 1 ? 'is' : 'are'} currently marked closed.
                {' '}You can still view the route, but check current park conditions before going.
              </div>
            )}

            {stops.length < MAX_STOPS ? (
              <button className="add-stop-button" onClick={addBlankStop}>
                + Add another stop
              </button>
            ) : (
              <p className="hint">Maximum of {MAX_STOPS} stops reached.</p>
            )}

            {loading && (
              <p className="loading-note">
                Computing on-trail distance and elevation&hellip; the first lookup for a new trail segment can take up to a
                minute (live elevation queries), faster after that.
              </p>
            )}

            {error && <div className="results error">{error}</div>}

            {route && !loading && (
              <div className="results">
                {route.customPointSnaps.map((snap) => (
                  <div className="off-trail-note" key={snap.pointToken}>
                    This custom point is {(snap.distanceMeters * METERS_TO_MILES).toFixed(2)} mi from the nearest mapped trail. The dashed gray line shows that off-trail connection.
                  </div>
                ))}
                <div className="stat-row">
                  <span className="label">Total distance</span>
                  <span className="value">{route.distanceMiles.toFixed(2)} mi</span>
                </div>
                <div className="stat-row">
                  <span className="label">Elevation gain</span>
                  <span className="value">{Math.round(route.elevationGainFt).toLocaleString()} ft</span>
                </div>
                <div className="stat-row">
                  <span className="label">Elevation loss</span>
                  <span className="value">{Math.round(route.elevationLossFt).toLocaleString()} ft</span>
                </div>
                {dayTotals.length > 1 ? (
                  <div className="legs day-breakdown">
                    {dayTotals.map((day, dayIdx) => (
                      <div className="day-group" key={dayIdx}>
                        <div className="day-group-header">
                          <span className="legend-line" style={{ borderTopColor: dayColor(dayIdx) }} />
                          <span className="day-group-label">Day {dayIdx + 1}</span>
                          <span className="day-group-total">
                            {day.distanceMiles.toFixed(2)} mi, +{Math.round(day.elevationGainFt)}/-{Math.round(day.elevationLossFt)} ft
                          </span>
                        </div>
                        {day.legs.map((leg, i) => (
                          <div className="leg-row" key={i}>
                            <span>
                              {stopLabel(leg.from, campsiteById)} &rarr; {stopLabel(leg.to, campsiteById)}
                            </span>
                            <span>
                              {leg.distanceMiles.toFixed(2)} mi, +{Math.round(leg.elevationGainFt)}/-{Math.round(leg.elevationLossFt)} ft
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  route.legs.length > 1 && (
                    <div className="legs">
                      {route.legs.map((leg, i) => (
                        <div className="leg-row" key={i}>
                          <span>
                            {stopLabel(leg.from, campsiteById)} &rarr; {stopLabel(leg.to, campsiteById)}
                          </span>
                          <span>
                            {leg.distanceMiles.toFixed(2)} mi, +{Math.round(leg.elevationGainFt)}/-{Math.round(leg.elevationLossFt)} ft
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {user && (
                  <div className="save-route-row">
                    {saveStatus === 'saved' ? (
                      <span className="save-confirmation">Saved&nbsp;&#10003;</span>
                    ) : (
                      <>
                        <input
                          className="save-name-input"
                          placeholder="Name this route&hellip;"
                          value={saveName}
                          onChange={(e) => setSaveName(e.target.value)}
                        />
                        <button disabled={!saveName.trim() || saveStatus === 'saving'} onClick={saveCurrentRoute}>
                          Save
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {parkId && <ChatWidget parkId={parkId} routeSummary={routeSummary} />}
      </div>

      <div className="map-container">
        {/* preferCanvas: parks like Grand Canyon Full ship 10k+ road/trail line features — canvas
            rendering avoids creating one SVG <path> DOM node per feature, which is what made
            panning/zooming sluggish for those large networks. */}
        <MapContainer center={DEFAULT_MAP_CENTER} zoom={13} scrollWheelZoom={true} maxBoundsViscosity={1.0} preferCanvas={true}>
          <TileLayer
            attribution="Tiles courtesy of the U.S. Geological Survey"
            url="https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"
            maxZoom={16}
          />
          <FitBoundsToCampsites campsites={campsites} />
          <MapClickHandler onPick={(lat, lon) => setPendingPoint({ lat, lon })} onDismissPending={() => setPendingPoint(null)} />
          {SHOW_GENERATED_ZONES && zones && zones.features.length > 0 && (
            // interactive: false so zone shading doesn't swallow clicks meant for picking a custom point on the map
            <GeoJSON data={zones} interactive={false} style={zoneStyle} />
          )}
          {zoneMapOverlay && showZoneMapOverlay && <ZoneMapOverlayLayer overlay={zoneMapOverlay} opacity={0.85} />}
          {trails && (
            // interactive: false so trail/road lines don't swallow clicks meant for picking a custom point on the map
            <GeoJSON data={trails as FeatureCollection} interactive={false} style={trailStyle} />
          )}
          {campsites.map((c) => (
            <CampsiteMarker key={c.id} campsite={c} stops={stops} highlighted={stops.includes(c.id)} actions={stopActions} />
          ))}
          {hazards?.pinned.map((h) => (
            <HazardMarker key={h.id} hazard={h} />
          ))}
          {stops.map((stopValue, i) => {
            if (!stopValue || campsiteById.has(stopValue)) return null
            const raw = parseRawPoint(stopValue)
            if (!raw) return null
            return (
              <SelectedPointMarker
                key={`custom-${i}`}
                value={stopValue}
                lat={raw.lat}
                lon={raw.lon}
                stops={stops}
                actions={stopActions}
              />
            )
          })}
          {pendingPoint && (
            <PendingPointMarker point={pendingPoint} stops={stops} actions={stopActions} onDismiss={() => setPendingPoint(null)} />
          )}
          {view === 'explore' && previewPolyline.length > 1 && (
            <Polyline positions={previewPolyline} color="#1a73e8" weight={5} opacity={0.9} />
          )}
          {view !== 'explore' && dayPolylines.map((positions, day) => (
            <Polyline key={day} positions={positions} color={dayColor(day)} weight={4} opacity={0.9} />
          ))}
          {route?.customPointSnaps.filter((snap) => snap.distanceMeters >= 3).map((snap) => {
            const point = parseRawPoint(snap.pointToken)
            if (!point) return null
            return (
              <Polyline
                key={`snap-${snap.pointToken}`}
                positions={[[point.lat, point.lon], [snap.nearestTrailPoint[1], snap.nearestTrailPoint[0]]]}
                color="#4b5563"
                dashArray="6,8"
                weight={3}
                opacity={0.95}
              />
            )
          })}
        </MapContainer>

        {hazards && hazards.unlocated.length > 0 && (
          <div className="park-alerts-control">
            <button type="button" className="park-alerts-toggle" onClick={() => setShowParkAlerts((v) => !v)}>
              {showParkAlerts ? 'Hide' : 'Show'} park alerts ({hazards.unlocated.length})
            </button>
            {showParkAlerts && (
              <div className="park-alerts-list">
                <p className="park-alerts-note">
                  These NPS alerts aren't tied to a specific spot on the map, so they're listed here instead of pinned.
                </p>
                {hazards.unlocated.map((a, i) => (
                  <div className="park-alert-item" key={i}>
                    <span className="popup-type" style={{ color: hazardColor(a.category) }}>
                      {a.category}
                    </span>
                    <strong>{a.title}</strong>
                    <p>{a.description}</p>
                    {a.url && (
                      <a href={a.url} target="_blank" rel="noreferrer">
                        View official NPS alert
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {zoneMapOverlay && (
          <div className="zone-overlay-control">
            <label className="zone-overlay-toggle">
              <input
                type="checkbox"
                checked={showZoneMapOverlay}
                onChange={(e) => setShowZoneMapOverlay(e.target.checked)}
              />
              Official zone map overlay
            </label>
            {parkId === 'glacier' && (
              <span className="zone-overlay-note">
                (This overlay isn't perfectly accurate, but it's a good way to get a sense of the hiking zones.)
              </span>
            )}
          </div>
        )}

        <div className="legend">
          {Object.entries(TYPE_LABELS).map(([type, label]) => (
            <div className="legend-item" key={type}>
              <span className="legend-dot" style={{ background: TYPE_COLORS[type] }} />
              <span>{label}</span>
            </div>
          ))}
          <div className="legend-item">
            <span className="legend-line legend-line-trail" />
            <span>Trail</span>
          </div>
          <div className="legend-item">
            <span className="legend-line legend-line-road" />
            <span>Walkable road</span>
          </div>
          {hasOutsideRoads && (
            <div className="legend-item">
              <span className="legend-line legend-line-road-outside" />
              <span>Walkable road (outside park)</span>
            </div>
          )}
          {hazards && hazards.pinned.length > 0 &&
            Array.from(new Set(hazards.pinned.map((h) => h.category))).map((category) => (
              <div className="legend-item" key={category}>
                <span className="legend-dot" style={{ background: hazardColor(category) }} />
                <span>{category} (hazard)</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
