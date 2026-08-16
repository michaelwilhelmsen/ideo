/**
 * The right sidebar: what the selected node would generate, and what its pick
 * would export.
 *
 * Two panels rather than one, stacked in that order because that is the order
 * the work happens in — and export sits below every node's parameters rather
 * than only an animate node's, since a styled still is a legitimate final
 * deliverable (#31, PRD §4.1).
 *
 * The top panel is whichever node is selected on the canvas (ADR 0005). While
 * the effects panel is open it is the look and its knobs instead: an effect has
 * no model, no seed and no price, so leaving a node's form there would be a form
 * about something you are not looking at. Export stays put either way — it is
 * available whatever is selected, and it is what a treatment is for.
 *
 * With **nothing** selected there is no form to show, and this says so rather
 * than falling back to a node the user did not choose. That is the state the
 * tab bar could not represent and the canvas can: clicking empty space is an
 * answer.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import {
  activeProject,
  nodeById,
  pickedGeneration,
  visibleGenerations,
  type DraftNode,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { CandidateViewer } from './CandidateViewer'
import { EffectsParameters } from './EffectsParameters'
import { ExportPanel } from './ExportPanel'
import { useGenerationName } from './naming'
import { NodeParameters } from './NodeParameters'
import {
  GenerationBadges,
  Preview,
  RecipeReadout,
  SeedComparison,
} from './shared'

export function NodeSidebar() {
  const { t } = useTranslation()
  const state = useEditorStore(store => store.state)
  const project = activeProject(state)

  // Nothing open is a normal state now that projects come off disk, and a
  // parameter panel for no project would be a form with nowhere to go.
  if (project === null) return null

  const node = nodeById(project, state.selectedNodeId)

  return (
    <>
      {state.effectsOpen ? (
        <EffectsParameters />
      ) : node === null ? (
        <Empty className="p-6">
          <EmptyTitle>{t('editor.sidebar.noNodeTitle')}</EmptyTitle>
          <EmptyDescription>
            {t('editor.sidebar.noNodeDescription')}
          </EmptyDescription>
        </Empty>
      ) : (
        <>
          <NodeParameters project={project} node={node} />
          <PickedReadout project={project} node={node} />
        </>
      )}
      <ExportPanel project={project} node={node} />
    </>
  )
}

/**
 * What the node's chosen candidate actually is — its badges, its recipe, and the
 * pinned-seed comparison.
 *
 * In the sidebar since ADR 0005, under the form rather than beside a hero. The
 * canvas draws pictures at thumbnail size and has no room for a `<dl>` of
 * fields, and a card that grew one would be 360px of prose per step. Reading the
 * recipe is a deliberate act about one candidate, which is what the sidebar is
 * for — "what this node would generate" above, "what it did generate" below.
 *
 * PRD §1's whole premise is that the recipe is the expensive artefact, so it has
 * to stay legible somewhere. This is that somewhere.
 */
function PickedReadout({
  project,
  node,
}: {
  project: Project
  node: DraftNode
}) {
  const { t } = useTranslation()
  const nameOf = useGenerationName()
  const showRejected = useEditorStore(store => store.state.showRejected)
  const [viewing, setViewing] = useState(false)
  const picked = pickedGeneration(project, node)

  if (picked === null) return null

  return (
    <section className="space-y-3 border-t border-border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{nameOf(picked)}</h2>
        <span className="text-xs text-muted-foreground">
          {t('editor.selectedIs')}
        </span>
      </div>

      {/* The chosen picture at panel width — the largest thing on screen that
          is not a click away, and the reason the canvas can afford thumbnails.
          Clicking it goes larger still. */}
      <button
        type="button"
        aria-label={t('editor.action.enlarge')}
        onClick={() => setViewing(true)}
        className="block w-full cursor-pointer"
      >
        <Preview generation={picked} aspect={project.aspect} />
      </button>

      {viewing && (
        <CandidateViewer
          project={project}
          candidates={visibleGenerations(project, node, showRejected)}
          startId={picked.id}
          onClose={() => setViewing(false)}
        />
      )}

      <GenerationBadges project={project} generation={picked} />
      <RecipeReadout generation={picked} />
      {/* PRD §4.3's claim, checked on screen: the candidate next to the last one
          that shared its seed, with the fields that differ listed out. */}
      <SeedComparison project={project} generation={picked} />
    </section>
  )
}
