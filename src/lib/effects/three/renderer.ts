/**
 * The gradient backend: a second renderer behind the same interface.
 *
 * `gl/renderer.ts` draws the six reductive looks by hand on one full-screen
 * triangle. That is the right shape for a treatment that *reads the source and
 * reduces it*, and the wrong shape for these, which are a lit 3D object with an
 * environment reflected in it. So this is a second implementation — but not a
 * second contract: it returns the same {@link EffectsRenderer}, so the preview
 * and the bake both reach it through `render(frame)` and neither knows which
 * backend it is talking to.
 *
 * That is what keeps "the exported file cannot disagree with what was on
 * screen" true. The guarantee was never about the shading language; it is about
 * one object drawing both, and it survives a second backend intact.
 *
 * ## Two contexts, on purpose
 *
 * `gl/renderer.ts` warns that "a WebGL context per look switch is how a webview
 * runs out of them", and it is right. This is not that: one context per
 * *backend*, both long-lived, created when first needed and released with the
 * tab. Two is a constant, not a leak.
 *
 * ## The composite, and why the source is not the scene background
 *
 * Setting `scene.background` would draw the picture behind the mesh and then
 * the mesh over it — which is `normal` blending and nothing else. The gradient
 * instead renders to its own target and a second pass blends it over the
 * source, which is how upstream does it (an `EffectComposer` with a blend
 * pass) and what makes soft light available at all. See `composite.ts`.
 */

import {
  ClampToEdgeWrapping,
  DoubleSide,
  IcosahedronGeometry,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderLib,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  UniformsUtils,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderer,
  WebGLRenderTarget,
  type BufferGeometry,
  type IUniform,
} from 'three'

import type { EffectFrame, EffectsRenderer, EffectSource } from '../gl/renderer'
import { coerceKnobValue } from '../looks'
import {
  BLEND_MODES,
  blendIndex,
  COMPOSITE_FRAGMENT,
  COMPOSITE_VERTEX,
  isBlendMode,
} from './composite'
import {
  createGradientEnvironment,
  type GradientEnvironment,
} from './environment'
import {
  isGradientFamily,
  isGradientForm,
  programFor,
  type GradientFamily,
  type GradientForm,
} from './programs'

/**
 * Upstream's mesh resolutions, kept exactly.
 *
 * The `1` on the plane's width segments is not a typo and not an optimisation:
 * with no horizontal subdivision the displacement can only vary down the mesh,
 * so it folds like a hanging curtain rather than rippling like a sheet. It is
 * the entire difference between `plane` and `waterPlane`.
 */
const MESH_DETAIL = 192

function geometryFor(form: GradientForm): BufferGeometry {
  if (form === 'plane') return new PlaneGeometry(10, 10, 1, MESH_DETAIL)
  if (form === 'waterPlane')
    return new PlaneGeometry(10, 10, MESH_DETAIL, MESH_DETAIL)
  return new IcosahedronGeometry(1, MESH_DETAIL / 3)
}

/**
 * Where the camera sits, per form.
 *
 * Close, and that is the point: the mesh is ten units across and the camera is
 * under four away with a 45° lens, so only about three units of it are ever on
 * screen. That is what makes one noise period fill the frame instead of twenty,
 * and it is the setting that separates "a big soft gradient" from "a texture".
 */
const CAMERA_DISTANCE: Readonly<Record<GradientForm, number>> = {
  plane: 3.6,
  waterPlane: 4.4,
  sphere: 3.0,
}

/**
 * The knobs a look declares, mapped to the uniform names upstream's shaders
 * actually read.
 *
 * `gl/renderer.ts` binds a knob `cell` to `u_cell` with no table anywhere, and
 * that is a genuinely better arrangement. It is not available here: these
 * shaders are upstream's, their uniform names are upstream's, and renaming
 * `uNoiseDensity` to `u_density` inside them would fork the maths from the
 * source it is meant to reproduce. So the bridge is explicit, small, and lives
 * in one place.
 */
const SCALAR_UNIFORMS: Readonly<Record<string, string>> = {
  density: 'uNoiseDensity',
  strength: 'uNoiseStrength',
  speed: 'uSpeed',
  amplitude: 'uAmplitude',
  frequency: 'uFrequency',
}

