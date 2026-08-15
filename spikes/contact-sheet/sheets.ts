/**
 * Contact sheets for #36's six looks — the hand-off the ticket asks for.
 *
 * > the hand-off is **treated exports, not a description of them** — a handful
 * > of stills through each look at its defaults, plus a short clip through the
 * > video-safe kernels, exported at final resolution so the pattern is at
 * > delivery scale.
 *
 * `spikes/post-effects/src/bin/duotone-ab.rs` is the precedent: it answered a
 * look question by rendering contact sheets rather than by arguing.
 *
 * **It imports the shipped renderer and the shipped looks.** Nothing here
 * reimplements a shader or a default — a sheet rendered by a second
 * implementation would be a picture of code that is not the code, which is
 * exactly the trap #36 names when it says a mocked shader proves the mock
 * works. What this file adds is layout, labels, and the decision about which
 * crops are worth looking at.
 *
 * Run it through the dev server that is already up (`npm run tauri:dev` serves
 * Vite on 1420) and it POSTs each finished sheet to the little writer in
 * `write-sheets.mjs`. Nothing is committed but this file and its sibling: the
 * source images are the user's own material, read from the local store rather
 * than copied into the repo, the same rule `spikes/post-effects/src/lib.rs`
 * states for its own three.
 */

import {
  BUILT_IN_LOOKS,
  defaultKnobValues,
  inksForValues,
  isDiffusionKernel,
  type EffectsLook,
  type KnobValue,
} from '@/lib/effects'
import { createEffectsRenderer } from '@/lib/effects/gl/renderer'
import { DEFAULT_PALETTE } from '@/lib/recipe'

/** Where the writer is listening. */
const WRITER = 'http://localhost:5199/write'

/** The three source categories #52 settled on, plus a clip. */
const STILLS = [
  { slug: 'photographic', file: 'photographic.jpg' },
  { slug: 'highkey', file: 'highkey.png' },
  { slug: 'flatgraphic', file: 'flatgraphic.jpg' },
]

const CLIP_FRAMES = ['clip-01.png', 'clip-02.png', 'clip-03.png', 'clip-04.png']

/** Wide enough to judge composition, small enough to fit six across. */
const CELL_WIDTH = 520

/**
 * The detail crop, at **one output pixel per screen pixel**.
 *
 * The whole reason the ticket insists on final resolution: a dither cell or a
 * halftone dot is only judged honestly at pixel scale, and a sheet that scaled
 * everything to fit would be a picture of the resampler.
 */
const DETAIL = { width: 620, height: 360 }

const LABEL_HEIGHT = 34
const GAP = 12
const PAD = 24

async function main(): Promise<void> {
  const status = document.querySelector('#status') as HTMLElement

  const say = (line: string): void => {
    status.textContent = line
    // eslint-disable-next-line no-console
    console.log(line)
  }

  for (const still of STILLS) {
    const image = await load(`./sources/${still.file}`)
    await post(`looks-${still.slug}`, await overview(image, still.slug))
    say(`overview: ${still.slug}`)
    await post(`detail-${still.slug}`, await detail(image, still.slug))
    say(`detail: ${still.slug}`)
  }

  const frames = await Promise.all(
    CLIP_FRAMES.map(file => load(`./sources/${file}`))
  )
  for (const still of ['highkey.png', 'flatgraphic.jpg']) {
    const image = await load(`./sources/${still}`)
    const slug = still.split('.')[0] as string
    await post(`halftone-cells-${slug}`, await halftoneLadder(image, slug))
    say(`halftone ladder: ${slug}`)
  }

  await post('video-kernels', await videoKernels(frames))
  say('video: kernels')
  await post('video-stability', await videoStability(frames))
  say('video: stability')

  say('done — every sheet written')
}

