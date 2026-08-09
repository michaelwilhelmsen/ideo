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
import { render, screen, within } from '@/test/test-utils'
import {
  ATLAS,
  LEDGER,
  UPLOAD_MODEL_ID,
  uploadRecipe,
  type Generation,
  type Project,
} from '@/lib/recipe'
import { useEditorStore } from '@/store/editor-store'
import { CandidateStrip, GenerationTile } from './shared'

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

    expect(openProject().drafts.source.seed).toEqual({
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

    expect(openProject().drafts.source.seed).toEqual({ mode: 'roll' })
  })

  it('is absent on a candidate with no seed to pin', () => {
    // An upload has no model behind it, so there is nothing to reproduce —
    // offering the button would promise a re-run that cannot happen (#27).
    const upload: Generation = {
      id: 'upload-1',
      stage: 'source',
      recipe: uploadRecipe('hero-plate.png'),
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
          stage: 'animate',
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

    expect(project.drafts.animate.modelId).toBe(
      'fal-ai/kling-video/o1/image-to-video'
    )
    expect(
      screen.queryByRole('button', { name: /pin this seed/i })
    ).not.toBeInTheDocument()
  })
})

describe('the strip says which click produced which candidate', () => {
  it('labels each run, and leaves earlier candidates unlabelled', () => {
    open(ATLAS)
    const { container } = render(
      <CandidateStrip project={ATLAS} stage="source" />
    )

    // Atlas's three source candidates are one run; its style candidates were
    // made before runs were recorded and carry no label.
    expect(within(container).getByText('Run 1')).toBeInTheDocument()

    const style = render(<CandidateStrip project={ATLAS} stage="style" />)
    expect(within(style.container).queryByText(/^Run /)).toBeNull()
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

    open(project)
    render(<CandidateStrip project={project} stage="source" />)

    expect(screen.getByText('Run 1')).toBeInTheDocument()
    expect(screen.getByText('Run 2')).toBeInTheDocument()
  })
})
