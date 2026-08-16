/**
 * How the gradient lands on the picture underneath it.
 *
 * The blend formulas are upstream's — `postprocessing`'s blending catalogue, as
 * vendored into `ruucm/shadergradient`. Matching them is the point rather than
 * a convenience: soft light in particular has two competing definitions, and
 * the one below is Pegtop's continuous curve, not the W3C piecewise one. They
 * differ visibly in the midtones, so a hand-rolled "soft light" would grade
 * footage differently from the tool this look is meant to reproduce.
 *
 * The upstream contract is one function per mode with the signature
 * `blend(x, y, opacity)`, where `x` is what is already there and `y` is the
 * layer going on, and where opacity is always applied the same way at the end:
 *
 *     return z * opacity + x * (1.0 - opacity)
 *
 * That last line is why opacity never needs to appear inside a mode's own
 * maths, and why adding a mode is one branch and nothing else.
 *
 * **One deviation, and it is deliberate.** Upstream blends the alpha channel
 * along with the colour, which is right when both layers cover the frame — as
 * their plane and waterPlane always do. A sphere does not: it leaves the
 * corners empty, and blending a transparent overlay through soft light darkens
 * those corners instead of leaving them alone. So the effective opacity here is
 * multiplied by the overlay's own alpha, which is a no-op wherever upstream's
 * assumption holds and the correct answer where it does not.
 */

/**
 * The modes offered, in the order a Blend control lists them.
 *
 * Deliberately a subset of upstream's eighteen. The ones left out — divide,
 * negation, reflect, colour burn and the rest — are either destructive on
 * footage or duplicate a neighbour closely enough that offering both is a
 * choice with no consequence.
 */
export const BLEND_MODES = [
  'normal',
  'softLight',
  'screen',
  'overlay',
  'multiply',
  'lighten',
  'darken',
  'add',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export function isBlendMode(value: unknown): value is BlendMode {
  return (BLEND_MODES as readonly unknown[]).includes(value)
}

/** The index the shader switches on, so a choice knob binds as an int. */
export function blendIndex(mode: BlendMode): number {
  return BLEND_MODES.indexOf(mode)
}

export const COMPOSITE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * The composite pass.
 *
 * Works in display space, not linear light. That is the opposite of the
 * house rule in `gl/shaders.ts`, and it is right here for the same reason that
 * rule exists elsewhere: these formulas are *defined* on display-referred
 * values. Soft light computed in linear light is a different curve wearing the
 * same name, and would not match either the reference tool or what the number
 * means in any editor the user already knows.
 */
export const COMPOSITE_FRAGMENT = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uBase;
uniform sampler2D uOverlay;
uniform float uOpacity;
uniform int uBlend;

float blendChannel(float x, float y, int mode) {
  if (mode == 1) {
    // Soft light, Pegtop's continuous form.
    return (y < 0.5)
      ? (2.0 * x * y + x * x * (1.0 - 2.0 * y))
      : (sqrt(x) * (2.0 * y - 1.0) + 2.0 * x * (1.0 - y));
  }
  if (mode == 2) return 1.0 - (1.0 - x) * (1.0 - y);
  if (mode == 3) return (x < 0.5) ? (2.0 * x * y) : (1.0 - 2.0 * (1.0 - x) * (1.0 - y));
  if (mode == 4) return x * y;
  if (mode == 5) return max(x, y);
  if (mode == 6) return min(x, y);
  if (mode == 7) return min(x + y, 1.0);
  return y;
}

void main() {
  vec4 base = texture2D(uBase, vUv);
  vec4 overlay = texture2D(uOverlay, vUv);

  vec3 blended = vec3(
    blendChannel(base.r, overlay.r, uBlend),
    blendChannel(base.g, overlay.g, uBlend),
    blendChannel(base.b, overlay.b, uBlend)
  );

  // See the module comment: the overlay's own coverage gates the blend, so a
  // form that does not fill the frame leaves the rest of the picture alone.
  float amount = uOpacity * overlay.a;

  gl_FragColor = vec4(mix(base.rgb, blended, amount), 1.0);
}
`
