# The canvas

The editor's main pane is a graph of drafts (ADR 0005). This is how it is wired.

## The one rule

**React Flow renders. It does not own state.**

`components/editor/flow-graph.ts` is a pure function of the store. `flowNodes()`
and `flowEdges()` are called on every render, React Flow gets them as props, and
the only thing it hands back is a list of change descriptors. There is no
document, no adapter, and no second copy of the graph — `project.json` is still
the only place a node exists.

```
EditorState ──flowNodes/flowEdges──▶ <ReactFlow nodes edges />
     ▲                                        │
     └──── dispatch(EditorAction) ◀───────────┘
            actionsForNodeChanges
            actionsForConnection
```

If you find yourself calling `applyNodeChanges` or `useNodesState`, stop: that is
React Flow storing the graph, and the reducer already does.

**The one thing React Flow does own** is the viewport — pan and zoom, left
uncontrolled. It is ephemeral and belongs in no manifest. Node _positions_ are
the user's work and go through `moveNode` like every other edit.

### Why every drag frame reaches the reducer

`actionsForNodeChanges` forwards _every_ position change, including the
intermediate ones. That is not an oversight: `nodes` is a derivation of the
store, so a frame the reducer never sees is a frame the card does not move. It is
one field on one node, and the manifest write behind it is already debounced to
600ms (`useProjectLibrary`).

## The node type

There is one: `draft`, drawn by `DraftNodeCard`. A candidate is markup inside its
card (`CandidateTile`), not a node.

`NODE_TYPES` lives at module scope. React Flow re-registers every node type when
that object changes identity, which on an inline literal is every render — and
re-registering unmounts and remounts every card.

### How a candidate is still wirable

Each tile renders a `Handle` **whose id is the generation's id**. An edge anchors
to a handle wherever the browser put it, so a line can start at one thumbnail
without that thumbnail having a position, a size, or a place in the node array.

That is also how a drag is disambiguated: `actionsForConnection` reads
`sourceHandle`. The card's own handle (`OUTPUT_HANDLE`) means "from that step";
anything else is a generation id and means "from _that picture_", which pins it.

Because the handle count changes whenever a run lands, the card calls
`useUpdateNodeInternals` when its visible candidate list changes. React Flow
caches handle positions per node, and without it the edges of a card that just
grew stay anchored where its handles used to be.

### Pick and pin, as two marks

A tile carries two different statements, and they are drawn differently on
purpose:

- **The pick** (`node.pick`) is the card's own — "this is the one this step
  settled on". A solid primary border tight to the picture, and it is what
  `aria-pressed` reports.
- **The pin** is the _consumer's_ — "the step being edited works from this
  picture". A dashed sky halo outside the tile, plus a named icon in the marks
  strip, and it follows `selectedNodeId`: `DraftNodeCard` resolves the
  **selected** node's input (`resolvedInputId`) and marks whichever of its own
  candidates that is.

They differ in kind and not only in colour, because on a greyscale theme two
coloured borders are one highlight seen twice. For the same reason the tile
carries the app's own `focus-visible` ring and `outline-none`: an unstyled
button lets the browser draw a blue focus ring on whatever was clicked last,
which is a third highlight nobody asked for, in the one hue the theme never
uses.

They are separate because the state is separate: two style steps wired to one
source can pin different candidates of it, and changing "Working from" in the
sidebar writes a pin on the consumer while the upstream pick stays where it was.
One mark doing both jobs looked like a bug the moment they disagreed — the
sidebar changed, the edge moved, and the highlighted thumbnail did not.

Resolved rather than read off `pinnedInputId`, so the ring shows what a run would
actually consume, including the rungs below the pin.

### Looking at one properly

A tile is ~118px. `CandidateViewer` is the full-size look: opened from the
magnifier on a tile or from the picked preview in the sidebar, it steps through
**the node's visible candidates** with the arrow keys and carries the verdict
buttons, because a verdict given to a thumbnail is a verdict given to something
you have not seen.

The row it steps through is the node's, not the project's — a source still and an
animate frame are not a comparison anybody makes. Two details that look like
style but are not: the ends use `aria-disabled`, not `disabled` (a button that
disables itself under the pointer drops focus to the body, and the arrow keys are
read from the dialog), and there is no wrapping (landing back on the first
picture reads as "this is the same one").

