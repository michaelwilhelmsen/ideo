import { activeProject } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { EffectsParameters } from './EffectsParameters'
import { ExportPanel } from './ExportPanel'
import { StageParameters } from './StageParameters'

/**
 * The right sidebar: what this stage would generate, and what its selection
 * would export.
 *
 * Two panels rather than one, stacked in that order because that is the order
 * the work happens in — and export sits below every stage's parameters rather
 * than only the animate stage's, since a styled still is a legitimate final
 * deliverable (#31, PRD §4.1).
 *
 * The top panel is whichever tab is in front of you (#36). While the effects tab
 * is open it is the look and its knobs rather than a stage's form: an effect has
 * no model, no seed and no price, so leaving the stage form there would be a
 * form about something you are not looking at. Export stays put either way —
 * it is available from every tab, and it is what a treatment is for.
 */
export function ActiveStageParameters() {
  const state = useEditorStore(store => store.state)
  const project = activeProject(state)

  // Nothing open is a normal state now that projects come off disk, and a
  // parameter panel for no project would be a form with nowhere to go.
  if (project === null) return null

  return (
    <>
      {state.effectsOpen ? (
        <EffectsParameters />
      ) : (
        <StageParameters project={project} stage={state.activeStage} />
      )}
      <ExportPanel project={project} stage={state.activeStage} />
    </>
  )
}