/** Every look at its defaults, side by side with the untreated plate. */
async function overview(image: HTMLImageElement, slug: string): Promise<Blob> {
  const ratio = image.naturalHeight / image.naturalWidth
  const cellHeight = Math.round(CELL_WIDTH * ratio)
  const cells: Cell[] = [{ label: 'untreated', draw: paint(image) }]

  for (const look of BUILT_IN_LOOKS) {
    cells.push({
      label: `${look.name} — defaults`,
      draw: shade(image, look, valuesFor(look), CELL_WIDTH, cellHeight),
    })
  }

  return grid({
    title: `#36 — the six looks at their defaults · ${slug}`,
    subtitle: `${image.naturalWidth}×${image.naturalHeight} source, each cell ${CELL_WIDTH}px wide (fit — see the detail sheet for delivery scale)`,
    columns: 4,
    cellWidth: CELL_WIDTH,
    cellHeight,
    cells,
  })
}

/**
 * The same six, cropped and rendered 1:1.
 *
 * Rendered at the source's own resolution and then *cropped* rather than
 * scaled, so a cell size of 6 is six pixels across here exactly as it will be
 * in the export.
 */
async function detail(image: HTMLImageElement, slug: string): Promise<Blob> {
  const cells: Cell[] = [
    { label: 'untreated', draw: cropOf(image, null, {}, DETAIL) },
  ]

  for (const look of BUILT_IN_LOOKS) {
    cells.push({
      label: `${look.name} — 1:1`,
      draw: cropOf(image, look, valuesFor(look), DETAIL),
    })
  }

  return grid({
    title: `#36 — delivery scale, one output pixel per screen pixel · ${slug}`,
    subtitle: `centre crop of the ${image.naturalWidth}px-wide frame rendered at full resolution — this is the texture that ships`,
    columns: 4,
    cellWidth: DETAIL.width,
    cellHeight: DETAIL.height,
    cells,
  })
}

/**
 * One clip frame through every kernel the duotone look offers.
 *
 * The question this sheet is for: is blue noise an acceptable stand-in for
 * Atkinson on video? Atkinson and Floyd–Steinberg are here too, even though
 * the tab disables them on a clip — you cannot judge a substitute without the
 * thing it substitutes for.
 */
async function videoKernels(frames: HTMLImageElement[]): Promise<Blob> {
  const look = lookOf('fx-duotone-dither')
  const frame = frames[0] as HTMLImageElement
  const kernels = kernelOptions(look)

  const cells: Cell[] = kernels.map(kernel => ({
    label: isDiffusionKernel(kernel) ? `${kernel} — disabled on clips` : kernel,
    draw: cropOf(frame, look, { ...valuesFor(look), kernel }, DETAIL),
  }))

  return grid({
    title: '#36 — duotone kernels on a clip frame, at delivery scale',
    subtitle:
      'the two diffusion kernels are shown for comparison only; the tab disables them on a clip because they crawl between frames',
    columns: 3,
    cellWidth: DETAIL.width,
    cellHeight: DETAIL.height,
    cells,
  })
}

/**
 * Four consecutive frames, per kernel, at delivery scale.
 *
 * Crawl is a property of the *sequence*, so a single frame cannot show it.
 * Read each row left to right: an ordered or blue-noise row holds its pattern
 * still while the picture moves under it, and an Atkinson row does not.
 */
async function videoStability(frames: HTMLImageElement[]): Promise<Blob> {
  const look = lookOf('fx-duotone-dither')
  const size = { width: 420, height: 240 }
  const kernels = ['bayer8', 'blueNoise', 'atkinson']

  const cells: Cell[] = []
  for (const kernel of kernels) {
    for (const [at, frame] of frames.entries()) {
      cells.push({
        label: `${kernel} · frame ${at + 1}`,
        draw: cropOf(frame, look, { ...valuesFor(look), kernel }, size),
      })
    }
  }

  return grid({
    title: '#36 — does the pattern hold still? four consecutive frames',
    subtitle:
      'read each row left to right. Ordered and blue-noise masks are fixed to the pixel grid; error diffusion re-derives every frame from scratch',
    columns: frames.length,
    cellWidth: size.width,
    cellHeight: size.height,
    cells,
  })
}

