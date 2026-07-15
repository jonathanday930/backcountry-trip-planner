import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Popup, Polyline, GeoJSON, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import type { FeatureCollection } from 'geojson'

interface Campsite {
  id: string
  name: string
  lat: number
  lon: number
  type: string
  context?: string
}

interface Park {
  id: string
  name: string
  center: [number, number]
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

const TYPE_LABELS: Record<string, string> = {
  trailhead: 'Trailhead',
  designated_campsite: 'Designated campsite',
  corridor_campground: 'Corridor campground',
  at_large: 'At-large camping area',
}

/** Trailheads are the natural starting point for most trips, so they're listed first in the starting-point search. */
const STARTING_POINT_TYPE_ORDER = ['trailhead', 'designated_campsite', 'corridor_campground', 'at_large']

/** Each additional stop costs another shortest-path + live elevation lookup, so routes are capped well short of unusable. */
const MAX_STOPS = 25

function markerIcon(color: string, highlighted: boolean) {
  const size = highlighted ? 20 : 14
  const border = highlighted ? '3px solid #1a73e8' : '2px solid white'
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border};box-shadow:0 0 3px rgba(0,0,0,0.6);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
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
  const [view, setView] = useState<'planner' | 'routes'>('planner')
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [savedRoutesLoading, setSavedRoutesLoading] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  /** Set right before switching parks to load a saved route, so the park-switch effect applies
   * these stops (and which of them are overnight stays) instead of resetting to blank. */
  const [pendingLoadRoute, setPendingLoadRoute] = useState<{ stops: string[]; sleepStops: string[] } | null>(null)

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
    if (!parkId || parks.length === 0 || !parks.some((p) => p.id === parkId)) return
    setPendingPoint(null)
    setRoute(null)
    setEditingIndex(null)
    setSaveStatus('idle')
    setSaveName('')
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
  }, [parkId, parks])

  function loadSavedRoutes() {
    setSavedRoutesLoading(true)
    fetch('/api/saved-routes')
      .then((res) => (res.ok ? res.json() : []))
      .then(setSavedRoutes)
      .catch(() => setSavedRoutes([]))
      .finally(() => setSavedRoutesLoading(false))
  }

  function openView(next: 'planner' | 'routes') {
    setView(next)
    if (next === 'routes' && user) loadSavedRoutes()
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

  useEffect(() => {
    const stopIds = stops.filter((s): s is string => s !== null)
    if (!parkId || stopIds.length < 2 || stopIds.length !== stops.length) {
      setRoute(null)
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

  return (
    <div className="app">
      <div className="sidebar">
        <div className="top-row">
          <a className="home-link" href="#/" onClick={(e) => { e.preventDefault(); navigate('/') }} aria-label="Back to homepage">
            &larr;
          </a>
          <select className="park-select" value={parkId ?? ''} onChange={(e) => navigate(`/park/${e.target.value}`)}>
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
            Planner
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
        ) : (
          <>
            <p className="hint">Click a campsite marker or any spot on the map, then choose start / stop / destination.</p>

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
                        ) : (
                          <button
                            type="button"
                            className={`stop-sleep-toggle ${isSleepStop ? 'marked' : ''}`}
                            onClick={() => stopId && toggleSleepStop(stopId)}
                            disabled={!stopId}
                            aria-label={isSleepStop ? 'Unmark overnight stay' : 'Mark as overnight stay'}
                            title={isSleepStop ? 'Overnight stay — click to unmark' : 'Mark as overnight stay'}
                          >
                            <span className="stop-icon-circle" />
                            <TentIcon color={isSleepStop ? '#8a5a12' : '#555'} />
                          </button>
                        )}
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
                                    {c.name}
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
                                {c.name}
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
      </div>

      <div className="map-container">
        <MapContainer center={DEFAULT_MAP_CENTER} zoom={13} scrollWheelZoom={true} maxBoundsViscosity={1.0}>
          <TileLayer
            attribution="Tiles courtesy of the U.S. Geological Survey"
            url="https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"
            maxZoom={16}
          />
          <FitBoundsToCampsites campsites={campsites} />
          <MapClickHandler onPick={(lat, lon) => setPendingPoint({ lat, lon })} onDismissPending={() => setPendingPoint(null)} />
          {trails && (
            // interactive: false so trail/road lines don't swallow clicks meant for picking a custom point on the map
            <GeoJSON
              data={trails as FeatureCollection}
              interactive={false}
              style={(feature) =>
                feature?.properties?.kind === 'road'
                  ? { color: '#7a5230', weight: 3, opacity: 0.85 }
                  : { color: '#e67e22', weight: 3, opacity: 0.85, dashArray: '6,5' }
              }
            />
          )}
          {campsites.map((c) => (
            <CampsiteMarker key={c.id} campsite={c} stops={stops} highlighted={stops.includes(c.id)} actions={stopActions} />
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
          {dayPolylines.map((positions, day) => (
            <Polyline key={day} positions={positions} color={dayColor(day)} weight={4} opacity={0.9} />
          ))}
        </MapContainer>

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
        </div>
      </div>
    </div>
  )
}
