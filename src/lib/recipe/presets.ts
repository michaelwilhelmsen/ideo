/**
 * The style-preset library — PRD §6's version-controlled JSON, and the one
 * function that turns a preset into a prompt.
 *
 * A preset is a **seed, not a filter** (#28): selecting one pre-fills an
 * editable prompt box, and what is in the box is exactly what is sent. So the
 * composed string has to be readable by the person about to spend money on it,
 * and everything that decides how it is assembled has to be visible in the data
 * rather than buried in whoever calls this.
 *
 * Three shape decisions, all from `docs/research/preset-schema.md`:
 *
 * 1. **Keyed by prompt idiom, not by model** (PRD §6.1). The registry's
 *    `promptStyle` picks the variant, so adding a model is a registry change and
 *    never a walk through every preset.
 * 2. **Explicit `null` beats a missing key** (§2). A variant that is `null` says
 *    "this preset has nothing to say in that idiom"; a variant that is *absent*
 *    says nobody has looked at it yet, and the loader refuses it. Same for a
 *    variant's `negative` and `strength`.
 * 3. **The compose template lives in the preset** (§2, PRD §6.1). Ordering is
 *    per-look — a strong art direction may need to lead rather than follow the
 *    preserve block — so a rule in code would be the wrong place for it.
 *
 * Two things this module deliberately does *not* do. It never concatenates a
 * negative into the prompt: that was settled on 2026-08-09 (PRD §9), because
 * "no gradients" inside a positive prompt reads as a request for gradients. And
 * it never invents a strength — the number comes from the model's registry
 * entry unless the preset overrode it, and an override is clamped to the window
 * §6.3 actually measured.
 *
 * Validated at module load like the registry (`validateRegistry`), and for the
 * same reason: committed JSON with a typo in it should be a startup crash, not
 * a prompt that quietly says less than it meant to.
 */

import LIBRARY_DOCUMENT from './presets.json'
import type { ModelCapabilities, PromptStyle } from './registry'

/** Bumped when a library written today would be misread by an older build. */
export const PRESET_LIBRARY_VERSION = 1

/**
 * The usable strength range, measured on `fal-ai/flux/dev/image-to-image`
 * (PRD §6.3): below it nothing happens, above it the composition drifts, and at
 * fal's own default of 0.95 the input is discarded entirely.
 *
 * A preset may express an opinion inside this window and nowhere else — the
 * library is data a user can fork, and a fork is not permission to spend money
 * on a restyle that returns an unrelated image.
 */
export const PRESET_STRENGTH_WINDOW = { min: 0.65, max: 0.8 } as const

/** Every idiom a variant map has to answer for. */
const PROMPT_STYLES: readonly PromptStyle[] = ['prose', 'tags']

/**
 * One preset in one prompt idiom.
 *
 * `transform` and `compose` are separate because only the second is a template:
 * the transform is the look, and the template says where it goes relative to the
 * preserve block. In the JSON its placeholders are `{preserve}` and
 * `{transform}`; the loader substitutes the library's preserve block once, so a
 * loaded variant is **self-contained** and `composePreset` needs nothing but the
 * preset and the model. That is also what makes a forked user preset stable: it
 * carries the preserve wording it was saved with rather than tracking ours.
 */
export interface PresetVariant {
  /** The look itself, in this idiom. */
  readonly transform: string
  /** How the prompt is assembled, with `{preserve}` already resolved. */
  readonly compose: string
  /**
   * Routed via `negativePromptParam` and dropped where that is null — never
   * folded into the prompt (PRD §9). `null` means this look has nothing to
   * subtract, which is a real answer and not missing data.
   */
  readonly negative: string | null
  /** An opinion about strength, or `null` to take the model's default. */
  readonly strength: number | null
}

/**
 * One look, in every idiom it has an opinion about.
 *
 * `name` is user data — presets are forkable (PRD §6), so the name a user gave
 * theirs is the name it has. No `t()` anywhere near it.
 */
export interface StylePreset {
  readonly id: string
  readonly name: string
  /** The grouping the drafts use (`glass`, `gradient`, …). Free-form. */
  readonly family: string
  readonly variants: Readonly<Record<PromptStyle, PresetVariant | null>>
}

/**
 * A whole library: presets plus the preserve blocks they share.
 *
 * The preserve block lives at library level rather than on every preset because
 * it is the same clause 20 times over — the one that separates a restyle from a
 * reroll. A preset that does not want it simply leaves `{preserve}` out of its
 * template, which is also how #34's per-recipe override will land.
 */
