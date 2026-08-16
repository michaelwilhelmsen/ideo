/**
 * One draft, as a card on the canvas (ADR 0005).
 *
 * The card is a **step**, not a result: it holds a prompt, the models it fans
 * out to, and a Run button that appends more candidates every time it is
 * pressed. Everything below that is history — the candidates it has produced,
 * each carrying a handle of its own so a downstream step can be wired from one
 * picture rather than from the step.
 *
 * The card is as tall as its contents. Nothing here declares a height: a prompt
 * is any length, and a source card carries an upload row that a style card does
 * not, so a fixed header was a number that had to be right for six different
 * cards at once. React Flow measures instead.
 *
 * What is *not* here is the full parameter form. The right sidebar edits the
 * selected node, and duplicating strength, duration and the seed onto every
 * card would make a canvas of four steps four copies of the same panel. The
 * card carries the two fields you change while looking at pictures — the prompt
 * and the models — and defers the rest.
 */

import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react'
import { Loader2, MoreVertical, Play, Plus, Unlink } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  activeProject,
  batchSizeFor,
  blockedReasonKey,
  generationsForNode,
  modelById,
  MODEL_REGISTRY,
  needsInput,
  nodeById,
  placeNode,
  rejectedCount,
  resolvedInputId,
  runSizeFor,
  STAGE_ORDER,
  visibleGenerations,
  type DraftNode,
  type Project,
} from '@/lib/recipe'
import { useNodeJobs } from '@/services/jobs'
import { useEditorStore } from '@/store/editor-store'
import { CandidateTile } from './CandidateTile'
import { INPUT_HANDLE, OUTPUT_HANDLE } from './flow-graph'
import type { DraftFlowNode } from './flow-graph'
import { useRunNode } from './run-request'
import { SourceUpload } from './SourceUpload'

export const DraftNodeCard = memo(function DraftNodeCard({
  id,
  data,
  selected,
}: NodeProps<DraftFlowNode>) {
  const state = useEditorStore(store => store.state)
  const project = activeProject(state)
  const node = nodeById(project, data.nodeId)

  if (project === null || node === null) return null

  return (
    <Card
      flowId={id}
      project={project}
      node={node}
      selected={selected === true}
    />
  )
})

