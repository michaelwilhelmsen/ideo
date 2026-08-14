/**
 * The effects library — the fourth committed JSON, and the one #36 adds.
 *
 * A **look** is one authored effect with knobs, not a stack the user assembles.
 * That is load-bearing rather than tidy: with a composable chain, a duotone pass
 * followed by a dither pass produces nothing — the first leaves no tonal
 * information for the second to distribute — so the two would have to be
 * silently fused, and a user could still assemble combinations that do nothing
 * at all. One authored look per entry means the shader does the whole thing
 * correctly by construction and **every look in the library produces something**.
 *
 * Two declarations, and only one of them lives here:
 *
 * - **The shader** is ours, keyed by {@link EffectShader}, and it is code. A
 *   fork cannot invent one, because a look naming a shader nobody wrote is a
 *   black rectangle with a name on it.
 * - **The knobs** are data, declared once per look, and drive three things from
 *   that one declaration: the rendered control, the validation of a hand-edited
 *   fork, and the uniform binding. Adding a look is *data plus (maybe) a
 *   shader*, never data plus a shader plus a form plus a validator.
 *
 * What keeps those two honest with each other is {@link SHADER_KNOBS}: a shader
 * names the keys it reads, and a look declaring a knob its shader has never
 * heard of — or omitting one it needs — is refused at load. That check is a
 * *coupling* check and not a second declaration: the kind, the range and the
 * default are stated exactly once, in the JSON.
 *
 * Two looks may share a shader with different defaults, which is the growth
 * path: "Riso halftone" and "Newsprint halftone" are one shader and two
 * authored sets of numbers. The first library ships one look per shader because
 * six looks is what #36 promises, not because the schema wants it that way.
 *
 * Validated at module load like the preset libraries and the registry, and for
 * the same reason: committed JSON with a typo in it should be a startup crash
 * rather than a control with no range.
 */

import { asRecord, isRecord } from '@/lib/recipe/json'
import {
  isHex,
  isPaletteRole,
  paletteEntryFor,
  type Palette,
} from '@/lib/recipe/palette'
import { isPresetId } from '@/lib/recipe/presets'
import type { TreatmentValue } from '@/lib/recipe/types'
import LIBRARY_DOCUMENT from './looks.json'

/** Bumped when a library written today would be misread by an older build. */
export const EFFECTS_LIBRARY_VERSION = 1

/**
 * The shaders that exist. One per visual family, not one per look.
 *
 * A closed list because each entry is a program somebody wrote: the renderer
 * switches on it, and a value with no program behind it is a look that renders
 * nothing. camelCase because each is also a translation-key segment.
 */
export const EFFECT_SHADERS = [
  'duotone',
  'halftone',
  'paletteReduced',
  'posterised',
  'pixelated',
  'grained',
] as const

export type EffectShader = (typeof EFFECT_SHADERS)[number]

/**
 * The dither kernels a look may offer.
 *
 * #53's five, plus **blue noise**, which is ours rather than a recipe's: it is
 * the video-safe substitute for error diffusion — a precomputed mask, so fully
 * parallel and *temporally stable by construction*, which is precisely what
 * Floyd–Steinberg and Atkinson catastrophically lack. A recipe cannot declare it
 * because #53's vocabulary was settled before this ticket existed and widening
 * it there would mean a preset field naming something no preset author has ever
 * seen.
 *
 * The ordered/diffusion partition is a property of the kernels themselves
 * (#53), so it is derived here rather than restated per look — see
 * {@link isDiffusionKernel}, which is what decides whether a look renders on the
 * GPU or has to go to the CPU.
 */
export const EFFECT_KERNELS = [
  'bayer4',
  'bayer8',
  'clustered8',
  'blueNoise',
  'floydSteinberg',
  'atkinson',
] as const

export type EffectKernel = (typeof EFFECT_KERNELS)[number]

/**
 * Whether this kernel's output depends on output pixels already decided.
 *
 * The one property that changes where a look runs: error diffusion is
 * sequential by construction and cannot be a fragment shader, so a look whose
 * kernel knob says one of these renders on the CPU instead — stills only, per
 * #36, because the crawl between frames is the failure mode the research flags
 * as most objectionable.
 */
export function isDiffusionKernel(value: string): boolean {
  return value === 'floydSteinberg' || value === 'atkinson'
}

/** How the levels a dither quantises to are spaced — #53's vocabulary. */
export const EFFECT_LEVEL_PLACEMENTS = ['paletteShaped', 'even'] as const

export type EffectLevelPlacement = (typeof EFFECT_LEVEL_PLACEMENTS)[number]

/** Every kind of control a knob can be. */
export const KNOB_KINDS = [
  'slider',
  'angle',
  'colour',
  'choice',
  'toggle',
] as const