export interface PresetLibrary {
  readonly version: number
  readonly preserve: Readonly<Record<PromptStyle, string | null>>
  readonly presets: readonly StylePreset[]
}

/** What a preset seeds a form with. */
export interface ComposedPreset {
  /** The whole prompt, ready to pre-fill an editable box. */
  readonly prompt: string
  /** Separate, always — see the module note. `null` means send nothing. */
  readonly negative: string | null
  /** `null` on the models with no strength field, which is most of them. */
  readonly strength: number | null
}

/**
 * A library from an untrusted document, or a throw naming what was wrong.
 *
 * Exported because the built-ins are not the only source: #28's fork flow reads
 * user presets out of app data, and those are a file someone hand-edited by
 * definition.
 */
export function readPresetLibrary(document: unknown): PresetLibrary {
  const record = asRecord(document, 'preset library')

  const version = record.version
  if (version !== PRESET_LIBRARY_VERSION) {
    throw new Error(
      `Preset library version ${String(version)} is not version ${PRESET_LIBRARY_VERSION}`
    )
  }

  const preserve = readPreserve(record.preserve)

  const documents = record.presets
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('Preset library lists no presets')
  }

  const seen = new Set<string>()
  const presets = documents.map(entry => {
    const preset = readPreset(entry, preserve)
    if (seen.has(preset.id)) {
      throw new Error(`Preset "${preset.id}" is declared twice`)
    }
    seen.add(preset.id)
    return preset
  })

  return { version, preserve, presets }
}

/** The preserve block per idiom, explicitly null where there is none. */
function readPreserve(document: unknown): PresetLibrary['preserve'] {
  const record = asRecord(document, 'preset library preserve blocks')
  const blocks: Partial<Record<PromptStyle, string | null>> = {}

  for (const style of PROMPT_STYLES) {
    if (!(style in record)) {
      throw new Error(
        `Preset library has no ${style} preserve block — state null rather than omitting it`
      )
    }
    const text = record[style]
    if (text === null) {
      blocks[style] = null
      continue
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`Preset library has an empty ${style} preserve block`)
    }
    blocks[style] = text
  }

  return blocks as PresetLibrary['preserve']
}

function readPreset(
  document: unknown,
  preserve: PresetLibrary['preserve']
): StylePreset {
  const record = asRecord(document, 'preset')
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') throw new Error('A preset has no id')

  const fail = (problem: string): never => {
    throw new Error(`Preset "${id}": ${problem}`)
  }

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') fail('has no name')

  const family = typeof record.family === 'string' ? record.family.trim() : ''
  if (family === '') fail('has no family')

  const variants = readVariants(record.variants, preserve, fail)
  if (PROMPT_STYLES.every(style => variants[style] === null)) {
    fail('supports no prompt idiom, so no model could ever use it')
  }

  return { id, name, family, variants }
}

function readVariants(
  document: unknown,
  preserve: PresetLibrary['preserve'],
  fail: (problem: string) => never
): StylePreset['variants'] {
  if (!isRecord(document)) fail('has no variants')
  const variants: Partial<Record<PromptStyle, PresetVariant | null>> = {}

  for (const style of PROMPT_STYLES) {
    // `preset-schema.md` §2 — the distinction the whole schema rests on: null
    // is "not supported in this idiom", absent is "nobody wrote it down".
    if (!(style in document)) {
      fail(`has no ${style} variant — state null rather than omitting it`)
    }
    const entry = document[style]
    variants[style] =
      entry === null ? null : readVariant(style, entry, preserve, fail)
  }

  return variants as StylePreset['variants']
}

