/**
 * One WebGL2 context, driving both the live preview and (later) the bake.
 *
 * The whole reason this is one object rather than two code paths: the exported
 * file cannot disagree with what was on screen, because the same program draws
 * both. That class of bug is designed out here rather than tested for — and
 * there is no CPU fallback for the shader looks, because a fallback would mean
 * porting six effects to a second implementation which runs only on machines we
 * do not have.
 *
 * **No WebGL2 is a state, not a crash.** {@link createEffectsRenderer} returns
 * `null` and the tab says so with a reason, which is PRD §10.1's
 * disabled-with-a-reason again.
 *
 * Programs are compiled lazily and kept: switching looks is meant to be
 * instant, and a shader compile on the first frame of every switch is exactly
 * the stutter that makes a live preview feel like a render.
 */

import {
  coerceKnobValue,
  type EffectShader,
  type EffectsLook,
  type KnobValue,
} from '../looks'
import { linearRgb, type Ink } from '../inks'
import { BLUE_NOISE_MASK, BLUE_NOISE_SIZE } from './blue-noise'
import {
  fragmentSourceFor,
  MAX_INKS,
  SHADER_KERNEL_ORDER,
  VERTEX_SOURCE,
} from './shaders'

/** Anything the browser can hand a texture unit. */
export type EffectSource =
  | HTMLImageElement
  | HTMLVideoElement
  | ImageBitmap
  | HTMLCanvasElement

export interface EffectsRenderer {
  readonly canvas: HTMLCanvasElement
  /**
   * Draw one frame at `width × height` **output** pixels.
   *
   * The render size is the whole of what "1:1 versus fit" means: the pattern is
   * measured in output pixels, so the same look at the same cell size is the
   * same picture at any zoom rather than an upscaled approximation of one.
   */
  render(frame: EffectFrame): void
  /** Release the context's own memory. Safe to call twice. */
  dispose(): void
}

export interface EffectFrame {
  readonly source: EffectSource
  readonly look: EffectsLook
  readonly values: Readonly<Record<string, KnobValue>>
  /** The project's inks, darkest first — only the reduction shader reads them. */
  readonly inks: readonly Ink[]
  readonly width: number
  readonly height: number
  /**
   * Output pixels per look pixel — 1 unless this is a bigger export (#58).
   *
   * The shader divides its pattern coordinates by this, so a 2x bake draws the
   * look that was dialled in at the web width rather than a screen twice as
   * fine. Optional because every caller but the bake renders at scale 1, and a
   * required 1 on each of them would be a number to keep in step for nothing.
   */
  readonly scale?: number
  /**
   * How far into the effect this frame is, in seconds — 0 for a still look.
   *
   * **Never a wall clock.** The preview derives it from elapsed time, the bake
   * from `index / fps`, and those two have to agree or the export disagrees
   * with what was on screen — which is the one property this renderer exists to
   * guarantee (see the header of `shaders.ts`). Passing `performance.now()`
   * through here would make every bake a different film.
   *
   * Optional because the six reductive looks do not move, and a required 0 on
   * each of their call sites is a number to keep in step for nothing.
   */
  readonly time?: number
}

/** Whether this webview can render any of it at all. */
export function supportsWebGL2(): boolean {
  try {
    return (
      document.createElement('canvas').getContext('webgl2', {
        failIfMajorPerformanceCaveat: false,
      }) !== null
    )
  } catch {
    // A webview with canvas disabled outright throws rather than returning
    // null, and that is the same answer as far as the tab is concerned.
    return false
  }
}

/**
 * A renderer on a canvas, or `null` where WebGL2 is not available.
 *
 * `preserveDrawingBuffer` because the bake reads the canvas back after the draw
 * call returns; without it the contents are undefined by the time anything asks
 * for them, and the failure mode is an exported frame that is blank on some
 * drivers and correct on others.
 */
