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
  nodeById,
  pickedGeneration,
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
  /**
   * The candidates this tab offers to treat — every node's current pick, in
   * canvas order.
   *
   * On screen as a switch, because "halftone the still" and "halftone the clip"
   * are different jobs done in the same place and the answer used to be taken
   * from whichever stage tab happened to be open. That was invisible and
   * consequential: `valuesForMedium` substitutes error diffusion on a clip, so
   * the two targets do not even offer the same knobs.
   */
  readonly choices: readonly Generation[]
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

  // Every node's pick, in the order the canvas holds them. A candidate with no
  // file stays on the switch rather than disappearing from it: `TreatedPreview`
  // already says `effects.noFile` about exactly that case, and a target that
  // silently vanished would read as the node having decided nothing.
  const choices = project.nodes
    .map(node => pickedGeneration(project, node))
    .filter((candidate): candidate is Generation => candidate !== null)

  // The pin wins where it names something this project still has; then the
  // selected node's own pick, which is what you were looking at when you opened
  // the panel; then the last node with anything to show.
  //
  // That ladder is the fix as much as the switch is. Following a *tab* meant
  // opening Effects from the source tab silently treated the source while a
  // finished clip sat one tab away — and since a treatment is stored per
  // generation, the knobs you turned went onto a candidate you were not looking
  // at. The canvas makes "what you were looking at" answerable, which is why the
  // selected node now sits second rather than last.
  const selectedNode = nodeById(project, state.selectedNodeId)
  const generation =
    (state.treatmentTarget === null
      ? null
      : generationById(project, state.treatmentTarget)) ??
    (selectedNode === null ? null : pickedGeneration(project, selectedNode)) ??
    choices.at(-1) ??
    null

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
    choices,
    generation,
    pinned: generation !== null && state.treatmentTarget === generation.id,
    treatment,
    look,
    values,
    inks: values === null ? [] : inksForValues(project.palette, values),
    library,
  }
}
