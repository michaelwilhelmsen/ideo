/**
 * The editor's main pane: a canvas of drafts (ADR 0005).
 *
 * This replaced the three-stage tab bar outright. There is no second editing
 * surface — the graph is where steps are made, wired, run and chosen from, and
 * the right sidebar is a detail panel on whichever node is selected.
 *
 * React Flow renders it and owns almost nothing. `nodes` and `edges` are a pure
 * derivation of the store (`flow-graph.ts`), every interaction comes back as a
 * change descriptor that is translated into an existing reducer action, and the
 * one thing left uncontrolled is pan and zoom — which is ephemeral and belongs
 * in no manifest. Node *positions* are the project's, so they go through the
 * reducer like everything else.
 *
 * The project it edits comes off disk (#23). With nothing open — an empty
 * library, or one still loading — it says so rather than inventing a project,
 * which is why `activeProject` is nullable.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme } from '@/hooks/use-theme'
import {
  activeProject,
  canConnect,
  placeNode,
  STAGE_ORDER,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import {
  actionsForConnection,
  actionsForNodeChanges,
  flowEdges,
  flowNodes,
  type IdeoNode,
} from './flow-graph'
import { DraftNodeCard } from './DraftNodeCard'
import { EffectsTab } from './EffectsTab'
import { PaletteDialog } from './PaletteDialog'
import { RunGrid } from './RunGrid'

/**
 * Defined at module scope on purpose. React Flow re-registers every node type
 * when this object changes identity, which on an inline literal is every
 * render — and re-registering unmounts and remounts every card on the canvas.
 */
const NODE_TYPES: NodeTypes = {
  draft: DraftNodeCard,
}

export function Canvas() {
  const { t } = useTranslation()
  const state = useEditorStore(store => store.state)
  const project = activeProject(state)

  if (project === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <h1 className="text-base font-semibold">{t('editor.empty.title')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t('editor.empty.description')}
        </p>
      </div>
    )
  }

  return (
    // Keyed by project so opening another one gets a fresh viewport rather than
    // inheriting the pan and zoom of a canvas whose nodes were somewhere else.
    <ReactFlowProvider key={project.id}>
      <Graph project={project} />
    </ReactFlowProvider>
  )
}

