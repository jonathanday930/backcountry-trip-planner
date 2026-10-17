import L from 'leaflet'

/**
 * Image overlay warped to fit three geographic corners (top-left, top-right, bottom-left)
 * instead of an axis-aligned rectangle. Plain L.ImageOverlay can only place an unrotated
 * rectangle, which isn't enough for a scanned paper map whose scan/print introduces a small
 * rotation or shear relative to true north/lat-lon — fitting 3 corners (a 6-parameter affine)
 * instead of 2 opposite corners removes that residual tilt. Implements the same CSS-matrix warp
 * technique as the well-known Leaflet.ImageOverlay.Rotated plugin, written standalone here rather
 * than adding a dependency for one small layer. Untyped (any-cast) throughout: @types/leaflet
 * doesn't expose the ImageOverlay internals (`_image`, `_reset`, etc.) this needs to override.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Base: any = L.ImageOverlay

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RotatedImageOverlay: any = Base.extend({
  initialize(
    url: string,
    topLeft: L.LatLngExpression,
    topRight: L.LatLngExpression,
    bottomLeft: L.LatLngExpression,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any,
  ) {
    this._url = url
    this._topLeft = L.latLng(topLeft)
    this._topRight = L.latLng(topRight)
    this._bottomLeft = L.latLng(bottomLeft)
    L.Util.setOptions(this, options)
  },

  getEvents() {
    // Base class also wires up `zoomanim` when the layer is zoom-animated, driving
    // `_animateZoom`, which reads `this._bounds` — always undefined here since we position via
    // three corners instead. Drop it and let `_reset` (below) handle both zoom and viewreset.
    return { zoom: this._reset, viewreset: this._reset }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _initImage(this: any) {
    Base.prototype._initImage.call(this)
    const img = this._image as HTMLImageElement
    const prevOnload = img.onload
    img.onload = (e: Event) => {
      this._naturalWidth = img.naturalWidth
      this._naturalHeight = img.naturalHeight
      this._reset()
      if (typeof prevOnload === 'function') prevOnload.call(img, e)
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _reset(this: any) {
    const el = this._image as HTMLImageElement | undefined
    const map = this._map as L.Map | undefined
    const w = this._naturalWidth as number | undefined
    const h = this._naturalHeight as number | undefined
    if (!el || !map || !w || !h) return

    const topLeft = map.latLngToLayerPoint(this._topLeft)
    const topRight = map.latLngToLayerPoint(this._topRight)
    const bottomLeft = map.latLngToLayerPoint(this._bottomLeft)

    const a = (topRight.x - topLeft.x) / w
    const b = (topRight.y - topLeft.y) / w
    const c = (bottomLeft.x - topLeft.x) / h
    const d = (bottomLeft.y - topLeft.y) / h

    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.style.transformOrigin = '0 0'
    el.style.transform = `matrix(${a},${b},${c},${d},${topLeft.x},${topLeft.y})`
  },
})