export type KnobKind = (typeof KNOB_KINDS)[number]

/**
 * What one knob is worth.
 *
 * The same three scalars a treatment persists, aliased rather than restated:
 * a knob's value and a stored treatment value are the same thing seen from two
 * sides, and two declarations of it would eventually disagree.
 */
export type KnobValue = TreatmentValue

/**
 * One knob, declared once.
 *
 * `key` is an identifier rather than a label: it names the uniform, it is the
 * segment a translation key is built from, and it is what a persisted treatment
 * stores. Nothing here holds English — a look's `name` is user data and
 * everything else the UI says comes out of `/locales`.
 */
export type KnobDescriptor =
  /** A number with a range and a step. */
  | {
      readonly kind: 'slider'
      readonly key: string
      readonly min: number
      readonly max: number
      readonly step: number
      readonly value: number
    }
  /**
   * Degrees. A range of its own rather than a slider from 0 to 360, because a
   * screen angle *wraps* — 375° and 15° are the same screen — and a slider that
   * clamps at its ends would make the one control that genuinely rotates feel
   * like it hits a wall.
   */
  | { readonly kind: 'angle'; readonly key: string; readonly value: number }
  /**
   * An ink. The default may name a palette role instead of a hex, and usually
   * does: a duotone whose inks arrive as the project's own `ink` and `paper` is
   * a look that already belongs to the project it opened in. Resolved at seed
   * time by {@link defaultKnobValues}, exactly like a preset's `{{primary}}` —
   * and only the resolved hex is ever persisted, because a treatment that
   * resolved against a mutable palette at read time would change under an image
   * somebody already approved.
   */
  | { readonly kind: 'colour'; readonly key: string; readonly value: string }
  /** One of a closed list. */
  | {
      readonly kind: 'choice'
      readonly key: string
      readonly options: readonly string[]
      readonly value: string
    }
  | { readonly kind: 'toggle'; readonly key: string; readonly value: boolean }

/**
 * One authored look.
 *
 * `name` is user data — looks are forkable like presets — so no `t()` ever goes
 * near it. Everything else is either a closed vocabulary or a number.
 */
export interface EffectsLook {
  readonly id: string
  readonly name: string
  /** The program that renders it. */
  readonly shader: EffectShader
  /** One line on what this look is for, or `null` where nobody wrote one. */
  readonly blurb: string | null
  /** In the order the controls should be drawn. */
  readonly knobs: readonly KnobDescriptor[]
}

export interface EffectsLibrary {
  readonly version: number
  readonly looks: readonly EffectsLook[]
}

/**
 * Which knob keys each shader reads, in the order they should be drawn.
 *
 * The coupling check, and the *only* thing about a knob this file states twice.
 * A look that declares `cell` on the duotone shader gets a control nothing is
 * bound to; a look that omits `inkDark` gets a uniform with nothing in it. Both
 * are caught at load rather than rendering as a look that came out wrong.
 */
export const SHADER_KNOBS: Readonly<Record<EffectShader, readonly string[]>> = {
  duotone: ['inkDark', 'inkLight', 'levels', 'kernel'],
  halftone: ['inkDark', 'inkLight', 'cell', 'angle', 'shape'],
  paletteReduced: ['entries', 'kernel', 'levelPlacement'],
  posterised: ['levels'],
  pixelated: ['cell'],
  grained: ['amount', 'seed', 'monochrome'],
}

/**
 * A library from an untrusted document, or a throw naming what was wrong.
 *
 * Exported for the reason `readPresetLibrary` is: the built-ins are not the only
 * source, and a user's fork is a file somebody could have hand-edited.
 */
export function readEffectsLibrary(document: unknown): EffectsLibrary {
  const record = asRecord(document, 'effects library')

  const version = record.version
  if (version !== EFFECTS_LIBRARY_VERSION) {
    throw new Error(
      `Effects library version ${String(version)} is not version ${EFFECTS_LIBRARY_VERSION}`
    )
  }

  const documents = record.looks
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('Effects library lists no looks')
  }

  const seen = new Set<string>()
  const looks = documents.map(entry => {
    const look = readLook(entry)
    if (seen.has(look.id)) {
      throw new Error(`Effect "${look.id}" is declared twice`)
    }
    seen.add(look.id)
    return look
  })

  return { version, looks }
}