export function createEffectsRenderer(
  canvas: HTMLCanvasElement
): EffectsRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  })
  if (gl === null) return null

  const programs = new Map<EffectShader, WebGLProgram>()
  const uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation>>()

  const source = gl.createTexture()
  const noise = gl.createTexture()
  // No vertex buffer: the full-screen triangle is indexed out of
  // `gl_VertexID`. A VAO is still required in a core WebGL2 draw call.
  const emptyArray = gl.createVertexArray()

  uploadNoise(gl, noise)

  let disposed = false

  return {
    canvas,

    render(frame) {
      if (disposed) return

      const program = programFor(gl, programs, frame.look.shader)
      if (program === null) return

      canvas.width = Math.max(1, Math.round(frame.width))
      canvas.height = Math.max(1, Math.round(frame.height))
      gl.viewport(0, 0, canvas.width, canvas.height)

      gl.useProgram(program)
      gl.bindVertexArray(emptyArray)

      // Mipmaps only where something reads them. Building the chain for a video
      // frame costs real time, and only the pixelation shader samples above the
      // base level.
      uploadSource(gl, source, frame.source, frame.look.shader === 'pixelated')

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, source)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, noise)

      const at = locations(gl, program, uniforms)
      set(gl, at, 'uSource', location => gl.uniform1i(location, 0))
      set(gl, at, 'uNoise', location => gl.uniform1i(location, 1))
      set(gl, at, 'uNoiseSize', location =>
        gl.uniform1f(location, BLUE_NOISE_SIZE)
      )
      set(gl, at, 'uResolution', location =>
        gl.uniform2f(location, canvas.width, canvas.height)
      )
      set(gl, at, 'uScale', location =>
        gl.uniform1f(location, Math.max(frame.scale ?? 1, 1))
      )

      bindKnobs(gl, at, frame)
      bindInks(gl, at, frame.inks)

      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const program of programs.values()) gl.deleteProgram(program)
      programs.clear()
      uniforms.clear()
      gl.deleteTexture(source)
      gl.deleteTexture(noise)
      gl.deleteVertexArray(emptyArray)
    },
  }
}

/**
 * Every knob bound to `u_<key>`, by its declared kind.
 *
 * This loop is the payoff of declaring a knob once: a look that grows a knob
 * gets a uniform bound with no code written here, and a knob whose value has
 * drifted out of range is held to the descriptor on the way in rather than
 * reaching the shader as something it cannot use.
 */
function bindKnobs(
  gl: WebGL2RenderingContext,
  at: Map<string, WebGLUniformLocation>,
  frame: EffectFrame
): void {
  for (const knob of frame.look.knobs) {
    const value = coerceKnobValue(knob, frame.values[knob.key]) ?? knob.value
    const name = `u_${knob.key}`

    switch (knob.kind) {
      case 'slider':
      case 'angle':
        set(gl, at, name, location => gl.uniform1f(location, Number(value)))
        break
      case 'colour': {
        const [r, g, b] = linearRgb(String(value))
        set(gl, at, name, location => gl.uniform3f(location, r, g, b))
        break
      }
      case 'choice':
        // The *index*, which is what makes the binding generic. A kernel knob's
        // options are in `SHADER_KERNEL_ORDER` and a test holds them to it.
        set(gl, at, name, location =>
          gl.uniform1i(
            location,
            Math.max(0, knob.options.indexOf(String(value)))
          )
        )
        break
      case 'toggle':
        set(gl, at, name, location =>
          gl.uniform1i(location, value === true ? 1 : 0)
        )
        break
    }
  }
}

/** The project's palette, for the one shader that reduces to it. */
function bindInks(
  gl: WebGL2RenderingContext,
  at: Map<string, WebGLUniformLocation>,
  inks: readonly Ink[]
): void {
  if (at.get('uInks') === undefined) return

  const held = inks.slice(0, MAX_INKS)
  const colours = new Float32Array(MAX_INKS * 3)
  const luminances = new Float32Array(MAX_INKS)

  held.forEach((ink, index) => {
    const [r, g, b] = linearRgb(ink.hex)
    colours[index * 3] = r
    colours[index * 3 + 1] = g
    colours[index * 3 + 2] = b
    luminances[index] = ink.luminance
  })

  set(gl, at, 'uInks', location => gl.uniform3fv(location, colours))
  set(gl, at, 'uInkLuminance', location => gl.uniform1fv(location, luminances))
  set(gl, at, 'uInkCount', location => gl.uniform1i(location, held.length))
}

