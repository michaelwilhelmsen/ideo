/**
 * The candidate strip and the tile in it (#26).
 *
 * Two claims are checked here. A seed can be pinned from the candidate it
 * belongs to — PRD §4.3's "changing one fragment changes one thing" is said
 * while looking at the picture you mean, not by way of whatever the sidebar
 * happens to have selected. And a strip full of candidates says which click
 * produced which, or a four-up reads as four unrelated attempts.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import {
  UPLOAD_MODEL_ID,
  uploadRecipe,
  type Generation,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { runGroups } from '@/lib/recipe'
import { GenerationTile } from './shared'
import {
  ATLAS,
  ATLAS_ANIMATE_NODE,
  ATLAS_SOURCE_NODE,
  ATLAS_STYLE_NODE,
  LEDGER,
  LEDGER_SOURCE_NODE,
  fixtureDraft,
  fixtureNode,
} from '../../lib/recipe/fixtures'

/** Opens a project so the tiles dispatch against something. */
function open(project: Project): void {
  useEditorStore.getState().dispatch({
    type: 'openProject',
    project,
    directory: `/tmp/${project.id}`,
  })
}

function openProject(): Project {
  const project = useEditorStore.getState().state.project
  if (project === null) throw new Error('nothing is open')
  return project
}

beforeEach(() => {
  useEditorStore.getState().reset()
})

describe('pinning a seed from the candidate that has it', () => {
  const candidate = LEDGER.generations[0] as Generation

  it('pins that candidate’s seed, not the selected one’s', async () => {
    open(LEDGER)

    render(
      <GenerationTile
        project={LEDGER}
        generation={candidate}
        selected={false}
      />
    )
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /pin this seed/i }))

    expect(fixtureDraft(openProject(), LEDGER_SOURCE_NODE).seed).toEqual({
      mode: 'pinned',
      value: candidate.seed,
    })
  })

  it('unpins when the pinned candidate is clicked again', async () => {
    open(LEDGER)
    const user = userEvent.setup()

    // The live project, as the panel that renders this tile passes it: the
    // button is a toggle, so it has to see the draft it just changed.
    function LiveTile() {
      const project = useEditorStore(store => store.state.project)
      if (project === null) return null
      return (
        <GenerationTile
          project={project}
          generation={candidate}
          selected={false}
        />
      )
    }

    render(<LiveTile />)
    await user.click(screen.getByRole('button', { name: /pin this seed/i }))
    await user.click(screen.getByRole('button', { name: /pin this seed/i }))

    expect(fixtureDraft(openProject(), LEDGER_SOURCE_NODE).seed).toEqual({
      mode: 'roll',
    })
  })

  it('is absent on a candidate with no seed to pin', () => {
    // An upload has no model behind it, so there is nothing to reproduce —
    // offering the button would promise a re-run that cannot happen (#27).
    const upload: Generation = {
      id: 'upload-1',
      stage: 'source',
      recipe: uploadRecipe('hero-plate.png', LEDGER_SOURCE_NODE),
      treatment: null,
      costUsd: 0,
      requestId: null,
      actualCostUsd: null,
      seed: null,
      verdict: 'unrated',
      createdAt: 1,
      ordinal: 9,
      asset: 'upload-1.png',
      runId: null,
    }

    open(LEDGER)
    render(
      <GenerationTile project={LEDGER} generation={upload} selected={false} />
    )

    expect(upload.recipe.modelId).toBe(UPLOAD_MODEL_ID)
    expect(
      screen.queryByRole('button', { name: /pin this seed/i })
    ).not.toBeInTheDocument()
  })

  it('is absent when the draft’s model has no seed field at all', () => {
    // Kling O1 reports no seed (PRD §9.1). A pin the next run cannot honour is
    // a reproducibility claim the recipe does not have.
    const project: Project = {
      ...ATLAS,
      generations: [
        {
          ...(ATLAS.generations[0] as Generation),
          recipe: {
            ...(ATLAS.generations[0] as Generation).recipe,
            nodeId: ATLAS_ANIMATE_NODE,
          },
          seed: 42,
        },
      ],
    }

    open(project)
    render(
      <GenerationTile
        project={project}
        generation={project.generations[0] as Generation}
        selected={false}
      />
    )

    expect(fixtureDraft(project, ATLAS_ANIMATE_NODE).modelIds[0]).toBe(
      'fal-ai/kling-video/o1/image-to-video'
    )
    expect(
      screen.queryByRole('button', { name: /pin this seed/i })
    ).not.toBeInTheDocument()
  })
})

