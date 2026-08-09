/**
 * The motion-preset library — PRD §6's *second* version-controlled JSON.
 *
 * Two libraries, not one, because look and movement are orthogonal (#29): the
 * same drifting-clouds motion is worth having over a glass monolith and over a
 * sun-bleached beach, and a combined library would be every look times every
 * movement. So a recipe picks one of each, and neither library knows the other
 * exists.
 *
 * Deliberately a **simpler schema** than `presets.ts`, and every difference is
 * one the style library earned and this one did not:
 *
 * - **No per-idiom variants.** `promptStyle` splits the *image* models — Qwen
 *   reads a keyword list, everything else reads prose — and all eight video
 *   endpoints surveyed are prose. A `variants` map here would be eight copies of
 *   one string with a `tags` key permanently null. Motion is model-class
 *   independent, exactly as `docs/research/preset-schema.md` §4 recommends.
 * - **No compose template and no preserve block.** The still already holds the
 *   composition; there is nothing to tell the model to preserve, and nothing to
 *   assemble around.
 * - **No strength and no negative.** No video model surveyed has a strength
 *   field, and only Veo has a `negative_prompt` — so the camera negations live
 *   *inside* the prompt text (`no pan, no zoom, no dolly, no camera shake`),
 *   which is how "subtle ambient movement rather than dramatic camera moves"
 *   survives on the seven models with nowhere else to put it (§4's own rule).
 *
 * What it keeps from the style library is everything that matters: a preset is
 * a **seed, not a filter** — what lands in the prompt box is exactly what is
 * sent — the built-ins are committed JSON validated at module load so a typo is
 * a startup crash rather than a paid clip that says less than it meant to, and
 * a fork is a file in app data that a repo update can never touch.
 */

import { asRecord } from './json'
import LIBRARY_DOCUMENT from './motion-presets.json'
import { isPresetId } from './presets'

/** Bumped when a library written today would be misread by an older build. */
export const MOTION_LIBRARY_VERSION = 1

/**
 * One movement.
 *
 * `name` is user data — motion presets are forkable like style ones — so no
 * `t()` ever goes near it. `prompt` is the whole thing that gets seeded: there
 * is no fragment to assemble, because assembling at submit time is what makes a
 * preset a filter instead of a seed.
 */
export interface MotionPreset {
  readonly id: string
  readonly name: string
  readonly prompt: string
}

/** A whole library: a version, and the movements in it. */
export interface MotionLibrary {
  readonly version: number
  readonly presets: readonly MotionPreset[]
}

/**
 * Tells a motion preset from a style one at a value level.
 *
 * The reducer takes either on the same `choosePreset` action, and branching on
 * the *stage* rather than on the value would put the two libraries back in each
 * other's business the first time a stage grew a second library.
 *
 * **Structural on purpose — no `kind` discriminant.** A discriminant would be
 * the tidier check and is unavailable here: presets are parsed from JSON on
 * disk, including forks the user saved before this build existed, and a newly
 * required field would make every one of those files fail to load. So the two
 * shapes are told apart by what they already are, positively *and* negatively:
 * a motion preset carries a top-level `prompt` string, and a style preset never
 * does — its prompts live per idiom under `variants`, which a motion preset in
 * turn never has. Testing only for `prompt` would let any future shape that
 * happens to grow one be mistaken for a movement.
 */
export function isMotionPreset(value: object): value is MotionPreset {
  return (
    'prompt' in value &&
    typeof value.prompt === 'string' &&
    !('variants' in value)
  )
}

/**
 * A library from an untrusted document, or a throw naming what was wrong.
 *
 * Exported for the same reason `readPresetLibrary` is: the built-ins are not
 * the only source, and a user's fork is a file somebody could have hand-edited.
 */
export function readMotionLibrary(document: unknown): MotionLibrary {
  const record = asRecord(document, 'motion preset library')

  const version = record.version
  if (version !== MOTION_LIBRARY_VERSION) {
    throw new Error(
      `Motion preset library version ${String(version)} is not version ${MOTION_LIBRARY_VERSION}`
    )
  }

  const documents = record.presets
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('Motion preset library lists no presets')
  }

  const seen = new Set<string>()
  const presets = documents.map(entry => {
    const preset = readMotionPreset(entry)
    if (seen.has(preset.id)) {
      throw new Error(`Motion preset "${preset.id}" is declared twice`)
    }
    seen.add(preset.id)
    return preset
  })

  return { version, presets }
}