/**
 * Everything upstream's shaders read that this app does not offer as a knob.
 *
 * Held at upstream's own defaults. They are here rather than absent because a
 * missing uniform is not a compile error in GLSL — it reads as zero, and a
 * zero `uTransparency` is a look that renders black with nothing to explain it.
 */
const FIXED_UNIFORMS: Readonly<Record<string, number>> = {
  uLoadingTime: 1,
  uLoop: 0,
  uLoopDuration: 6,
  uReflectivity: 0.6,
  uRefraction: 1.3,
  uChromaticAberration: 0.02,
  uFresnelPower: 2.5,
  uTransparency: 0.85,
  uDistortion: 0.2,
  uLiquidEffect: 0.6,
  uFoamIntensity: 0.3,
  uWaveAmplitude: 0.4,
  uWaveFrequency: 1.2,
  uFlowSpeed: 0.3,
}

/**
 * Write `name` if this program declares it.
 *
 * Absent is normal, not exceptional: the three families read overlapping but
 * different uniform sets — only `defaults` has `uAmplitude`, only `glass` has
 * `uFresnelPower` — and one bag is fed to all of them.
 */
function setUniform(
  uniforms: Readonly<Record<string, IUniform>>,
  name: string,
  value: number
): void {
  const uniform = uniforms[name]
  if (uniform) uniform.value = value
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ]
}

/** A look's `form` knob, or the plane it falls back to. */
function formOf(frame: EffectFrame): GradientForm {
  const knob = frame.look.knobs.find(entry => entry.key === 'form')
  const value = knob
    ? (coerceKnobValue(knob, frame.values.form) ?? knob.value)
    : null
  return isGradientForm(value) ? value : 'plane'
}

function familyOf(frame: EffectFrame): GradientFamily {
  const family = frame.look.shader.replace(/^gradient/, '').toLowerCase()
  return isGradientFamily(family) ? family : 'defaults'
}

function numberKnob(frame: EffectFrame, key: string, fallback: number): number {
  const knob = frame.look.knobs.find(entry => entry.key === key)
  if (!knob) return fallback
  const value = coerceKnobValue(knob, frame.values[key]) ?? knob.value
  return typeof value === 'number' ? value : fallback
}

function colourKnob(frame: EffectFrame, key: string, fallback: string): string {
  const knob = frame.look.knobs.find(entry => entry.key === key)
  if (!knob) return fallback
  const value = coerceKnobValue(knob, frame.values[key]) ?? knob.value
  return typeof value === 'string' && value.startsWith('#') ? value : fallback
}

/**
 * A renderer on `canvas`, or `null` where WebGL2 is unavailable.
 *
 * `preserveDrawingBuffer` for the same reason the other backend sets it: the
 * bake reads the canvas back after `render` returns, and without it the
 * contents are undefined by then on some drivers — a blank exported frame on
 * machines nobody tested and a correct one everywhere else.
 */