function set(
  gl: WebGL2RenderingContext,
  at: Map<string, WebGLUniformLocation>,
  name: string,
  apply: (location: WebGLUniformLocation) => void
): void {
  const location = at.get(name)
  // A uniform the shader does not declare — or declares and never reads, which
  // the compiler removes — is not an error. Every shader shares one preamble
  // and only some of them use the noise texture.
  if (location !== undefined) apply(location)
  void gl
}

function locations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  cache: Map<WebGLProgram, Map<string, WebGLUniformLocation>>
): Map<string, WebGLUniformLocation> {
  const known = cache.get(program)
  if (known !== undefined) return known

  const found = new Map<string, WebGLUniformLocation>()
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number

  for (let index = 0; index < count; index++) {
    const info = gl.getActiveUniform(program, index)
    if (info === null) continue
    // An array uniform reports as `uInks[0]`; the name callers use is `uInks`.
    const name = info.name.replace(/\[0\]$/, '')
    const location = gl.getUniformLocation(program, info.name)
    if (location !== null) found.set(name, location)
  }

  cache.set(program, found)
  return found
}

function programFor(
  gl: WebGL2RenderingContext,
  cache: Map<EffectShader, WebGLProgram>,
  shader: EffectShader
): WebGLProgram | null {
  const known = cache.get(shader)
  if (known !== undefined) return known

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSourceFor(shader))
  if (vertex === null || fragment === null) return null

  const program = gl.createProgram()
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    // Committed source, so this is our bug rather than the user's — but it must
    // not take the app down, because a driver we have never seen is exactly the
    // case #36 writes down as untested territory.
    console.error(
      `The ${shader} program did not link`,
      gl.getProgramInfoLog(program)
    )
    gl.deleteProgram(program)
    return null
  }

  cache.set(shader, program)
  return program
}

function compile(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(kind)
  if (shader === null) return null

  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    console.error(
      'An effect shader did not compile',
      gl.getShaderInfoLog(shader)
    )
    gl.deleteShader(shader)
    return null
  }

  return shader
}

/**
 * The frame, as a texture the shader reads in linear light.
 *
 * `SRGB8_ALPHA8` rather than `RGBA8`, and that is the whole colour decision:
 * the transfer function comes free in hardware, *and* the filtering happens on
 * decoded values. Doing the transfer in shader maths instead would mean every
 * filtered sample was an average of encoded bytes, which is the same class of
 * mistake as dithering them.
 */
function uploadSource(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  source: EffectSource,
  mipmapped: boolean
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.SRGB8_ALPHA8,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    source
  )

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  if (mipmapped) {
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR
    )
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  }
}

/**
 * The blue-noise mask, once.
 *
 * `NEAREST` and `REPEAT`, both load-bearing: the mask is a threshold *per
 * pixel* and interpolating between two thresholds would smear the very
 * structure that makes it blue, and it has to tile because it is 64 cells wide
 * and the frame is not.
 */
function uploadNoise(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8,
    BLUE_NOISE_SIZE,
    BLUE_NOISE_SIZE,
    0,
    gl.RED,
    gl.UNSIGNED_BYTE,
    BLUE_NOISE_MASK
  )

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
}

/** The kernel a look's value names, for deciding GPU versus CPU. */
export function kernelOf(
  values: Readonly<Record<string, KnobValue>>
): string | null {
  const kernel = values.kernel
  return typeof kernel === 'string' &&
    SHADER_KERNEL_ORDER.some(known => known === kernel)
    ? kernel
    : null
}