describe('what a candidate’s preview renders (#29)', () => {
  /** One animate candidate, with whatever file the runner filed for it. */
  function clip(asset: string | null): Generation {
    return {
      id: 'gen-ani-9',
      stage: 'animate',
      recipe: {
        ...(ATLAS.generations.at(-1) as Generation).recipe,
        nodeId: ATLAS_ANIMATE_NODE,
      },
      treatment: null,
      costUsd: 0,
      requestId: null,
      actualCostUsd: null,
      seed: null,
      verdict: 'unrated',
      createdAt: 1,
      ordinal: 1,
      asset,
      runId: null,
    }
  }

  function tileFor(generation: Generation) {
    open(ATLAS)
    return render(
      <GenerationTile
        project={ATLAS}
        generation={generation}
        selected={false}
      />
    ).container
  }

  it('plays a clip where a still would be shown, muted and looping', () => {
    // The artefact is a background that runs on a page, so the closest honest
    // preview of it is one that runs here. Muted and looping rather than a
    // poster frame, and in the tile rather than only in a detail view: animate
    // is chosen from the same strip every other stage is.
    const container = tileFor(clip('gen-ani-9.mp4'))

    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toContain('gen-ani-9.mp4')
    expect(video?.muted || video?.hasAttribute('muted')).toBe(true)
    expect(video?.loop).toBe(true)
    expect(container.querySelector('img')).toBeNull()
  })

  it('reads the file rather than the stage, so a still on animate is a still', () => {
    // The manifest records a file name; asking the file what it is means a
    // candidate saved by an older build still renders as whatever it holds.
    const container = tileFor(clip('gen-ani-9.png'))

    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('falls back to the stand-in for a candidate whose file has not landed', () => {
    const container = tileFor(clip(null))

    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })
})

/**
 * Which click produced which candidate (#26).
 *
 * Asserted against `runGroups` rather than against a component, because the
 * strip that used to render it is gone: the canvas draws a node's candidates as
 * child nodes (ADR 0005), and the grouping is what a node card labels them by.
 * The claim is the same one, made where it is actually decided.
 */
describe('runs are grouped and numbered', () => {
  it('groups one click together and leaves earlier candidates unnumbered', () => {
    const groups = runGroups(ATLAS, fixtureNode(ATLAS, ATLAS_SOURCE_NODE), true)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.number).toBe(1)
    expect(groups[0]?.generations).toHaveLength(3)

    // Atlas's style candidates were made before runs were recorded, so they
    // carry no run and no number rather than being refused.
    const style = runGroups(ATLAS, fixtureNode(ATLAS, ATLAS_STYLE_NODE), true)
    expect(style.every(group => group.number === null)).toBe(true)
  })

  it('numbers a second run separately from the first', () => {
    const project: Project = {
      ...ATLAS,
      generations: [
        ...ATLAS.generations,
        {
          ...(ATLAS.generations[0] as Generation),
          id: 'gen-src-4',
          ordinal: 4,
          runId: 'run-two',
        },
      ],
    }

    const groups = runGroups(
      project,
      fixtureNode(project, ATLAS_SOURCE_NODE),
      true
    )

    expect(groups.map(group => group.number)).toEqual([1, 2])
  })
})