## Heights are measured, never declared

A card sets `style.width` and nothing else; React Flow's ResizeObserver supplies
the height. `initialWidth`/`initialHeight` cover the frame before the first
measurement — note they are **not** `width`/`height`, which would _override_ the
measurement.

This is a scar. Candidates were once child nodes, which forced the card to
declare a height so the grid could be positioned beneath it, and a `CARD_HEADER`
constant cannot be simultaneously right for a two-word prompt, a three-hundred
word one, and a source card carrying an upload row. It was wrong, and the card
painted over the canvas.

So: **no layout constant that has to be kept in step with markup by hand.** The
card carries `flex flex-col` and no `overflow-hidden` (a handle hangs half
outside the border, and clipping the box clips every connection point on it).
The prompt box is the one bounded thing — `max-h-28`, then it scrolls, so one
long prompt cannot make a card taller than the viewport.

## `nodrag`

React Flow treats a mousedown anywhere on a node as the start of a drag. Any
interactive element inside a card needs `className="nodrag"`, or a textarea
cannot be selected into and a button fires while the card slides away.

## Edges

One per wired node, no more. Its source is always the input **card**; which
_handle_ it leaves is the interesting part. `flowEdges` aims it at the candidate
`resolvedInputId` settled on — an edge leaving a thumbnail says "this picture
feeds that step" — and falls back to the card's own handle when that candidate is
not on screen (a hidden reject) or belongs to another card (a stale pin). An edge
pointing at a handle that does not exist collapses to the node's top-left corner,
so the fallback is not optional.

A pin draws solid and animated; a follow draws dashed.

Dragging an edge is two different requests depending on which handle it left, and
`actionsForConnection` is where they are told apart:

- **From a candidate's handle** → `connectNodes` + `pinNodeInput`. "Feed this
  step _that_ picture."
- **From the card's handle** → `connectNodes` alone. Which picture is left to the
  ladder.

`isValidConnection` refuses an illegal edge before it lands, but it asks
`canConnect` — the reducer's own rule — rather than reimplementing the cycle
check. The reducer asks again on `connectNodes`, because a hand-edited manifest
never went through a drag.

## Dropping a line on bare canvas

A third request wears the same gesture: letting the line go over nothing opens a
"+ Add step" menu at the drop point, and choosing a kind creates that node
already wired to whatever the drag left.

`onConnectEnd` hands React Flow's `FinalConnectionState` to `connectionDrop`,
which either names the drop (`{source, sourceHandle}`) or refuses it. It refuses
a drop **on** a node — `onConnect` already has the legal case, and a card built
under the cursor in the illegal one lands on top of the node the user aimed at —
and a drag out of a _target_ handle, which would be an upstream node and is not
implemented.

`actionsForConnectionDrop` then says the same two things `actionsForConnection`
does, with the target minted rather than picked: `addNode` carrying
`fromNodeId`, plus `pinNodeInput` where the line left a candidate's handle. The
menu offers only kinds where `needsInput` holds — a source node hung off an edge
would arrive unwired, which is not what the drag asked for.

Two coordinate systems are in play, and both are needed: the node is placed with
`screenToFlowPosition` (pans and zooms with the graph), the menu with the
pointer's offset inside the pane (does not).

## What is deliberately not deletable

Cards declare `deletable: false` and the canvas sets `deleteKeyCode={null}`.
Deleting a node takes its candidates with it (ADR 0005), so it goes through the
card's own menu, which confirms and names the count. A stray Backspace must not
be able to discard paid results.

Edges _are_ deletable; removing one is `disconnectNode` on its target.

## Where the graph is queried

- `lib/recipe/graph.ts` — shape questions: `canConnect`, `ancestorsOf`,
  `placeNode`, `makeNode`, `heldModelIds`. Pure, mints nothing.
- `lib/recipe/selectors.ts` — content questions: `resolvedInputId`,
  `eligibleInputs`, `blockedReasonKey`, `runSizeFor`.
- `components/editor/flow-graph.ts` — presentation only: what React Flow needs
  and the translation back to actions.

Nothing in `components/` decides whether an edge is legal or what a node would
run from. Those answers live once, below the component line.
