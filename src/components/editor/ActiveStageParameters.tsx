import { activeProject } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { StageParameters } from './StageParameters'

/** Parameters for whichever stage is active — the right sidebar. */
export function ActiveStageParameters() {
  const state = useEditorStore(store => store.state)
  const project = activeProject(state)

  // Nothing open is a normal state now that projects come off disk, and a
  // parameter panel for no project would be a form with nowhere to go.
  if (project === null) return null

  return <StageParameters project={project} stage={state.activeStage} />
}
