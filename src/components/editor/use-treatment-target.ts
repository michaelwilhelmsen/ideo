/**
 * Which candidate the effects tab is working on, and what it currently says.
 *
 * A hook rather than a prop, because **two panes need the same answer**: the
 * main pane draws the picture and the right sidebar draws the knobs, and they
 * are siblings in the layout rather than parent and child. Passing it down would
 * mean lifting it into a component that owns neither of them.
 *
 * Resolving it twice is cheap and — more to the point — cannot disagree: the pin
 * and the selection both live in the store, and the library is one TanStack
 * Query cache entry. What would disagree is two components each deciding for
 * themselves what "the target" means.
 */

import {
  inksForValues,
  lookFor,
  resolveTreatment,
  valuesForMedium,
  type EffectsLook,
  type Ink,
  type KnobValue,
} from '@/lib/effects'
import { isVideoAsset } from '@/lib/export'
import {
  activeProject,
  generationById,
  selectedGeneration,
  type Generation,
  type Project,
  type Treatment,
} from '@/lib/recipe'
import { useLookLibrary } from '@/services/effects'
import { useEditorStore } from '@/store/editor-store'

export interface TreatmentTarget {
  readonly project: Project
  /** The candidate being treated, or `null` when the stage has no selection. */
  readonly generation: Generation | null
  /** Whether this candidate is *pinned* rather than merely selected. */
  readonly pinned: boolean
  readonly treatment: Treatment | null
  /** The look the treatment names, or `null` for an untreated candidate. */
  readonly look: EffectsLook | null
  /**
   * Every knob's value, held to the look **and to the medium**.
   *
   * A clip cannot run error diffusion, so a treatment naming Atkinson resolves
   * to blue noise here — visibly, which is what {@link substituted} is for.
   * What the shader would do anyway is show blue noise; what this adds is a
   * control that says so.
   */
  readonly values: Readonly<Record<string, KnobValue>> | null
  /** Whether the medium moved a knob off what the treatment says. */
  readonly substituted: boolean
  /** Whether this candidate is a clip, which is what decides that. */
  readonly isClip: boolean
  /** What this look reduces to, for the shader and for the CPU path alike. */
  readonly inks: readonly Ink[]
  /** Both halves of the library, ours then theirs. */
  readonly library: readonly EffectsLook[]
}

/** `null` when nothing is open — the panels render their own empty state. */
export function useTreatmentTarget(): TreatmentTarget | null {
  const state = useEditorStore(store => store.state)
  const library = useLookLibrary()

  const project = activeProject(state)
  if (project === null) return null

  // The pin wins where it names something this project still has; otherwise
  // this follows the selection, which is what it does before anybody pins.
  const generation =
    (state.treatmentTarget === null
      ? null
      : generationById(project, state.treatmentTarget)) ??
    selectedGeneration(project, state.activeStage)

  const treatment = generation?.treatment ?? null
  const look = lookFor(treatment, library)
  const isClip = isVideoAsset(generation?.asset ?? null)

  const held =
    treatment !== null && look !== null
      ? resolveTreatment(treatment, look, project.palette)
      : null
  const allowed = held === null ? null : valuesForMedium(held, isClip)
  const values = allowed?.values ?? null

  return {
    substituted: allowed?.substituted ?? false,
    isClip,
    project,
    generation,
    pinned: generation !== null && state.treatmentTarget === generation.id,
    treatment,
    look,
    values,
    inks: values === null ? [] : inksForValues(project.palette, values),
    library,
  }
}