function readLook(document: unknown): EffectsLook {
  const record = asRecord(document, 'effect')

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') throw new Error('An effect has no id')

  const fail = (problem: string): never => {
    throw new Error(`Effect "${id}": ${problem}`)
  }

  // Every id here becomes a file name in app data eventually — a fork takes one
  // from the look it was forked from — so the same rule Rust enforces on preset
  // files is checked here, on ours as well as theirs.
  if (!isPresetId(id)) fail('is not an id a file can be named')

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') fail('has no name')

  const shader = record.shader
  if (!EFFECT_SHADERS.some(known => known === shader)) {
    fail(`names a shader nobody wrote: ${String(shader)}`)
  }

  const blurb =
    record.blurb === undefined || record.blurb === null
      ? null
      : typeof record.blurb === 'string' && record.blurb.trim() !== ''
        ? record.blurb.trim()
        : fail('has an empty blurb')

  const knobs = readKnobs(record.knobs, shader as EffectShader, fail)

  return { id, name, shader: shader as EffectShader, blurb, knobs }
}

function readKnobs(
  document: unknown,
  shader: EffectShader,
  fail: (problem: string) => never
): readonly KnobDescriptor[] {
  if (!Array.isArray(document)) fail('has no knobs')

  const knobs = document.map(entry => readKnob(entry, fail))

  // Exactly the shader's keys, in the shader's order. Not a subset and not a
  // superset: a missing knob is a uniform with nothing in it, and a surplus one
  // is a control the picture does not answer to.
  const declared = knobs.map(knob => knob.key)
  const required = SHADER_KNOBS[shader]
  const sorted = [...declared].sort()
  const expected = [...required].sort()
  if (
    sorted.length !== expected.length ||
    sorted.some((key, at) => key !== expected[at])
  ) {
    fail(
      `declares knobs [${declared.join(', ')}] where the ${shader} shader reads [${required.join(', ')}]`
    )
  }

  // Drawn in the shader's order rather than the file's, so two looks on one
  // shader cannot present the same controls in two different orders.
  return required.map(
    key => knobs.find(knob => knob.key === key) as KnobDescriptor
  )
}

function readKnob(
  document: unknown,
  fail: (problem: string) => never
): KnobDescriptor {
  if (!isRecord(document)) fail('has a knob that is not a descriptor')

  const key = typeof document.key === 'string' ? document.key.trim() : ''
  if (key === '') fail('has a knob with no key')

  const kind = document.kind
  if (!KNOB_KINDS.some(known => known === kind)) {
    fail(`knob "${key}" has a kind we cannot draw: ${String(kind)}`)
  }

  switch (kind as KnobKind) {
    case 'slider': {
      const min = asFiniteNumber(document.min, key, 'min', fail)
      const max = asFiniteNumber(document.max, key, 'max', fail)
      const step = asFiniteNumber(document.step, key, 'step', fail)
      const value = asFiniteNumber(document.value, key, 'value', fail)
      if (max <= min) fail(`knob "${key}" has a range that is not one`)
      if (step <= 0) fail(`knob "${key}" has a step of ${step}`)
      if (value < min || value > max) {
        fail(`knob "${key}" defaults to ${value}, outside ${min}–${max}`)
      }
      return { kind: 'slider', key, min, max, step, value }
    }
    case 'angle': {
      const value = asFiniteNumber(document.value, key, 'value', fail)
      return { kind: 'angle', key, value: wrapAngle(value) }
    }
    case 'colour': {
      const value = document.value
      // A role name is as legitimate a default as a hex, and is how a look
      // arrives already wearing the project's own inks.
      if (
        typeof value !== 'string' ||
        !(isHex(value) || isPaletteRole(value))
      ) {
        fail(
          `knob "${key}" defaults to something that is neither a colour nor a palette role: ${String(value)}`
        )
      }
      return { kind: 'colour', key, value }
    }
    case 'choice': {
      const options = document.options
      if (
        !Array.isArray(options) ||
        options.length === 0 ||
        options.some(option => typeof option !== 'string' || option === '')
      ) {
        fail(`knob "${key}" offers no options`)
      }
      const value = document.value
      if (typeof value !== 'string' || !options.includes(value)) {
        fail(
          `knob "${key}" defaults to something it does not offer: ${String(value)}`
        )
      }
      return {
        kind: 'choice',
        key,
        options: options as readonly string[],
        value,
      }
    }
    case 'toggle': {
      if (typeof document.value !== 'boolean') {
        fail(`knob "${key}" defaults to something that is not on or off`)
      }
      return { kind: 'toggle', key, value: document.value }
    }
  }
}

function asFiniteNumber(
  value: unknown,
  key: string,
  field: string,
  fail: (problem: string) => never
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`knob "${key}" has a ${field} that is not a number: ${String(value)}`)
  }
  return value
}

