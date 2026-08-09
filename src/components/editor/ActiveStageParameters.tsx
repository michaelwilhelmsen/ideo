import { activeProject } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
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
 */
export function ActiveStageParameters() {
  const state = useEditorStore(store => store.state)
  const project = activeProject(state)

  // Nothing open is a normal state now that projects come off disk, and a
  // parameter panel for no project would be a form with nowhere to go.
  if (project === null) return null

  return (
    <>
      <StageParameters project={project} stage={state.activeStage} />
      <ExportPanel project={project} stage={state.activeStage} />
    </>
  )
}
