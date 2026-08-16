# 0005 — The editor is a graph of drafts

Status: accepted
Date: 2026-08-16
Supersedes: the three-stage tab bar described in PRD §10 and in `StageEditor.tsx`'s header comment.

## The premise, verified

Before designing anything, the claim that history was already a DAG was checked
against the code rather than assumed. It holds, and it holds precisely:

- `Generation.recipe.inputGenerationId` (`types.ts`) is a real pointer from one
  candidate to the candidate it was made from. It is written by `freezeRecipe`
  at submit time and persisted per generation.
- `Project.generations` is one flat, append-only array. `stage` is a field on
  each entry, not a bucket — `generationsForStage` is a `filter`.
- `resolvedInputId` (`selectors.ts`) already refused to insist on the immediate
  upstream stage: it walks `upstreamStages` nearest-first and lets animate
  consume a source when style is empty. Stages were already skippable.

So the edges **between results** exist and are durable. What did not exist is a
graph **between drafts**: `Project.drafts` was `Record<StageKind, StageRecipe>`
— exactly three forms, one per stage, addressed by a string literal. Every
draft-editing action in `reducer.ts` carried `stage: StageKind` as its address.
That is the thing this change replaces.

## What a node is

A node is a **draft**: a re-runnable step. Not a result, not a snapshot, not a
lineage marker. Running it produces candidates; running it again produces more
candidates beside the first ones. The node stays editable throughout.

```
DraftNode {
  id, kind, title, position
  draft: DraftRecipe   // modelIds[], prompt, preset, seed, params, options
  batchSize            // candidates PER MODEL
  inputNodeId          // the edge between drafts — this is the new thing
  pinnedInputId        // a specific candidate of that node, or null to follow it
  pick                 // which of MY candidates is "the one"
}
```

### Fan-out is `modelIds`, not `modelId`

The whole point is one prompt against several models at once, so the editable
recipe holds a **list** of model ids and the frozen recipe holds **one**. That
is the split between `DraftRecipe` and `StageRecipe`, and it is why they are now
two types rather than one:

- `DraftRecipe` — what the form holds. `modelIds: readonly string[]`. No
  `inputGenerationId`, no `nodeId`: those are not typed, they are resolved.
- `StageRecipe` — what a generation carries, unchanged in spirit and widened by
  one field. `modelId` (singular), `inputGenerationId`, and now `nodeId`.

A frozen recipe is therefore exactly _the draft plus the three resolutions made
at the moment of the run_: which model, which input candidate, which draft.
`freezeDraft(registry, project, node, modelId)` is the one place that happens.

One click on a node with three models and `batchSize: 2` submits six jobs, each
with its own frozen `StageRecipe`. They share a `runId`, so the six arrive as
one run and are labelled as the one choice they are — the grouping machinery
from #26 needed no change, because it was already keyed on `runId` rather than
on anything stage-shaped.

Parameters stay a single bag keyed by each model's own field names, and each
frozen copy runs it through the existing `reconcileParams(model, params)`. That
is not a new mechanism: it is exactly what `chooseModel` already did when you
swapped one model for another, applied N times instead of once.

**Model count is capped at 4**, the same ceiling `MAX_BATCH_SIZE` puts on a
batch, and for the same reason: the cap is a spending limit before it is a
layout constraint. Four models at four candidates is sixteen paid calls one
click away, and that is as far as one click is allowed to go.

### Presets must speak every selected model's idiom

`composePreset` gates on a model's `promptStyle`. With N models sharing one
prompt box, a preset is offered only when **all** of them read it. In practice
this bites once — Qwen-Image 2 is the only `tags` model surveyed — and the
alternative is seeding prose into a keyword model, which is the cross-send
PRD §6.2 exists to prevent.

## Candidates are wirable, and that is all they need to be

The input edge's source is a **candidate**, not a draft. "Which picture fed this
run" is the question the canvas exists to answer, so a candidate has to be
something an edge can land on.

It gets that from a **handle whose id is the generation's id**, rendered on the
thumbnail inside its card. React Flow anchors an edge to a handle wherever the
browser put it, so the picture is addressable without being a node.

The first cut made candidates React Flow child nodes (`parentId` +
`extent: 'parent'`) instead. That works, but a child node is positioned in its
parent's coordinates, so the card had to **declare its own height** for the grid
to be placed under it — and a declared height is a number that has to be right
for a card holding a two-word prompt and a card holding three hundred words, a
source card with an upload row and a style card without. It was not: a long
prompt rendered straight over the canvas. Handles let the card be measured
instead, which is the answer the browser already had.

## Edges

Each draft node has **at most one incoming edge**, so the draft graph is a
forest and cycle checking is a walk up `inputNodeId`. `canConnect` refuses an
edge whose source is a descendant of its target.

The edge is drawn from the pinned candidate when `pinnedInputId` is set, and
from the input node's own output handle otherwise. One edge either way — the
structure (`inputNodeId`) is what persists, the pin is a refinement of it.

`resolvedInputId` keeps its ladder, rebased on the node graph:

1. `pinnedInputId`, if it is still a candidate of `inputNodeId`.
2. the input node's `pick`.
3. its newest approved candidate, else its newest unrejected one.

The old fourth rung — "walk further upstream when the previous stage is empty"
— is **gone**, and its absence is the feature. Skipping a stage used to be an
inference the selector made on your behalf at video prices. Now you draw the
edge from the source node straight to the animate node and the graph says so.

## Kinds, and what is left of `StageKind`

`kind` survives on the node and does exactly two things: it picks the model
pool (`modelsForStage`) and it says whether the node takes an input at all
(`source` does not; `style` and `animate` do). It no longer orders anything.

`STAGE_ORDER` is now only the order the "add node" menu lists kinds in.

This is a deliberate widening: **a style node may feed another style node.**
`upstreamStages` used to forbid it, which made restyling a restyle impossible
for no reason anybody could state once the pipeline stopped being a wizard.
Cycles are prevented by ancestry, not by a total order on kinds.

## The tab bar is gone

There is no second editing surface. `StageEditor`'s tab strip, `activeStage`
and the `selectStage` action are deleted. `EditorState.selectedNodeId` replaces
`activeStage`; the right sidebar edits whichever node is selected on the canvas,
and selecting nothing shows the project's own panel.

The effects tab stays a tab, because it was never a stage: it has no model, no
seed and no price (#36). It is now a mode of the right sidebar pinned to a
candidate, opened from a candidate node's menu.

## React Flow, not FlowGram

Confirmed, and the reasoning is about who owns the document.

This repo already has a document model. `reducer.ts` is 1400 lines of pure
transitions, `selectors.ts` is 550 lines of derived reads that deliberately
store nothing, and `manifest.ts` is the single place that decides what a project
_is_ on disk. `docs/developer/state-management.md` calls the store "a
subscription mechanism, not a place for logic".

FlowGram is an engine, and its own docs say so: `FlowDocument` with
`fromJSON`/`toJSON`, an ECS of node entities with `NodePositionData` /
`NodeFormData` / `NodeLineData` components, a node registry, a form engine, a
variable engine, its own history plugin, and an `onContentChange` hook whose
documented purpose is auto-save. Every one of those is a second answer to a
question this codebase already answers:

| FlowGram gives you          | This repo already has                            |
| --------------------------- | ------------------------------------------------ |
| `FlowDocument` + `toJSON`   | `Project` + `writeManifest`                      |
| node registry / form engine | `MODEL_REGISTRY` + `StageParameters`             |
| variable engine             | `presets.ts` `composePreset` / `presetVariables` |
| history plugin              | the pure reducer                                 |
| `onContentChange` auto-save | `useProjectLibrary`'s debounced `saveProject`    |

Adopting it would mean either mirroring `project.json` into its document on
every edit and back on every change — two sources of truth for the expensive
artefact (PRD §1) — or surrendering the manifest to it, which puts the recipe
format under a third-party engine's serializer.

React Flow does none of that. In controlled mode it takes `nodes` and `edges` as
props and hands back **change descriptors**; it stores no document. So:

- `nodes` / `edges` are a pure selector over `Project` (`canvas.ts`
  `flowNodes` / `flowEdges`).
- `onNodesChange` filters for the changes that mean something to us — position,
  selection, removal — and dispatches existing reducer actions. Dimension and
  the rest are dropped.
- `onConnect` dispatches `connectNodes`, which the reducer validates against
  `canConnect`. React Flow never gets to decide whether an edge is legal.
- Pan and zoom are the one thing React Flow _does_ own, uncontrolled, because
  the viewport is ephemeral and belongs in no manifest. Node **positions** are
  persisted, because the layout is the user's work.

Local-only Tauri app, no backend, no collaboration — nothing in FlowGram's
column is load-bearing here, and everything in it is load-bearing somewhere
else already.

## No migration

`MANIFEST_VERSION` goes 1 → 2 and there is no upgrade path.

**What happens when an old manifest is opened:** `readManifest` throws before
reading anything else, exactly as it already does on a version mismatch — the
version check is the second statement in the function. The project does not
open, a toast says the file was written by an incompatible build, and the
project stays on disk untouched. Nothing is rewritten, nothing is deleted, and
opening a v1 project can never half-succeed.

This is initial development and there are no manifests in the wild. A migration
would have to invent node positions, guess which of three drafts deserved to
become a node, and decide what a `selection` meant per stage — three guesses,
all wrong for anything but an empty project, in service of files that do not
exist. The throw is the honest answer.

## Deleting a node

A node is where a candidate lives, so deleting one takes its candidates with it.
The UI confirms with the count when there are any, downstream nodes are detached
(`inputNodeId: null`) rather than deleted with it, and the **asset files are
left on disk** for the existing deliberate cleanup pass (PRD §10.3) — so nothing
is unrecoverable until the user asks for it to be.

A job that lands for a node that has since been deleted is dropped with a
warning. There is nowhere truthful to put the picture, and inventing a home for
it would be the ghost-candidate surface this change exists to remove.
