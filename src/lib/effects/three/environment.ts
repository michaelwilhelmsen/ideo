/**
 * The environment the gradients are lit by.
 *
 * This is the thing a hand-rolled fragment shader cannot fake, and the reason
 * the gradient looks land at all: upstream's presets all name an `envPreset`,
 * and what that buys is image-based lighting — a highlight whose colour comes
 * from a surrounding scene rather than from one hard-coded light vector. A
 * faked sky gradient reads as a filter; this reads as a material.
 *
 * **A `CubeTexture`, deliberately, and not a PMREM one.** The modern three path
 * is `PMREMGenerator`, whose output is sampled with `textureCubeUV`. The glass
 * family samples `textureCube` under `#ifdef ENVMAP_TYPE_CUBE` — that define is
 * only set when `material.envMap` is an actual `CubeTexture`, so a PMREM
 * texture would compile to the branch that never runs and glass would lose its
 * refraction with no error anywhere. Baking a cube once at init keeps every
 * family on one code path.
 *
 * **Procedural, so nothing is fetched.** `RoomEnvironment` is geometry and
 * emissive materials, not an HDR file: no asset in the bundle, no network on
 * first paint, and nothing for a webview's CSP to refuse.
 *
 * Built once per renderer and reused for every frame and every look — it does
 * not depend on the source, the knobs or the time.
 */

import {
  CubeCamera,
  Scene,
  WebGLCubeRenderTarget,
  type CubeTexture,
  type WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/**
 * How many pixels each cube face gets.
 *
 * 256 rather than higher because nothing here reads a sharp reflection: the
 * gradients are low-roughness but very low-frequency, and glass blurs its own
 * samples in the shader. A larger cube costs init time and VRAM for detail
 * that the first `mix` throws away.
 */
const FACE_SIZE = 256

export interface GradientEnvironment {
  readonly texture: CubeTexture
  dispose(): void
}

/**
 * Bake `RoomEnvironment` into a cube map with `renderer`.
 *
 * Leaves the renderer's own render target and tone mapping as it found them:
 * this runs inside a renderer that is also drawing frames, and a `CubeCamera`
 * that quietly rebinds the target is a black canvas on the next draw.
 */
export function createGradientEnvironment(
  renderer: WebGLRenderer
): GradientEnvironment {
  const target = new WebGLCubeRenderTarget(FACE_SIZE)
  const camera = new CubeCamera(0.1, 100, target)
  const room = new RoomEnvironment()
  const scene = new Scene()
  scene.add(room)

  const previousTarget = renderer.getRenderTarget()
  camera.update(renderer, scene)
  renderer.setRenderTarget(previousTarget)

  // The room's geometry and materials have done their job the moment the cube
  // is baked; only the texture outlives this call.
  room.traverse(object => {
    if ('geometry' in object) {
      const mesh = object as { geometry?: { dispose(): void } }
      mesh.geometry?.dispose()
    }
    if ('material' in object) {
      const mesh = object as { material?: { dispose(): void } }
      mesh.material?.dispose()
    }
  })
  scene.clear()

  return {
    texture: target.texture,
    dispose() {
      target.dispose()
    },
  }
}