function readVariant(
  style: PromptStyle,
  document: unknown,
  preserve: PresetLibrary['preserve'],
  fail: (problem: string) => never
): PresetVariant {
  if (!isRecord(document)) fail(`has a ${style} variant that is not a variant`)

  const transform =
    typeof document.transform === 'string' ? document.transform.trim() : ''
  if (transform === '') fail(`has a ${style} variant with no transform`)

  const compose =
    typeof document.compose === 'string' ? document.compose.trim() : ''
  if (compose === '') fail(`has a ${style} variant with no compose template`)
  if (!compose.includes(TRANSFORM_SLOT)) {
    fail(`has a ${style} compose template that never places ${TRANSFORM_SLOT}`)
  }
  const preserveBlock = preserve[style]
  if (compose.includes(PRESERVE_SLOT) && preserveBlock === null) {
    fail(
      `has a ${style} compose template asking for ${PRESERVE_SLOT}, which this library has none of`
    )
  }

  if (!('negative' in document)) {
    fail(
      `has a ${style} variant with no negative — state null rather than omitting it`
    )
  }
  const negative = document.negative
  if (negative !== null && (typeof negative !== 'string' || negative === '')) {
    fail(`has a ${style} variant with an empty negative`)
  }

  if (!('strength' in document)) {
    fail(
      `has a ${style} variant with no strength — state null rather than omitting it`
    )
  }
  const strength = document.strength
  if (
    strength !== null &&
    (typeof strength !== 'number' || !(strength > 0) || strength > 1)
  ) {
    fail(`has a ${style} variant with a strength outside 0–1`)
  }

  return {
    transform,
    compose: compose.replaceAll(PRESERVE_SLOT, preserveBlock ?? ''),
    negative,
    strength,
  }
}

const PRESERVE_SLOT = '{preserve}'
const TRANSFORM_SLOT = '{transform}'

/**
 * What selecting this preset should put in the form, or `null` when the model's
 * idiom is one this preset does not speak.
 *
 * `null` rather than a fallback into the other idiom: a tag list sent to a
 * prose-trained encoder reads as malformed English (PRD §6.2), so the honest
 * answer is that there is nothing to seed and the caller keeps the user's text
 * and offers a re-seed (#28's settled model-switch rule).
 *
 * The model is the second argument rather than a bare `promptStyle` because
 * every remaining answer is also the registry's: whether the model has a
 * strength field, what it defaults to, and whether there is anywhere to put a
 * negative. Splitting those out would mean every caller re-deriving them, which
 * is where "the negative was folded into the prompt after all" comes from.
 */
export function composePreset(
  preset: StylePreset,
  model: ModelCapabilities
): ComposedPreset | null {
  const variant = preset.variants[model.promptStyle]
  if (variant === null) return null

  const prompt = variant.compose
    .replaceAll(TRANSFORM_SLOT, variant.transform)
    .trim()

  return {
    prompt,
    // Dropped where the model has no field for it, never folded in (PRD §9).
    negative: model.negativePromptParam === null ? null : variant.negative,
    strength: strengthFor(model, variant),
  }
}

/**
 * The strength to seed: the preset's opinion held to the measured window, or
 * the model's own default, or nothing at all.
 *
 * Clamped rather than refused, and clamped here rather than at load: a user
 * preset is a file someone edited, and 0.95 in it plainly means "as much style
 * as you can" — 0.8 is as much as this endpoint can give without discarding the
 * image (PRD §6.3).
 */
function strengthFor(
  model: ModelCapabilities,
  variant: PresetVariant
): number | null {
  if (model.strengthParam === null) return null

  if (variant.strength !== null) {
    const { min, max } = PRESET_STRENGTH_WINDOW
    return Math.min(max, Math.max(min, variant.strength))
  }

  // Ours, never the provider's (PRD §5, §6.3).
  const fallback = model.defaults[model.strengthParam]
  return typeof fallback === 'number' ? fallback : null
}

/**
 * The committed built-ins.
 *
 * A small proving set (#28), drawn from the 22 drafts in
 * `docs/research/style-presets.md` and deliberately missing every texture-led
 * family: grain, dither, halftone, duotone and the analog-degradation looks are
 * #36's deterministic post-effect kernels, because PRD §6.2 measured that
 * asking a model for grain barely registers. #34 replaces this content with the
 * hero-recipes v4 library once the mechanics here are proven.
 *
 * Every variant is `tags`, which is the idiom the drafts are written in and the
 * one PRD §6.2's A/B refused to rewrite. `prose` is explicitly null, so the six
 * prose-idiom style models seed nothing until #34 — which is a visible gap
 * rather than a tag list quietly sent to a prose encoder.
 */
export const STYLE_PRESET_LIBRARY: PresetLibrary =
  readPresetLibrary(LIBRARY_DOCUMENT)

export const BUILT_IN_STYLE_PRESETS: readonly StylePreset[] =
  STYLE_PRESET_LIBRARY.presets

/** Look-up by id, `null` for both "no id" and "no such preset". */
export function stylePresetById(id: string | null): StylePreset | null {
  if (id === null) return null
  return BUILT_IN_STYLE_PRESETS.find(preset => preset.id === id) ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Malformed ${what}`)
  return value
}
