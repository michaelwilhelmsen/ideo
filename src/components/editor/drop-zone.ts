/**
 * Where an OS drag actually landed (#27).
 *
 * Tauri reports a drag against the *window*, not against a DOM node, so a
 * component that wants a drop zone smaller than the window has to do the
 * hit test itself. Pure, and therefore checkable without a webview.
 */

/** A rectangle in CSS pixels — what `getBoundingClientRect` hands back. */
interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * Whether an OS drag position falls inside a DOM rectangle.
 *
 * The two are not in the same units: Tauri reports a *physical* position and
 * the rectangle is in CSS pixels, so on any display with a scale factor above
 * 1 comparing them directly puts every drop in the top-left quadrant. Dividing
 * by the device pixel ratio is the whole conversion.
 */
export function isWithinDropZone(
  rect: Rect,
  position: { readonly x: number; readonly y: number },
  devicePixelRatio: number
): boolean {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1
  const x = position.x / scale
  const y = position.y / scale

  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
