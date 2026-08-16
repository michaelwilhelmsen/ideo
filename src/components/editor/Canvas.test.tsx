/**
 * The canvas as a surface (ADR 0005).
 *
 * Deliberately about the things that only exist because the tab bar went away:
 * every step on screen at once, a node's own Run button saying what a click
 * costs, and the effects panel reachable from a candidate and closable back to
 * the graph. The *rules* — which edges are legal, what a run freezes — are
 * asserted against the reducer and the selectors, where they live.
 *
 * The effects round-trip is here because it is the one thing the tab bar was
 * silently providing: with three tabs, "the effects tab" was a place. On a
 * canvas it has to be opened and closed explicitly, and a panel you can enter
 * but not leave is worse than one you cannot enter.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { commands } from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'
import {
  ATLAS,
  ATLAS_ANIMATE_NODE,
  ATLAS_STYLE_NODE,
  withFixtureDraft,
} from '../../lib/recipe/fixtures'
import type { Project } from '@/lib/recipe'
import { Canvas } from './Canvas'

function open(project: Project = ATLAS): void {
  useEditorStore
    .getState()
    .dispatch({ type: 'openProject', project, directory: `/tmp/${project.id}` })
}

function canvas() {
  return within(screen.getByRole('region', { name: 'Steps' }))
}

beforeEach(() => {
  useEditorStore.getState().reset()
  vi.mocked(commands.activeJobs).mockResolvedValue({ status: 'ok', data: [] })
})

describe('the canvas', () => {
  it('draws every step at once, each with its own run button', () => {
    open()
    render(<Canvas />)

    // No "next", and no tab hiding two of the three (PRD §4.1).
    expect(canvas().getAllByRole('button', { name: /^Generate/ })).toHaveLength(
      3
    )
  })

  it('says what one click costs, not how big the batch is', () => {
    // The number on the button is the number of paid calls. Three models at four
    // candidates each is twelve, and a button that said "4" would be describing
    // a third of the charge.
    const project = withFixtureDraft(ATLAS, ATLAS_STYLE_NODE, {
      modelIds: [
        'fal-ai/flux/dev/image-to-image',
        'fal-ai/qwen-image-2/edit',
        'fal-ai/nano-banana-2/edit',
      ],
      seed: { mode: 'roll' },
    })

    open(project)
    render(<Canvas />)

    expect(canvas().getByRole('button', { name: 'Generate 12' })).toBeVisible()
  })

  it('names every model of the fan-out on the card', () => {
    // Readable without selecting the node, because it is what decides the cost.
    const project = withFixtureDraft(ATLAS, ATLAS_STYLE_NODE, {
      modelIds: ['fal-ai/flux/dev/image-to-image', 'fal-ai/qwen-image-2/edit'],
    })

    open(project)
    render(<Canvas />)

    expect(canvas().getByText(/FLUX\.1 dev/i)).toBeVisible()
    expect(canvas().getByText(/Qwen/i)).toBeVisible()
  })

  it('collapses the batch on a pinned seed but keeps every model', () => {
    // Two models, one seed: two different pictures, which is the comparison a
    // pin exists to make. Four copies of each would not be.
    const project = withFixtureDraft(ATLAS, ATLAS_STYLE_NODE, {
      modelIds: ['fal-ai/flux/dev/image-to-image', 'fal-ai/qwen-image-2/edit'],
      seed: { mode: 'pinned', value: 7 },
    })

    open(project)
    render(<Canvas />)

    expect(canvas().getByRole('button', { name: 'Generate 2' })).toBeVisible()
  })

  it('refuses to run a node wired to nothing, and says which fix it needs', () => {
    const project: Project = {
      ...ATLAS,
      nodes: ATLAS.nodes.map(node =>
        node.id === ATLAS_ANIMATE_NODE
          ? { ...node, inputNodeId: null, pinnedInputId: null }
          : node
      ),
    }

    open(project)
    render(<Canvas />)

    // Not "needs an input" — that would send the user to the input row, where
    // there is nothing to pick until an edge exists.
    expect(canvas().getByText(/wire this step to another one/i)).toBeVisible()
  })

  it('opens a candidate at full size from its thumbnail', async () => {
    // A tile is roughly 118px of a picture that cost money. Judging one — two
    // models' takes on the same prompt, a hand, text in the background — is not
    // something that survives a thumbnail, so the full-size look has to be one
    // click and not a mode.
    open()
    render(<Canvas />)

    const [tile] = canvas().getAllByRole('button', { name: 'View full size' })
    await userEvent.click(tile as HTMLElement)

    const dialog = within(screen.getByRole('dialog'))
    // The verdict lives here because this is where it is actually decidable.
    expect(dialog.getByRole('button', { name: 'Approve' })).toBeVisible()
    expect(dialog.getByRole('button', { name: 'Reject' })).toBeVisible()
  })

  it('steps along the row it was opened from, by button and by arrow key', async () => {
    // The neighbours are what the picture is being judged against, so a
    // twelve-way fan-out is flicked through rather than opened twelve times.
    // The set is the *node's* row: a source still and an animate frame are not
    // a comparison anybody makes.
    open()
    render(<Canvas />)

    const [tile] = canvas().getAllByRole('button', { name: 'View full size' })
    await userEvent.click(tile as HTMLElement)

    // Two, not three: the source node's rejected candidate is not on the card,
    // so it is not in the row either.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('1 of 2')).toBeVisible()
    // Nowhere to go backwards from the first, and no wrapping — landing back on
    // the first picture reads as "this is the same one".
    expect(dialog.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )

    await userEvent.click(dialog.getByRole('button', { name: 'Next' }))
    expect(dialog.getByText('2 of 2')).toBeVisible()

    // Past the end, and it stays put rather than wrapping.
    await userEvent.keyboard('{ArrowRight}')
    expect(dialog.getByText('2 of 2')).toBeVisible()

    await userEvent.keyboard('{ArrowLeft}')
    expect(dialog.getByText('1 of 2')).toBeVisible()
  })

  it('opens the effects panel on a candidate and gets back to the graph', () => {
    open()
    render(<Canvas />)

    // Opened from a candidate rather than from a tab: a treatment is stored per
    // generation, so which one is being treated has to be the gesture (#36).
    act(() => {
      useEditorStore
        .getState()
        .dispatch({ type: 'pinTreatment', generationId: 'gen-sty-2' })
    })

    expect(screen.getByRole('heading', { name: 'Effects' })).toBeVisible()

    const back = screen.getByRole('button', { name: /back to the steps/i })
    expect(back).toBeVisible()
  })

  it('closes the effects panel without losing which candidate it was on', async () => {
    open()
    render(<Canvas />)

    act(() => {
      useEditorStore
        .getState()
        .dispatch({ type: 'pinTreatment', generationId: 'gen-sty-2' })
    })

    await userEvent.click(
      screen.getByRole('button', { name: /back to the steps/i })
    )

    expect(useEditorStore.getState().state.effectsOpen).toBe(false)
    // The pin is about a candidate, not about what is on screen, so reopening
    // lands back where you were.
    expect(useEditorStore.getState().state.treatmentTarget).toBe('gen-sty-2')
  })
})