function Graph({ project }: { project: Project }) {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const dispatch = useEditorStore(store => store.dispatch)
  const showRejected = useEditorStore(store => store.state.showRejected)
  const selectedNodeId = useEditorStore(store => store.state.selectedNodeId)
  const runs = useEditorStore(store => store.state.runs)
  const effectsOpen = useEditorStore(store => store.state.effectsOpen)
  const [editingPalette, setEditingPalette] = useState(false)

  const nodes = flowNodes(project, selectedNodeId)
  const edges = flowEdges(project, showRejected)

  const onNodesChange = useCallback(
    (changes: NodeChange<IdeoNode>[]) => {
      for (const action of actionsForNodeChanges(changes)) {
        dispatch(action)
      }
    },
    [dispatch]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      // The only edge change that means anything is a removal, and removing an
      // edge is detaching its *target*. Every other change React Flow reports
      // about an edge — selection, replacement — is about the drawing.
      for (const change of changes) {
        if (change.type !== 'remove') continue
        const edge = edges.find(entry => entry.id === change.id)
        if (edge === undefined) continue
        dispatch({ type: 'disconnectNode', nodeId: edge.target })
      }
    },
    [dispatch, edges]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      for (const action of actionsForConnection(
        project,
        connection.source,
        connection.target,
        connection.sourceHandle
      )) {
        dispatch(action)
      }
    },
    [dispatch, project]
  )

  /**
   * Refused before the drag lands rather than after, so an illegal edge never
   * snaps into place and disappears a frame later.
   *
   * The rule itself is not here — `canConnect` is the reducer's, and this asks
   * it the same question the reducer will ask again. Two implementations of
   * "would this be a cycle" is exactly the drift the selector layer exists to
   * prevent.
   */
  const isValidConnection = useCallback(
    (connection: Connection | { source: string; target: string }) =>
      // The source is the card either way — dragging from a candidate's handle
      // is still a line out of the step that made it, and which picture it
      // carries is the handle's business, not the rule's.
      canConnect(project, connection.source, connection.target),
    [project]
  )

  // The run still owed a decision, if any. One at a time and on top of the
  // canvas rather than inside a card: a four-up of full-size candidates is the
  // whole screen's job (#26), and a grid squeezed into a 360px node would be
  // four thumbnails, which is what the candidate row already is.
  //
  // The **newest**, which is what `activeRunFor` has always meant by "active":
  // asking for new candidates is asking to be shown them, so a second click
  // while the first run is still open puts its grid in front. Taking the oldest
  // instead would leave the user answering a question they had moved on from.
  const openRun =
    runs
      .filter(
        run =>
          run.projectId === project.id &&
          !run.answered &&
          run.generationIds.length > run.abandonedIds.length &&
          project.nodes.some(node => node.id === run.nodeId)
      )
      .at(-1) ?? null

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <header className="z-10 flex items-baseline gap-3 border-b border-border px-6 py-3">
        <h1 className="text-base font-semibold">{project.name}</h1>
        <span className="text-xs text-muted-foreground">{project.aspect}</span>

        <div className="ms-auto flex items-center gap-1">
          {/* Here rather than in the right sidebar because the palette is the
              project's and the sidebar is a node's (#46). It sits next to the
              other two project-wide facts for the same reason. */}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditingPalette(true)}
          >
            {t('editor.palette.title')}
          </Button>

          <AddNodeMenu project={project} />
        </div>
      </header>

      {editingPalette && (
        <PaletteDialog
          project={project}
          onClose={() => setEditingPalette(false)}
        />
      )}

      {/* Named as a region so the graph is findable — by a screen reader, and
          by a test that wants "the steps" rather than "the step the sidebar
          happens to be editing", which carries the same names. */}
      <section aria-label={t('editor.canvas')} className="relative flex-1">
        <ReactFlow<IdeoNode>
          nodes={[...nodes]}
          edges={[...edges]}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          // Clicking bare canvas is a real answer — "no node" — and the sidebar
          // shows the project's own panel there.
          onPaneClick={() => dispatch({ type: 'selectNode', nodeId: null })}
          // One node at a time. The sidebar edits exactly one draft, so a box
          // selection would produce a state the panel could not represent.
          multiSelectionKeyCode={null}
          selectionOnDrag={false}
          // Deletion is the card's own menu, which confirms and names what goes
          // with the node. A stray Backspace must not be able to discard paid
          // candidates (ADR 0005).
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.5}
          proOptions={{ hideAttribution: false }}
          colorMode={
            theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system'
          }
        >
          <Background />
          <Controls showInteractive={false} />
          {/* Worth its pixels once a canvas outgrows the viewport, which is the
              first thing a fan-out does: three models on two steps is already
              wider than a window. */}
          <MiniMap pannable zoomable nodeStrokeWidth={2} />
        </ReactFlow>

        {openRun !== null && <RunGrid project={project} run={openRun} />}

        {/* The effects panel keeps the layout every other mode has: the picture
            in the main pane, the knobs in the right sidebar (#36). Over the
            canvas rather than replacing it, because the graph is where you go
            back to — closing is one click, not a hunt for the tab you came
            from. */}
        {effectsOpen && (
          <div className="absolute inset-0 z-20 overflow-y-auto bg-background p-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">{t('effects.title')}</h2>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dispatch({ type: 'closeEffects' })}
              >
                {t('editor.action.backToCanvas')}
              </Button>
            </div>
            <EffectsTab />
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Adding a step with nothing selected to hang it off — the canvas's own "+".
 *
 * Unwired on arrival, because there is no node to infer an input from. Wiring
 * it is a drag, which is the gesture this whole surface is about.
 */
function AddNodeMenu({ project }: { project: Project }) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="size-3.5" />
          {t('editor.node.add')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {STAGE_ORDER.map(kind => (
          <DropdownMenuItem
            key={kind}
            onSelect={() =>
              dispatch({
                type: 'addNode',
                nodeId: crypto.randomUUID(),
                kind,
                position: placeNode(project, null),
                fromNodeId: null,
              })
            }
          >
            {t(`editor.stage.${kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
