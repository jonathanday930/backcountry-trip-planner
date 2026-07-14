export interface ParkConfig {
  id: string
  name: string
  /** Subdirectory of backend/data holding this park's campsites.json and trails.geojson */
  dataDir: string
  center: [number, number]
}

export const PARKS: ParkConfig[] = [
  {
    id: 'grand-canyon',
    name: 'Grand Canyon (South Rim)',
    dataDir: 'grand-canyon',
    center: [36.09, -112.13],
  },
  {
    id: 'rocky-mountain',
    name: 'Rocky Mountain National Park',
    dataDir: 'rocky-mountain',
    center: [40.35, -105.68],
  },
]