/** Degrees, brought into `0..360` — a screen angle wraps rather than clamping. */
export function wrapAngle(degrees: number): number {
  const wrapped = degrees % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * What a look starts at, in this project.
 *
 * Colour knobs whose default names a palette role resolve here, against the
 * project's own six (#46) — so opening the tab on a project whose ink is a warm
 * near-black gives a duotone in that near-black rather than in ours. A role the
 * palette somehow cannot answer falls back to black, which is a colour and not a
 * crash: the alternative is a look that refuses to open because one slot was
 * hand-edited out of a manifest.
 */
export function defaultKnobValues(
  look: EffectsLook,
  palette: Palette
): Readonly<Record<string, KnobValue>> {
  const values: Record<string, KnobValue> = {}
  for (const knob of look.knobs) {
    values[knob.key] = defaultKnobValue(knob, palette)
  }
  return values
}

/** One knob's default, with a palette role resolved to the colour it names. */
export function defaultKnobValue(
  knob: KnobDescriptor,
  palette: Palette
): KnobValue {
  if (knob.kind !== 'colour' || isHex(knob.value)) return knob.value
  return paletteEntryFor(palette, knob.value)?.hex ?? '#000000'
}

/**
 * One value, held to what its knob says — or `null` if it cannot be.
 *
 * The same declaration that drew the control checks the value, which is what
 * makes a hand-edited fork or a hand-edited manifest fail on the knob it is
 * wrong about rather than somewhere downstream. A slider is *clamped* rather
 * than refused, for the reason `readBatchSizes` clamps: a number outside the
 * range plainly means "as far as it goes", and there is a right answer. A
 * choice, a colour and a toggle have no such reading, so they are refused.
 */
export function coerceKnobValue(
  knob: KnobDescriptor,
  value: unknown
): KnobValue | null {
  switch (knob.kind) {
    case 'slider':
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return Math.min(knob.max, Math.max(knob.min, value))
    case 'angle':
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return wrapAngle(value)
    case 'colour':
      return isHex(value) ? value : null
    case 'choice':
      return typeof value === 'string' && knob.options.includes(value)
        ? value
        : null
    case 'toggle':
      return typeof value === 'boolean' ? value : null
  }
}

/** The committed built-ins — validated once, at module load. */
export const EFFECTS_LIBRARY: EffectsLibrary =
  readEffectsLibrary(LIBRARY_DOCUMENT)

export const BUILT_IN_LOOKS: readonly EffectsLook[] = EFFECTS_LIBRARY.looks

/** Look-up by id, `null` for both "no id" and "no such look". */
export function lookById(
  id: string | null,
  library: readonly EffectsLook[] = BUILT_IN_LOOKS
): EffectsLook | null {
  if (id === null) return null
  return library.find(look => look.id === id) ?? null
}

/** Whether the built-in library already ships this id. */
export function isBuiltInLookId(id: string): boolean {
  return lookById(id) !== null
}

// ── The user's own library ──────────────────────────────────────────────────

/**
 * Bumped when a saved fork written today would be misread by an older build.
 *
 * Separate from {@link EFFECTS_LIBRARY_VERSION} for the reason every other
 * library's two versions are separate: the built-ins ship with the app and move
 * when we move them, and a fork lives in app data and has to survive an update
 * that rewrites every built-in.
 */
export const USER_LOOK_VERSION = 1

/**
 * One saved fork, from the file it was read out of.
 *
 * Throws, naming what was wrong. The caller skips that one file and says so — a
 * hand-edited fork must never be able to take the library down.
 */
export function readUserLook(document: unknown): EffectsLook {
  const record = asRecord(document, 'user effect')

  const version = record.version
  if (version !== USER_LOOK_VERSION) {
    throw new Error(
      `User effect version ${String(version)} is not version ${USER_LOOK_VERSION}`
    )
  }

  return readLook(record)
}

/** The document written to app data — one look, plus what version it is. */
export function writeUserLook(look: EffectsLook): Record<string, unknown> {
  return {
    version: USER_LOOK_VERSION,
    id: look.id,
    name: look.name,
    shader: look.shader,
    blurb: look.blurb,
    knobs: look.knobs,
  }
}

/**
 * A fork of the knob values on screen right now.
 *
 * The values become the fork's *defaults*, which is what saving a look means:
 * everything else about the look — its shader, its ranges, its options — is what
 * it was forked from. A value the fork cannot hold is dropped back to the
 * original's default rather than saved, so a fork is always a look that loads.
 */
export function lookFrom(
  look: EffectsLook,
  id: string,
  name: string,
  values: Readonly<Record<string, KnobValue>>
): EffectsLook {
  return {
    ...look,
    id,
    name: name.trim(),
    knobs: look.knobs.map(knob => {
      const held = coerceKnobValue(knob, values[knob.key])
      if (held === null) return knob
      // The union is closed and every arm carries `value` of its own type, so
      // the cast is narrowing what `coerceKnobValue` has already checked rather
      // than asserting anything new.
      return { ...knob, value: held } as KnobDescriptor
    }),
  }
}
