/**
 * The three preset libraries, seen from outside — which stage offers which, and
 * which one an id came out of.
 *
 * A module of its own rather than a third function in `presets.ts`, because it
 * is the only place that knows all three exist: `presets.ts` holds source and
 * style, `motion.ts` holds movements and imports `presets.ts` for the shared id
 * rule, and a lookup across all three has to sit above both. It was in
 * `fixtures.ts` until #47, back when the answer for source *was* a fixture.
 *
 * There is no stage that borrows another stage's library any more. That was the
 * category error #47 existed to break: a **source** preset is a whole scene,
 * carrying composition, subject framing and negative space, while a **style**
 * preset is a transform applied to a composition someone else already made —
 * which is why the style library has a preserve block at all. Handing the style
 * list to the source stage asked a text-to-image model to preserve a
 * composition that did not exist.
 */

import {
  BUILT_IN_MOTION_PRESETS,
  motionPresetById,
  type MotionPreset,
} from './motion'
import {
  BUILT_IN_SOURCE_PRESETS,
  BUILT_IN_STYLE_PRESETS,
  sourcePresetById,
  stylePresetById,
  type Preset,
} from './presets'
import { STAGE_ORDER, type StageKind } from './types'

/**
 * What the preset picker needs, and all three libraries agree on.
 *
 * The alternative was a union the caller has to narrow, for a readout that only
 * ever renders an id and a name.
 */
export interface PresetChoice {
  readonly id: string
  readonly name: string
}

/**
 * The built-in presets on offer for a stage.
 *
 * Three libraries, three answers, no two the same. The user's own forks are
 * deliberately not here: they live in app data behind TanStack Query, and this
 * is a pure function used while rendering.
 *
 * Overloaded rather than returning a union, because the two kinds of caller
 * genuinely want different things and both are right. A picker knows which
 * stage it is and needs the whole preset — a `Preset` to compose, or a
 * `MotionPreset` to read a prompt off — while anything walking all three stages
 * only ever renders an id and a name, and narrowing a union at each of those
 * call sites would be ceremony for a question they are not asking.
 */
export function presetsForStage(stage: 'source' | 'style'): readonly Preset[]
export function presetsForStage(stage: 'animate'): readonly MotionPreset[]
export function presetsForStage(stage: StageKind): readonly PresetChoice[]
export function presetsForStage(stage: StageKind): readonly PresetChoice[] {
  switch (stage) {
    case 'source':
      return BUILT_IN_SOURCE_PRESETS
    case 'style':
      return BUILT_IN_STYLE_PRESETS
    case 'animate':
      return BUILT_IN_MOTION_PRESETS
  }
}

/**
 * A name for a recipe's `presetId`, from whichever library holds it.
 *
 * All three are asked, because a recipe records one id per stage and the readout
 * showing it does not know which stage it came from. Ids are unique across the
 * three for exactly this reason, so the order these are tried in cannot change
 * the answer — see {@link isBuiltInPresetId}, which is what keeps it true.
 */
export function presetById(id: string | null): PresetChoice | null {
  if (id === null) return null
  return (
    sourcePresetById(id) ?? stylePresetById(id) ?? motionPresetById(id) ?? null
  )
}

/**
 * Whether any of the three libraries already ships this id.
 *
 * Asked of **all three** rather than of the library being written to, and that
 * is the whole point: a fork is a file in one folder, so nothing on disk stops a
 * source fork from being called `mesh-gradient`, and once it is,
 * {@link presetById} has two answers to "which preset produced this" and returns
 * the wrong one. Cross-library uniqueness is not a property of the folders, so
 * it has to be a rule here.
 *
 * Used twice, at both ends: minting an id for a new fork skips one that is
 * taken, and loading the user's library skips a file that took one anyway.
 */
export function isBuiltInPresetId(id: string): boolean {
  return presetById(id) !== null
}

/** Every id the built-ins hold, for minting one that is free. */
export function builtInPresetIds(): readonly string[] {
  return STAGE_ORDER.flatMap(stage =>
    presetsForStage(stage).map(preset => preset.id)
  )
}