/**
 * One source, one look, six cell sizes — the question the other sheets raise.
 *
 * A halftone screen antialiases against its own gradient, and `fwidth` of a
 * coordinate measured in cells is about `1 / cell`. At cell 6 that puts the
 * transition band at a third of the cell, so every dot is a smear and the tone
 * comes out heavier than its ink fraction. Whether that is a defect or the
 * grain of a fine screen is a look question, and a ladder is the honest way to
 * ask it.
 */
async function halftoneLadder(
  image: HTMLImageElement,
  slug: string
): Promise<Blob> {
  const look = lookOf('fx-halftone')
  const base = valuesFor(look)
  const sizes = [3, 4, 6, 8, 12, 18]

  const cells: Cell[] = sizes.map(cell => ({
    label: `cell ${cell}${cell === base.cell ? ' — default' : ''}`,
    draw: cropOf(image, look, { ...base, cell }, DETAIL),
  }))

  return grid({
    title: `#36 — halftone, cell size ladder · ${slug}`,
    subtitle:
      'everything else at its default (45°, round). The antialias band is about one pixel wide whatever the cell, so it is a larger fraction of a small cell — which is why a fine screen reads heavier than its ink fraction',
    columns: 3,
    cellWidth: DETAIL.width,
    cellHeight: DETAIL.height,
    cells,
  })
}

// ── Rendering ───────────────────────────────────────────────────────────────

type Cell = {
  label: string
  draw: (target: CanvasRenderingContext2D, x: number, y: number) => void
}

/** The look's authored defaults, resolved against the default palette. */
function valuesFor(look: EffectsLook): Record<string, KnobValue> {
  return { ...defaultKnobValues(look, DEFAULT_PALETTE) }
}

function lookOf(id: string): EffectsLook {
  const look = BUILT_IN_LOOKS.find(entry => entry.id === id)
  if (look === undefined) throw new Error(`no look "${id}"`)
  return look
}

function kernelOptions(look: EffectsLook): string[] {
  for (const knob of look.knobs) {
    if (knob.kind === 'choice' && knob.key === 'kernel')
      return [...knob.options]
  }
  return []
}

/** One shared context for every cell — a context per cell exhausts the browser. */
let shared: ReturnType<typeof createEffectsRenderer> = null
let sharedCanvas: HTMLCanvasElement | null = null

function renderer(): {
  gl: NonNullable<ReturnType<typeof createEffectsRenderer>>
  canvas: HTMLCanvasElement
} {
  if (shared === null || sharedCanvas === null) {
    sharedCanvas = document.createElement('canvas')
    shared = createEffectsRenderer(sharedCanvas)
    if (shared === null) throw new Error('no WebGL2 in this browser')
  }
  return { gl: shared, canvas: sharedCanvas }
}

function paint(image: HTMLImageElement) {
  return (target: CanvasRenderingContext2D, x: number, y: number): void => {
    const width = CELL_WIDTH
    const height = Math.round(
      CELL_WIDTH * (image.naturalHeight / image.naturalWidth)
    )
    target.drawImage(image, x, y, width, height)
  }
}

/** The look, rendered whole at `width × height`. */
function shade(
  image: HTMLImageElement,
  look: EffectsLook,
  values: Record<string, KnobValue>,
  width: number,
  height: number
) {
  return (target: CanvasRenderingContext2D, x: number, y: number): void => {
    const { gl, canvas } = renderer()
    gl.render({
      source: image,
      look,
      values,
      inks: inksForValues(DEFAULT_PALETTE, values),
      width,
      height,
    })
    target.drawImage(canvas, x, y)
  }
}

/**
 * A centre crop of the look rendered at the source's **own** resolution.
 *
 * Rendering small and enlarging would show a resampled pattern; rendering full
 * and cropping shows the pattern itself.
 */
