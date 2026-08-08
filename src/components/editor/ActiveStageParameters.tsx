import { activeProject } from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { StageParameters } from './StageParameters'

/** Parameters for whichever stage is active — the right sidebar of A and B. */
export function ActiveStageParameters() {
  const state = useEditorStore(store => store.state)
  return (
    <StageParameters project={activeProject(state)} stage={state.activeStage} />
  )
}
