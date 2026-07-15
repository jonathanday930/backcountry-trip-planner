import { useEffect, useMemo, useRef, useState } from 'react'
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
  createdAt: string
}

interface RouteLeg {
  from: string
  to: string
  distanceMiles: number
  elevationGainFt: number
  elevationLossFt: number
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
const START_FLAG_ICON = L.divIcon({
  className: '',
  html: `<svg width="36" height="36" viewBox="0 0 36 36" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));">
    <line x1="8" y1="4" x2="8" y2="33" stroke="#1a4d2e" stroke-width="3" stroke-linecap="round"/>
    <path d="M8 5 L31 12 L8 19 Z" fill="#22c55e" stroke="#15803d" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`,
  iconSize: [36, 36],
  iconAnchor: [8, 33],
})

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

/** The Set as start / Add as a stop / Set as destination buttons shown in every marker popup. */
function StopActionButtons({
  value,
  stops,
  onSetStart,
  onSetDestination,
  onAddStop,
  onRemoveStop,
  onDone,
}: StopActions & { value: string; stops: (string | null)[]; onDone: () => void }) {
  const stopIndex = stops.indexOf(value)
  const isSelected = stopIndex !== -1
  const isStart = stops[0] === value
  const isDestination = stops[stops.length - 1] === value
  const destinationSet = stops[stops.length - 1] !== null
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
          onClick={() => {
            onAddStop(value)
            onDone()
          }}
        >
          Add as a stop
        </button>
      )}
      <button
        disabled={isDestination}
        onClick={() => {
          onSetDestination(value)
          onDone()
        }}
      >
        Set as destination
      </button>
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
  const icon = isStart ? START_FLAG_ICON : markerIcon(TYPE_COLORS[campsite.type] ?? '#666', highlighted)
  return (
    <Marker
      position={[campsite.lat, campsite.lon]}
      icon={icon}
      zIndexOffset={isStart ? 1000 : 0}
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
  return (
    <Marker position={[lat, lon]} icon={isStart ? START_FLAG_ICON : markerIcon('#4a5568', true)} zIndexOffset={isStart ? 1000 : 0} ref={markerRef}>
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

  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [view, setView] = useState<'planner' | 'routes'>('planner')
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [savedRoutesLoading, setSavedRoutesLoading] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  /** Set right before switching parks to load a saved route, so the park-switch effect applies
   * these stops instead of resetting to blank. */
  const [pendingLoadStops, setPendingLoadStops] = useState<string[] | null>(null)

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
    if (pendingLoadStops) {
      setStops(pendingLoadStops)
      setPendingLoadStops(null)
    } else {
      setStops([null, null])
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
    } else {
      setPendingLoadStops(saved.stops)
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
      body: JSON.stringify({ parkId, name: saveName.trim(), stops: stopIds }),
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
      .then(setRoute)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
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

  function addAsStop(value: string) {
    setStops((prev) => {
      const next = [...prev]
      next.splice(next.length - 1, 0, value)
      return next
    })
  }

  const stopActions: StopActions = {
    onSetStart: setAsStart,
    onSetDestination: setAsDestination,
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

  function startEditing(index: number) {
    setEditingIndex(index)
    setSearchText('')
  }

  const searchResults = useMemo(() => {
    if (editingIndex === null) return []
    const q = searchText.trim().toLowerCase()
    const results = q ? campsites.filter((c) => c.name.toLowerCase().includes(q)) : campsites
    return results.slice(0, 8)
  }, [editingIndex, searchText, campsites])

  const routeLatLngs = useMemo<[number, number][]>(
    () => route?.routeGeoJson.coordinates.map(([lon, lat]) => [lat, lon]) ?? [],
    [route],
  )

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

            <div className="starting-point-row">
              <label className="starting-point-label" htmlFor="starting-point-select">
                Starting point <span className="starting-point-optional">(optional)</span>
              </label>
              <select
                id="starting-point-select"
                className="starting-point-select"
                value={stops[0] ?? ''}
                onChange={(e) => setSlot(0, e.target.value || null)}
              >
                <option value="">No starting point selected</option>
                {campsites.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {stops[0] && !campsiteById.has(stops[0]) && <option value={stops[0]}>{stopLabel(stops[0], campsiteById)}</option>}
              </select>
            </div>

            <div className="stops-list">
              {stops.map((stopId, i) => {
                const label = stopId ? stopLabel(stopId, campsiteById) : null
                const isLast = i === stops.length - 1
                const isEditing = editingIndex === i
                return (
                  <div key={i}>
                    <div className="stop-row">
                      <div className="stop-marker-col">
                        <div className={isLast ? 'stop-icon-pin' : 'stop-icon-circle'} />
                      </div>
                      <div className={`stop-input ${!label ? 'empty' : ''} ${isEditing ? 'editing' : ''}`}>
                        {isEditing ? (
                          <input
                            className="stop-search-input"
                            autoFocus
                            value={searchText}
                            placeholder="Search campsites…"
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
                        {isEditing && searchResults.length > 0 && (
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
                        <div className="stop-marker-col">
                          <div className="stop-connector" />
                        </div>
                        <div className="spacer" />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

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
                {route.legs.length > 1 && (
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

            <div className="legend">
              {Object.entries(TYPE_LABELS).map(([type, label]) => (
                <div className="legend-item" key={type}>
                  <span className="legend-dot" style={{ background: TYPE_COLORS[type] }} />
                  <span>{label}</span>
                </div>
              ))}
            </div>
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
            // interactive: false so trail lines don't swallow clicks meant for picking a custom point on the map
            <GeoJSON
              data={trails as FeatureCollection}
              interactive={false}
              style={() => ({ color: '#e67e22', weight: 3, opacity: 0.85, dashArray: '6,5' })}
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
          {routeLatLngs.length > 0 && <Polyline positions={routeLatLngs} color="#c0392b" weight={4} opacity={0.9} />}
        </MapContainer>
      </div>
    </div>
  )
}
