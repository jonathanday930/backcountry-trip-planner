import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { hasDem, resetDemCache } from './demElevation.js'
import { clearEdgeProfiles } from './elevation.js'
import { DEM_DIR_NAME, MANIFEST_FILE_NAME } from './dem/manifest.js'
import { PARKS } from './parks.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

/** Demo mode lets a visitor pull a park's elevation raster from GitHub with one click (see
 * `startDemDownload`), so a fresh clone gets fast, accurate elevation without running the DEM fetch
 * scripts. On by default; set `DEMO_MODE=false` for a deployment that ships its data in the image
 * (e.g. Fly.io) and shouldn't let anonymous visitors trigger multi-hundred-MB downloads. */
export const DEMO_MODE = process.env.DEMO_MODE !== 'false'

const RELEASE_REPO = process.env.DEM_RELEASE_REPO ?? 'jonathanday930/backcountry-trip-planner'
const RELEASE_TAG = process.env.DEM_RELEASE_TAG ?? 'dem-v1'

type DemDownloadState = 'idle' | 'downloading' | 'extracting' | 'done' | 'error'

interface Progress {
  state: DemDownloadState
  receivedBytes: number
  totalBytes: number | null
  error?: string
}

const progress = new Map<string, Progress>()

export interface DemStatus extends Progress {
  hasDem: boolean
}

export function getDemStatus(dataDir: string): DemStatus {
  const has = hasDem(dataDir)
  const p = progress.get(dataDir) ?? { state: has ? 'done' : 'idle', receivedBytes: 0, totalBytes: null }
  return { ...p, state: has ? 'done' : p.state, hasDem: has }
}

/** Asset names are produced by scripts/package-dem.sh — keep the two in sync. */
function assetUrl(dataDir: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/dem-${dataDir}.tar.gz`
}

/** Kicks off a background download + extract of a park's elevation raster. Returns immediately;
 * callers poll `getDemStatus`. Safe to call repeatedly — a download already in flight or an
 * already-installed raster is a no-op. Only ever fetches the fixed release asset for a registered
 * park, never a caller-supplied URL or path. */
export function startDemDownload(parkId: string): DemStatus | null {
  const park = PARKS.find((p) => p.id === parkId)
  if (!park) return null
  const dataDir = park.dataDir
  const current = progress.get(dataDir)
  if (hasDem(dataDir) || current?.state === 'downloading' || current?.state === 'extracting') {
    return getDemStatus(dataDir)
  }
  progress.set(dataDir, { state: 'downloading', receivedBytes: 0, totalBytes: null })
  downloadAndInstall(dataDir).catch((err) => {
    console.error(`[dem] download failed for ${dataDir}:`, err)
    progress.set(dataDir, {
      state: 'error',
      receivedBytes: progress.get(dataDir)?.receivedBytes ?? 0,
      totalBytes: progress.get(dataDir)?.totalBytes ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
  })
  return getDemStatus(dataDir)
}

async function downloadAndInstall(dataDir: string): Promise<void> {
  const parkDir = path.join(DATA_DIR, dataDir)
  const incoming = path.join(parkDir, '.dem-incoming')
  rmSync(incoming, { recursive: true, force: true })
  mkdirSync(incoming, { recursive: true })

  try {
    const res = await fetch(assetUrl(dataDir))
    if (!res.ok || !res.body) {
      throw new Error(
        res.status === 404
          ? 'Elevation data for this park has not been published yet.'
          : `GitHub returned ${res.status} while downloading elevation data.`,
      )
    }
    const total = Number(res.headers.get('content-length'))
    progress.set(dataDir, { state: 'downloading', receivedBytes: 0, totalBytes: total > 0 ? total : null })

    const tar = spawn('tar', ['-xzf', '-', '-C', incoming], { stdio: ['pipe', 'ignore', 'pipe'] })
    let tarErr = ''
    tar.stderr.on('data', (d) => (tarErr += d))
    const exited = new Promise<void>((resolve, reject) => {
      tar.on('error', reject)
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${tarErr.trim()}`))))
    })

    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    body.on('data', (chunk: Buffer) => {
      const p = progress.get(dataDir)!
      progress.set(dataDir, { ...p, receivedBytes: p.receivedBytes + chunk.length })
    })
    body.pipe(tar.stdin)
    body.on('error', () => tar.kill())
    tar.stdin.on('error', () => {}) // tar exited early; its own failure is reported via `exited`
    await exited

    const extracted = path.join(incoming, DEM_DIR_NAME)
    if (!existsSync(path.join(extracted, MANIFEST_FILE_NAME))) {
      throw new Error('Downloaded archive did not contain a valid elevation manifest.')
    }
    progress.set(dataDir, { ...progress.get(dataDir)!, state: 'extracting' })
    const finalDir = path.join(parkDir, DEM_DIR_NAME)
    rmSync(finalDir, { recursive: true, force: true })
    renameSync(extracted, finalDir)

    // Anything computed before the raster existed used the live USGS fallback: drop it so the next
    // route is recomputed from the local raster.
    resetDemCache(dataDir)
    clearEdgeProfiles(dataDir)
    progress.set(dataDir, { ...progress.get(dataDir)!, state: 'done' })
  } finally {
    rmSync(incoming, { recursive: true, force: true })
  }
}