export function createGradientRenderer(
  canvas: HTMLCanvasElement
): EffectsRenderer | null {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    })
  } catch {
    return null
  }

  renderer.outputColorSpace = SRGBColorSpace

  let environment: GradientEnvironment | null = null

  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 0.1, 100)

  const compositeScene = new Scene()
  const compositeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const compositeUniforms = {
    uBase: { value: null } as IUniform,
    uOverlay: { value: null } as IUniform,
    uOpacity: { value: 1 } as IUniform,
    uBlend: { value: 0 } as IUniform,
  }
  const compositeMesh = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: compositeUniforms,
      depthTest: false,
      depthWrite: false,
    })
  )
  compositeScene.add(compositeMesh)

  let target: WebGLRenderTarget | null = null

  /**
   * The footage, as a texture three will actually upload.
   *
   * A plain `Texture` is right for a still and silently wrong for a clip: three
   * sizes the upload from `image.width`, which a bare `<video>` reports as 0, so
   * the clip arrives empty. Nothing errors — the composite simply blends against
   * black, which reads as "the gradient works but the footage is gone", and
   * every mode that derives from the base collapses with it. Soft light is the
   * loudest: against a black base it returns black, so the look appears to draw
   * nothing while `normal` appears to work.
   *
   * `VideoTexture` is three's own answer — it reads `videoWidth` and re-uploads
   * per frame by itself. `gl/renderer.ts` never had to care, because the raw
   * `texImage2D(..., element)` overload takes the intrinsic size from the
   * element: the same service, one layer down.
   */
  let sourceTexture: Texture | null = null
  let sourceElement: EffectSource | null = null

  function textureFor(source: EffectSource): Texture {
    if (sourceTexture !== null && sourceElement === source) {
      // A `VideoTexture` re-uploads itself; anything else has to be asked, and
      // asking unconditionally costs one boolean and removes a class of bug
      // where a look switch leaves the previous frame's pixels on screen.
      if (!(sourceTexture instanceof VideoTexture)) {
        sourceTexture.needsUpdate = true
      }
      return sourceTexture
    }

    sourceTexture?.dispose()
    const texture =
      source instanceof HTMLVideoElement
        ? new VideoTexture(source)
        : new Texture(source)
    texture.colorSpace = SRGBColorSpace
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = ClampToEdgeWrapping
    texture.wrapT = ClampToEdgeWrapping
    texture.needsUpdate = true
    sourceTexture = texture
    sourceElement = source
    return texture
  }

  /** One mesh per family+form, built on first use and kept. */
  const meshes = new Map<string, Mesh>()
  const uniformsFor = new Map<string, Record<string, IUniform>>()

  let current: Mesh | null = null
  let disposed = false

  function meshFor(family: GradientFamily, form: GradientForm): Mesh {
    const key = `${family}/${form}`
    const existing = meshes.get(key)
    if (existing) return existing

    const program = programFor(family, form)
    const uniforms: Record<string, IUniform> = {
      uTime: { value: 0 },
      uSpeed: { value: 0.3 },
      uNoiseDensity: { value: 1.2 },
      uNoiseStrength: { value: 2.5 },
      uFlowDirection: { value: new Vector2(1, 0.4) },
      uColor1: { value: new Vector3(1, 0.3, 0) },
      uColor2: { value: new Vector3(0.85, 0.73, 0.58) },
      uColor3: { value: new Vector3(0.81, 0.73, 0.88) },
    }
    for (const [name, value] of Object.entries(FIXED_UNIFORMS)) {
      uniforms[name] = { value }
    }
    for (const channel of ['C1', 'C2', 'C3']) {
      for (const component of ['r', 'g', 'b']) {
        uniforms[`u${channel}${component}`] = { value: 0 }
      }
    }

    // A `ShaderMaterial`, and this is where we part company with upstream.
    //
    // Upstream patches a `MeshPhysicalMaterial` through `onBeforeCompile`, and
    // that worked on the three it pins (`^0.169.0`). It does not compile on the
    // one this app pins: three assembles the physical material's own chunk set
    // *around* a source that already includes those chunks itself, and glass
    // dies on the collision — `reflectivity` and `vReflect` redefined, and a
    // `textureCubeUV` call with no definition, because glass is the one family
    // that omits `<cube_uv_reflection_fragment>`. A program that does not link
    // is a mesh that draws nothing, and the composite then passes the footage
    // through untouched, which is a look that silently does nothing at all.
    //
    // Compiling the ported source *as* the whole program removes the collision
    // by removing the second author: three contributes the standard prefix and
    // resolves the `#include`s, and every material define is one we state here.
    // That is also what finally makes `environment.ts` right — nothing else
    // gets to decide between `ENVMAP_TYPE_CUBE` and the PMREM path, so glass's
    // own `textureCube` refraction is the branch that runs.
    const material = new ShaderMaterial({
      vertexShader: program.vertex,
      fragmentShader: program.fragment,
      // Every uniform a physical shader reads, then ours over the top. Taken
      // wholesale rather than assembled by hand: the ported source includes the
      // lighting and env-map chunks, so it reads `roughness`, `metalness` and
      // the light arrays whether or not this file mentions them, and a missing
      // one is a silent zero rather than a compile error.
      uniforms: UniformsUtils.merge([ShaderLib.physical.uniforms, uniforms]),
      defines: {
        STANDARD: '',
        PHYSICAL: '',
        USE_ENVMAP: '',
        ENVMAP_TYPE_CUBE: '',
        ENVMAP_MODE_REFLECTION: '',
      },
      // The light uniforms are only refreshed for a material that says it wants
      // them, and the physical chunks read them unconditionally.
      lights: true,
      // Upstream's, and load-bearing on the displaced forms: the wave turns
      // parts of the mesh away from the camera, and single-sided those become
      // holes in the middle of the gradient.
      side: DoubleSide,
    })

    // `merge` clones, so the live bag is the material's own rather than the one
    // built above — mutating the original would write to nothing.
    const live = material.uniforms
    const envMap = live.envMap
    if (envMap) envMap.value = environment?.texture ?? null
    setUniform(live, 'metalness', 0.2)
    setUniform(live, 'roughness', 0.4)

    const mesh = new Mesh(geometryFor(form), material)
    meshes.set(key, mesh)
    uniformsFor.set(key, live)
    return mesh
  }

  return {
    canvas,

    render(frame) {
      if (disposed) return

      environment ??= createGradientEnvironment(renderer)

      const width = Math.max(1, Math.round(frame.width))
      const height = Math.max(1, Math.round(frame.height))
      renderer.setSize(width, height, false)

      if (target === null) {
        target = new WebGLRenderTarget(width, height, { format: RGBAFormat })
      } else if (target.width !== width || target.height !== height) {
        target.setSize(width, height)
      }

      const family = familyOf(frame)
      const form = formOf(frame)
      const key = `${family}/${form}`
      const mesh = meshFor(family, form)
      const uniforms = uniformsFor.get(key)
      if (!uniforms) return

      if (current !== mesh) {
        if (current) scene.remove(current)
        scene.add(mesh)
        current = mesh
      }

      // Upstream's rotationX / rotationZ. Half its presets leave the tilt at
      // zero and do all their composition with the roll, which turns the
      // colour axis diagonal without moving the camera.
      //
      // Declared as `angle` knobs, so they arrive in degrees — upstream's own
      // unit, and the one a preset's 225 is written in. `Object3D.rotation` is
      // radians, and feeding it degrees would spin a 225° roll through 35 turns
      // and land somewhere nobody chose.
      mesh.rotation.x = degreesToRadians(numberKnob(frame, 'tilt', 0))
      mesh.rotation.z = degreesToRadians(numberKnob(frame, 'roll', 0))

      camera.position.set(0, 0, CAMERA_DISTANCE[form])
      camera.aspect = width / height
      camera.updateProjectionMatrix()

      setUniform(uniforms, 'uTime', frame.time ?? 0)
      for (const [knob, name] of Object.entries(SCALAR_UNIFORMS)) {
        const uniform = uniforms[name]
        if (uniform) {
          uniform.value = numberKnob(frame, knob, uniform.value as number)
        }
      }

      // Upstream's own Halo colours, so a look with nothing dialled in still
      // renders the picture the preset is named after.
      const COLOURS = [
        ['colour1', '#ff5005'],
        ['colour2', '#dbba95'],
        ['colour3', '#d0bce1'],
      ] as const
      COLOURS.forEach(([knob, fallback], index) => {
        const [r, g, b] = hexToRgb(colourKnob(frame, knob, fallback))
        const channel = `C${index + 1}`
        setUniform(uniforms, `u${channel}r`, r)
        setUniform(uniforms, `u${channel}g`, g)
        setUniform(uniforms, `u${channel}b`, b)
        // The glass family takes its colours as vec3 rather than as nine
        // floats, so both shapes are kept fed and each shader reads the one it
        // declares.
        const packed = uniforms[`uColor${index + 1}`]
        if (packed) (packed.value as Vector3).set(r, g, b)
      })

      const source = textureFor(frame.source)

      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 0)
      renderer.clear()
      renderer.render(scene, camera)

      const blend = frame.look.knobs.find(entry => entry.key === 'blend')
      const blendValue = blend
        ? (coerceKnobValue(blend, frame.values.blend) ?? blend.value)
        : 'normal'

      compositeUniforms.uBase.value = source
      compositeUniforms.uOverlay.value = target.texture
      compositeUniforms.uOpacity.value = numberKnob(frame, 'opacity', 1)
      compositeUniforms.uBlend.value = isBlendMode(blendValue)
        ? blendIndex(blendValue)
        : BLEND_MODES.indexOf('normal')

      renderer.setRenderTarget(null)
      renderer.render(compositeScene, compositeCamera)
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const mesh of meshes.values()) {
        mesh.geometry.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach(entry => entry.dispose())
        else material.dispose()
      }
      meshes.clear()
      uniformsFor.clear()
      compositeMesh.geometry.dispose()
      ;(compositeMesh.material as ShaderMaterial).dispose()
      sourceTexture?.dispose()
      target?.dispose()
      environment?.dispose()
      renderer.dispose()
    },
  }
}
