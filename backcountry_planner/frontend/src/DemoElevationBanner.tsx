import { useEffect, useRef, useState } from 'react'

interface DemStatus {
  hasDem: boolean
  state: 'idle' | 'downloading' | 'extracting' | 'done' | 'error'
  receivedBytes: number
  totalBytes: number | null
  error?: string
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0)

/** Demo-mode only: offers a one-click download of a park's local elevation raster (served from
 * GitHub), so a fresh checkout gets fast, accurate elevation instead of slow live USGS lookups.
 * Renders nothing when the server's demo mode is off or the park already has its raster. */
export default function DemoElevationBanner({ parkId, onInstalled }: { parkId: string; onInstalled: () => void }) {
  const [demoMode, setDemoMode] = useState(false)
  const [status, setStatus] = useState<DemStatus | null>(null)
  const [pollKey, setPollKey] = useState(0) // bumped to (re)start the status polling loop
  const installedRef = useRef(onInstalled)
  installedRef.current = onInstalled

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((cfg: { demoMode: boolean }) => setDemoMode(cfg.demoMode))
      .catch(() => setDemoMode(false))
  }, [])

  // Load status on park change, then poll while a download is running.
  useEffect(() => {
    if (!demoMode) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasInstalling = false

    const poll = () => {
      fetch(`/api/dem/status?park=${encodeURIComponent(parkId)}`)
        .then((res) => res.json())
        .then((s: DemStatus) => {
          if (cancelled) return
          setStatus(s)
          const running = s.state === 'downloading' || s.state === 'extracting'
          if (running) wasInstalling = true
          if (running) timer = setTimeout(poll, 1000)
          else if (wasInstalling && s.hasDem) {
            wasInstalling = false
            installedRef.current()
          }
        })
        .catch(() => {})
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [demoMode, parkId, pollKey])

  useEffect(() => setStatus(null), [parkId])

  function start() {
    fetch(`/api/dem/download?park=${encodeURIComponent(parkId)}`, { method: 'POST' })
      .then((res) => res.json())
      .then((s: DemStatus) => {
        setStatus(s)
        setPollKey((k) => k + 1)
      })
      .catch(() => {})
  }

  if (!demoMode || !status || status.hasDem) return null

  const running = status.state === 'downloading' || status.state === 'extracting'
  const pct = status.totalBytes ? Math.min(100, (status.receivedBytes / status.totalBytes) * 100) : null

  return (
    <div className="dem-banner">
      <div className="dem-banner-title">Elevation data not downloaded for this park</div>
      <div className="dem-banner-text">
        Routes still work, but elevation comes from slow live lookups. Download this park&rsquo;s elevation data from
        GitHub for fast, accurate gain/loss.
      </div>
      {running ? (
        <div className="dem-banner-progress">
          <div className="dem-progress-bar">
            <div className="dem-progress-fill" style={{ width: `${pct ?? 100}%` }} />
          </div>
          <span>
            {status.state === 'extracting'
              ? 'Installing…'
              : pct !== null
                ? `Downloading ${mb(status.receivedBytes)} / ${mb(status.totalBytes!)} MB`
                : `Downloading ${mb(status.receivedBytes)} MB`}
          </span>
        </div>
      ) : (
        <button className="dem-banner-button" onClick={start}>
          Download elevation data
        </button>
      )}
      {status.state === 'error' && <div className="dem-banner-error">{status.error ?? 'Download failed.'} Try again.</div>}
    </div>
  )
}