function readMotionPreset(document: unknown): MotionPreset {
  const record = asRecord(document, 'motion preset')

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') throw new Error('A motion preset has no id')

  const fail = (problem: string): never => {
    throw new Error(`Motion preset "${id}": ${problem}`)
  }

  // Every id in this library is a file name in app data eventually — a fork
  // takes one from the built-in it was forked from — so the same pattern Rust
  // enforces is checked here, on ours as well as theirs.
  if (!isPresetId(id)) fail('is not an id a file can be named')

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') fail('has no name')

  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
  if (prompt === '') fail('has no prompt')

  return { id, name, prompt }
}

/**
 * The committed built-ins.
 *
 * The eight fragments of `docs/research/preset-schema.md` §4, restated as whole
 * prompts rather than fragments — a fragment would have to be assembled with
 * something, and there is nothing here to assemble it with. Each one names one
 * continuous movement, asks for a seamless loop, and spells out the camera
 * negations, because most video models have no `negative_prompt` and the
 * research's own practical rule is that the negation then has to be text.
 */
export const MOTION_PRESET_LIBRARY: MotionLibrary =
  readMotionLibrary(LIBRARY_DOCUMENT)

export const BUILT_IN_MOTION_PRESETS: readonly MotionPreset[] =
  MOTION_PRESET_LIBRARY.presets

/** Look-up by id, `null` for both "no id" and "no such preset". */
export function motionPresetById(id: string | null): MotionPreset | null {
  if (id === null) return null
  return BUILT_IN_MOTION_PRESETS.find(preset => preset.id === id) ?? null
}

/**
 * Whether the box still says what the selected preset says.
 *
 * The motion counterpart of `presetSeedState`, minus the two states it cannot
 * reach: there are no idioms here, so nothing is ever `unsupported`, and
 * `stale` needs no reason key because there is only one way to get there —
 * somebody edited the prompt, which is the whole point of seeding it.
 */
export type MotionSeedState = 'none' | 'seeded' | 'stale'

export function motionSeedState(
  prompt: string,
  preset: MotionPreset | null
): MotionSeedState {
  if (preset === null) return 'none'
  return preset.prompt === prompt ? 'seeded' : 'stale'
}

// ── The user's own library ──────────────────────────────────────────────────

/**
 * Bumped when a saved fork written today would be misread by an older build.
 *
 * Separate from {@link MOTION_LIBRARY_VERSION} for the reason the style
 * library's two versions are separate: the built-ins ship with the app and move
 * when we move them, and a fork lives in app data and has to survive an update
 * that rewrites every built-in.
 */
export const USER_MOTION_PRESET_VERSION = 1

/**
 * One saved fork, from the file it was read out of.
 *
 * Throws, naming what was wrong. The caller skips that one file and says so —
 * a hand-edited fork must never be able to take the library down.
 */
export function readUserMotionPreset(document: unknown): MotionPreset {
  const record = asRecord(document, 'user motion preset')

  const version = record.version
  if (version !== USER_MOTION_PRESET_VERSION) {
    throw new Error(
      `User motion preset version ${String(version)} is not version ${USER_MOTION_PRESET_VERSION}`
    )
  }

  return readMotionPreset(record)
}

/** The document written to app data — one preset, plus what version it is. */
export function writeUserMotionPreset(
  preset: MotionPreset
): Record<string, unknown> {
  return {
    version: USER_MOTION_PRESET_VERSION,
    id: preset.id,
    name: preset.name,
    prompt: preset.prompt,
  }
}

/**
 * A fork of what is in the prompt box right now.
 *
 * Trivial next to `userPresetFrom`, and that is the schema paying off: there is
 * one field, no idiom to claim and no other idiom to preserve, so a save cannot
 * silently delete half of somebody's preset the way a style save could.
 */
export function motionPresetFrom(capture: MotionPreset): MotionPreset {
  return {
    id: capture.id,
    name: capture.name.trim(),
    prompt: capture.prompt.trim(),
  }
}