function cropOf(
  image: HTMLImageElement,
  look: EffectsLook | null,
  values: Record<string, KnobValue>,
  size: { width: number; height: number }
) {
  return (target: CanvasRenderingContext2D, x: number, y: number): void => {
    const full = image.naturalWidth
    const tall = image.naturalHeight
    const left = Math.max(0, Math.round((full - size.width) / 2))
    const top = Math.max(0, Math.round((tall - size.height) / 2))

    if (look === null) {
      target.drawImage(
        image,
        left,
        top,
        size.width,
        size.height,
        x,
        y,
        size.width,
        size.height
      )
      return
    }

    const { gl, canvas } = renderer()
    gl.render({
      source: image,
      look,
      values,
      inks: inksForValues(DEFAULT_PALETTE, values),
      width: full,
      height: tall,
    })
    target.drawImage(
      canvas,
      left,
      top,
      size.width,
      size.height,
      x,
      y,
      size.width,
      size.height
    )
  }
}

// ── Layout ──────────────────────────────────────────────────────────────────

async function grid(sheet: {
  title: string
  subtitle: string
  columns: number
  cellWidth: number
  cellHeight: number
  cells: Cell[]
}): Promise<Blob> {
  const rows = Math.ceil(sheet.cells.length / sheet.columns)
  const width =
    PAD * 2 + sheet.columns * sheet.cellWidth + (sheet.columns - 1) * GAP
  const header = 78
  const height =
    PAD * 2 +
    header +
    rows * (sheet.cellHeight + LABEL_HEIGHT) +
    (rows - 1) * GAP

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const target = canvas.getContext('2d') as CanvasRenderingContext2D

  target.fillStyle = '#0e0e10'
  target.fillRect(0, 0, width, height)

  target.fillStyle = '#f4f4f5'
  target.font = '600 22px ui-sans-serif, -apple-system, system-ui, sans-serif'
  target.fillText(sheet.title, PAD, PAD + 24)
  target.fillStyle = '#a1a1aa'
  target.font = '400 14px ui-sans-serif, -apple-system, system-ui, sans-serif'
  wrap(target, sheet.subtitle, PAD, PAD + 50, width - PAD * 2, 18)

  sheet.cells.forEach((cell, at) => {
    const column = at % sheet.columns
    const row = Math.floor(at / sheet.columns)
    const x = PAD + column * (sheet.cellWidth + GAP)
    const y = PAD + header + row * (sheet.cellHeight + LABEL_HEIGHT + GAP)

    target.save()
    target.beginPath()
    target.rect(x, y, sheet.cellWidth, sheet.cellHeight)
    target.clip()
    target.fillStyle = '#18181b'
    target.fillRect(x, y, sheet.cellWidth, sheet.cellHeight)
    cell.draw(target, x, y)
    target.restore()

    target.fillStyle = '#d4d4d8'
    target.font = '500 14px ui-monospace, SFMono-Regular, Menlo, monospace'
    target.fillText(cell.label, x, y + sheet.cellHeight + 21)
  })

  return await new Promise<Blob>(resolve => {
    canvas.toBlob(blob => resolve(blob as Blob), 'image/png')
  })
}

function wrap(
  target: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
): void {
  let line = ''
  let at = y
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`
    if (target.measureText(next).width > maxWidth && line !== '') {
      target.fillText(line, x, at)
      line = word
      at += lineHeight
    } else {
      line = next
    }
  }
  if (line !== '') target.fillText(line, x, at)
}

// ── Getting them onto disk ──────────────────────────────────────────────────

async function post(name: string, blob: Blob): Promise<void> {
  const response = await fetch(`${WRITER}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: blob,
  })
  if (!response.ok) throw new Error(`the writer refused ${name}`)
}

function load(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`could not load ${source}`))
    image.src = source
  })
}

void main().catch((error: unknown) => {
  const status = document.querySelector('#status') as HTMLElement
  status.textContent = `failed: ${String(error)}`
  // eslint-disable-next-line no-console
  console.error(error)
})