function Card({
  flowId,
  project,
  node,
  selected,
}: {
  flowId: string
  project: Project
  node: DraftNode
  selected: boolean
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const showRejected = useEditorStore(store => store.state.showRejected)
  const selectedNodeId = useEditorStore(store => store.state.selectedNodeId)
  const updateNodeInternals = useUpdateNodeInternals()
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const perModel = batchSizeFor(node)
  const total = runSizeFor(node)
  const { run, isRunning } = useRunNode(project, node, perModel)

  // This node's share of what the project has in flight — keyed by node, so two
  // style steps running at once do not each report the other's jobs.
  const inFlight = useNodeJobs(project.id, node.id)
  const blocked = blockedReasonKey(project, node)
  const candidates = generationsForNode(project, node.id)
  const shown = visibleGenerations(project, node, showRejected)
  const hidden = showRejected ? 0 : rejectedCount(project, node.id)

  const label = node.title ?? t(`editor.stage.${node.kind}`)

  // Which of this card's pictures the step in the sidebar works from, so
  // "Working from" is answered where the pictures are and not only in the
  // panel. It is the *selected* node's question, which is why it is asked here
  // and not from `node`: a pin lives on the consumer, and two steps wired to
  // this card can be taking different candidates of it.
  //
  // Resolved rather than read off `pinnedInputId`, so the ring shows what a run
  // would actually consume — including the rungs below the pin.
  const editing = nodeById(project, selectedNodeId)
  const feeding = editing === null ? null : resolvedInputId(project, editing)

  // Every candidate is a handle, so a run arriving changes this node's handle
  // count — and React Flow caches handle positions per node. Without this, the
  // edges of a card that has just grown anchor where its handles used to be.
  const handles = shown.map(generation => generation.id).join()
  useEffect(() => {
    updateNodeInternals(flowId)
  }, [flowId, handles, updateNodeInternals])

  return (
    <div
      className={cn(
        // No `overflow-hidden`: a handle sits half outside the border it hangs
        // off, and clipping the box would clip every connection point on it.
        // Nothing needs clipping now that the height is the content's.
        'flex w-full flex-col rounded-xl border-2 bg-card text-card-foreground shadow-sm transition-colors',
        selected ? 'border-primary' : 'border-border'
      )}
    >
      {/* Only where the kind consumes a picture. A source node with a target
          handle would offer an edge that could never be sent — its models
          declare no image field. */}
      {needsInput(node.kind) && (
        <Handle
          type="target"
          id={INPUT_HANDLE}
          position={Position.Left}
          className="!size-3 !border-background !bg-muted-foreground"
        />
      )}
      <Handle
        type="source"
        id={OUTPUT_HANDLE}
        position={Position.Right}
        className="!size-3 !border-background !bg-muted-foreground"
      />

      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Badge variant="secondary" className="shrink-0 text-[10px] uppercase">
          {t(`editor.stage.${node.kind}`)}
        </Badge>

        {renaming ? (
          <Input
            autoFocus
            defaultValue={node.title ?? ''}
            aria-label={t('editor.node.rename')}
            className="h-7 text-sm nodrag"
            placeholder={t(`editor.stage.${node.kind}`)}
            onBlur={event => {
              dispatch({
                type: 'renameNode',
                nodeId: node.id,
                title: event.target.value.trim() || null,
              })
              setRenaming(false)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <h3
            className="truncate text-sm font-medium"
            onDoubleClick={() => setRenaming(true)}
          >
            {label}
          </h3>
        )}

        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
          {candidates.length}
        </span>

        <NodeMenu
          node={node}
          hidden={hidden}
          onRename={() => setRenaming(true)}
          onDelete={() => setConfirmingDelete(true)}
        />
      </header>

      {/* `nodrag` throughout: React Flow treats a mousedown anywhere on a node
          as the start of a drag, so a textarea without it cannot be selected
          into and a button without it fires while the card slides away. */}
      <div className="flex flex-col gap-2 px-3 py-2">
        <Textarea
          value={node.draft.prompt}
          onChange={event =>
            dispatch({
              type: 'setPrompt',
              nodeId: node.id,
              prompt: event.target.value,
            })
          }
          placeholder={t(`editor.prompt.${node.kind}`)}
          aria-label={t('editor.field.prompt')}
          // Grows with the prompt (shadcn's `field-sizing-content`) up to about
          // six lines, then scrolls. A card is a thing you read at a glance
          // between pictures; a 300-word prompt rendered in full would be a
          // column of text with the Run button somewhere below the fold. The
          // whole prompt is always editable here — the box scrolls, the text is
          // not truncated — and the sidebar shows it at full size.
          className="nodrag max-h-28 resize-none overflow-y-auto text-xs"
        />

        {/* The fan-out, said out loud on the card rather than only in the
            sidebar: it is the thing that decides what a click costs, and it has
            to be readable without selecting the node. */}
        <div className="flex flex-wrap items-center gap-1">
          {node.draft.modelIds.map(modelId => (
            <Badge
              key={modelId}
              variant="outline"
              className="max-w-40 truncate text-[10px]"
            >
              {modelById(MODEL_REGISTRY, modelId).label}
            </Badge>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="nodrag flex-1"
            disabled={blocked !== null || isRunning}
            onClick={run}
            title={blocked === null ? undefined : t(blocked)}
          >
            {isRunning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {/* The count is the number of paid calls, not the batch size —
                three models at two each is six, and the button is the last
                place that can say so before the money moves. */}
            {t('editor.action.runCount', { count: total })}
          </Button>

          {inFlight.length > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t('editor.inFlight', { count: inFlight.length })}
            </span>
          )}
        </div>

        {blocked !== null && (
          <p className="text-[11px] text-muted-foreground">{t(blocked)}</p>
        )}

        {/* Only a source node takes pixels from outside the project (#27) —
            every other kind gets its input from an edge. */}
        {node.kind === 'source' && (
          <SourceUpload project={project} node={node} compact />
        )}

        {perModel !== node.batchSize && (
          <p className="text-[11px] text-muted-foreground">
            {t('editor.batch.pinnedCollapse')}
          </p>
        )}
      </div>

      {/* What this step has produced, newest last, four to a row. A fixed
          column count rather than a fitting one: the card is a fixed width, so
          the tiles are what change size, and a run of four reads as one row of
          four however tall the pictures are. */}
      {shown.length === 0 ? (
        <p className="px-3 pb-3 text-[11px] text-muted-foreground">
          {t('editor.noCandidates')}
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-2 border-t border-border p-3">
          {shown.map(generation => (
            <CandidateTile
              key={generation.id}
              project={project}
              node={node}
              generation={generation}
              siblings={shown}
              feeds={generation.id === feeding}
            />
          ))}
        </div>
      )}

      {confirmingDelete && (
        <DeleteDialog
          node={node}
          count={candidates.length}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  )
}

/**
 * The per-node menu: everything that is a decision about the *step* rather than
 * about a picture.
 *
 * "Add downstream" is here rather than as a floating "+" on the handle because
 * the kind has to be chosen at the same time, and a submenu is a cheaper way to
 * ask than a dialog.
 */
function NodeMenu({
  node,
  hidden,
  onRename,
  onDelete,
}: {
  node: DraftNode
  hidden: number
  onRename: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)
  const showRejected = useEditorStore(store => store.state.showRejected)
  const project = useEditorStore(store => store.state.project)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="nodrag size-6 shrink-0"
          aria-label={t('editor.node.menu')}
        >
          <MoreVertical className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="nodrag">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Plus className="size-3.5" />
            {t('editor.node.addDownstream')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {STAGE_ORDER.map(kind => (
              <DropdownMenuItem
                key={kind}
                onSelect={() => {
                  if (project === null) return
                  dispatch({
                    type: 'addNode',
                    nodeId: crypto.randomUUID(),
                    kind,
                    position: placeNode(project, node.id),
                    fromNodeId: node.id,
                  })
                }}
              >
                {t(`editor.stage.${kind}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem onSelect={onRename}>
          {t('editor.node.rename')}
        </DropdownMenuItem>

        {node.inputNodeId !== null && (
          <DropdownMenuItem
            onSelect={() =>
              dispatch({ type: 'disconnectNode', nodeId: node.id })
            }
          >
            <Unlink className="size-3.5" />
            {t('editor.node.disconnect')}
          </DropdownMenuItem>
        )}

        <DropdownMenuItem
          onSelect={() => dispatch({ type: 'toggleShowRejected' })}
        >
          {showRejected
            ? t('editor.action.hideRejected')
            : t('editor.action.showRejected', { count: hidden })}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          {t('editor.node.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The one destructive confirmation in the editor.
 *
 * It names the count because that is the whole decision: deleting an empty step
 * costs nothing, and deleting one with twelve candidates on it throws away
 * twelve paid results (ADR 0005). The dialog says which of those two this is,
 * and it says the files survive until cleanup — which is the difference between
 * "undo by re-running" and "undo by asking for the folder back".
 */
function DeleteDialog({
  node,
  count,
  onClose,
}: {
  node: DraftNode
  count: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dispatch = useEditorStore(store => store.dispatch)

  return (
    <AlertDialog open onOpenChange={open => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('editor.node.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {count === 0
              ? t('editor.node.deleteEmpty')
              : t('editor.node.deleteWithCandidates', { count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => dispatch({ type: 'deleteNode', nodeId: node.id })}
          >
            {t('editor.node.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
