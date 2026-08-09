/**
 * The manifest is the source of truth (PRD §3.2), which makes it untrusted
 * input: it is a file a user can edit, copy between machines, or half-write
 * with an older build. Every test here is about what happens when it is not
 * what this build expects.
 */

import { describe, expect, it } from 'vitest'
import { ATLAS } from './fixtures'
import { MANIFEST_VERSION, readManifest, writeManifest } from './manifest'
import { UPLOAD_MODEL_ID, uploadRecipe } from './upload'
import type { Generation } from './types'

describe('a manifest round-trips', () => {
  it('comes back as the project that went in', () => {
    const project = readManifest(writeManifest(ATLAS, 1_700_000_000))
    expect(project).toEqual(ATLAS)
  })

  it('stamps the version and the time it was written', () => {
    const manifest = writeManifest(ATLAS, 1_700_000_000)
    expect(manifest.version).toBe(MANIFEST_VERSION)
    expect(manifest.updatedAt).toBe(1_700_000_000)
  })

  it('survives a trip through JSON, which is how it actually travels', () => {
    const manifest = writeManifest(ATLAS, 1)
    const project = readManifest(JSON.parse(JSON.stringify(manifest)))
    expect(project).toEqual(ATLAS)
  })
})

describe('a manifest that is not what we expect', () => {
  it('refuses a document missing the fields a project is made of', () => {
    expect(() => readManifest({ id: 'x' })).toThrow()
    expect(() => readManifest(null)).toThrow()
  })

  it('refuses an aspect ratio this build does not offer', () => {
    // Better to refuse the project than to open it at a ratio every model
    // will reject at submit.
    const manifest = { ...writeManifest(ATLAS, 1), aspect: '4:3' }
    expect(() => readManifest(manifest)).toThrow(/aspect/i)
  })

  it('refuses a version it was not written to understand', () => {
    const manifest = { ...writeManifest(ATLAS, 1), version: 999 }
    expect(() => readManifest(manifest)).toThrow(/version/i)
  })

  it('drops a generation whose stage this build does not know', () => {
    // One unreadable candidate must not cost the whole recipe — the recipe is
    // the expensive artefact (PRD §1), and the rest of it is still intact.
    const manifest = writeManifest(ATLAS, 1)
    const project = readManifest({
      ...manifest,
      generations: [
        ...manifest.generations,
        { ...manifest.generations[0], id: 'gen-future', stage: 'upscale' },
      ],
    })

    expect(project.generations.map(g => g.id)).not.toContain('gen-future')
    expect(project.generations).toHaveLength(ATLAS.generations.length)
  })

  it('clears a selection pointing at a generation that is not there', () => {
    const manifest = writeManifest(ATLAS, 1)
    const project = readManifest({
      ...manifest,
      selection: { source: 'gone', style: null, animate: null },
    })

    expect(project.selection.source).toBeNull()
  })
})

describe('assets', () => {
  it('keeps the asset as a bare file name, never a path', () => {
    const first = ATLAS.generations[0]
    if (first === undefined) throw new Error('the fixture has no generations')

    const manifest = writeManifest(
      { ...ATLAS, generations: [{ ...first, asset: 'gen-src-1.jpeg' }] },
      1
    )

    expect(manifest.generations[0]?.asset).toBe('gen-src-1.jpeg')
  })

  it('refuses an asset name that could point outside the project folder', () => {
    const manifest = writeManifest(ATLAS, 1)
    const project = readManifest({
      ...manifest,
      generations: [
        { ...manifest.generations[0], asset: '../../../etc/passwd' },
      ],
    })

    // The generation survives; only the claim about where its file lives does.
    expect(project.generations[0]?.asset).toBeNull()
  })
})

/**
 * #26 widened the manifest without moving its version, which is only safe if
 * both directions are true: what this build writes comes back whole, and what
 * an older build wrote still opens. The second is the one worth a test — every
 * project on disk today was written by that older build.
 */
describe('runs and batch sizes (#26)', () => {
  const grouped: Generation = {
    ...(ATLAS.generations[0] as Generation),
    id: 'gen-run-1',
    runId: 'run-abc',
  }

  it('carries the run a candidate belongs to', () => {
    const project = readManifest(
      writeManifest({ ...ATLAS, generations: [grouped] }, 1)
    )

    expect(project.generations[0]?.runId).toBe('run-abc')
  })

  it('carries the batch sizes the project was set to', () => {
    const project = readManifest(
      writeManifest(
        { ...ATLAS, batchSizes: { source: 2, style: 3, animate: 1 } },
        1
      )
    )

    expect(project.batchSizes).toEqual({ source: 2, style: 3, animate: 1 })
  })

  it('reads a manifest written before the slice, with neither field', () => {
    const manifest = writeManifest(ATLAS, 1) as unknown as Record<
      string,
      unknown
    >
    const older: Record<string, unknown> = {
      ...manifest,
      generations: (manifest.generations as Record<string, unknown>[]).map(
        generation => {
          const { runId: _runId, ...rest } = generation
          return rest
        }
      ),
    }
    delete older.batchSizes

    const project = readManifest(older)

    // Ungrouped, not unreadable: the candidates are all still there.
    expect(project.generations).toHaveLength(ATLAS.generations.length)
    expect(
      project.generations.every(generation => generation.runId === null)
    ).toBe(true)
    // And the project produces what a project created today would.
    expect(project.batchSizes).toEqual({ source: 4, style: 4, animate: 1 })
  })

  it('holds a hand-edited batch size to what we would actually submit', () => {
    // Forty paid calls one click away is the failure this prevents. Clamped
    // rather than refused: forty plainly means "as many as you can", and four
    // is as many as we do.
    const project = readManifest({
      ...writeManifest(ATLAS, 1),
      batchSizes: { source: 40, style: 0, animate: 'lots' },
    })

    expect(project.batchSizes).toEqual({ source: 4, style: 1, animate: 1 })
  })
})

/**
 * #28 widens the recipe rather than the manifest, so the version stays put — but
 * only if both directions hold, exactly as #26 had to show above.
 */
describe('preset provenance (#28)', () => {
  const edited: Generation = {
    ...(ATLAS.generations[3] as Generation),
    id: 'gen-edited',
    recipe: {
      ...(ATLAS.generations[3] as Generation).recipe,
      presetId: 'glass-caustics',
      presetModified: true,
    },
  }

  it('carries the flag that says the seeded fields were changed', () => {
    const project = readManifest(
      writeManifest({ ...ATLAS, generations: [edited] }, 1)
    )

    expect(project.generations[0]?.recipe.presetId).toBe('glass-caustics')
    expect(project.generations[0]?.recipe.presetModified).toBe(true)
  })

  it('reads a recipe written before the flag existed as unmodified', () => {
    // Every project on disk today was written without it. Claiming an edit
    // nobody made would be worse than claiming none.
    const manifest = writeManifest(ATLAS, 1)
    const older = {
      ...manifest,
      drafts: Object.fromEntries(
        Object.entries(ATLAS.drafts).map(([stage, recipe]) => {
          const { presetModified: _dropped, ...rest } = recipe
          return [stage, rest]
        })
      ),
      generations: manifest.generations.map(generation => {
        const { presetModified: _dropped, ...recipe } =
          generation.recipe as Record<string, unknown>
        return { ...generation, recipe }
      }),
    }

    const project = readManifest(older)

    expect(project.generations).toHaveLength(ATLAS.generations.length)
    expect(
      project.generations.every(g => g.recipe.presetModified === false)
    ).toBe(true)
    expect(project.drafts.style.presetModified).toBe(false)
  })

  it('reads a hand-edited flag that is not a boolean as unmodified', () => {
    const manifest = writeManifest(ATLAS, 1)
    const project = readManifest({
      ...manifest,
      generations: manifest.generations.map(generation => ({
        ...generation,
        recipe: { ...(generation.recipe as object), presetModified: 'yes' },
      })),
    })

    expect(project.generations[0]?.recipe.presetModified).toBe(false)
  })
})

describe('an upload survives the manifest (#27)', () => {
  const upload: Generation = {
    id: 'upload-1',
    stage: 'source',
    recipe: uploadRecipe('hero-plate.png'),
    seed: null,
    verdict: 'unrated',
    createdAt: 1_700_000_000,
    ordinal: 1,
    asset: 'upload-1.png',
    runId: null,
  }

  it('comes back as the same upload, at the version this build already writes', () => {
    // The reserved model id is why the manifest version does not have to move:
    // `readRecipe` only ever asked that `modelId` is a string.
    const manifest = writeManifest(
      { ...ATLAS, generations: [upload], selection: { ...ATLAS.selection } },
      1_700_000_000
    )

    expect(manifest.version).toBe(MANIFEST_VERSION)

    const project = readManifest(manifest)
    const read = project.generations.find(g => g.id === 'upload-1')

    expect(read).toEqual(upload)
    expect(read?.recipe.modelId).toBe(UPLOAD_MODEL_ID)
    expect(read?.asset).toBe('upload-1.png')
  })

  it('is read as a generation like any other, with no shape of its own', () => {
    const project = readManifest(
      writeManifest(
        { ...ATLAS, generations: [upload], selection: { ...ATLAS.selection } },
        1_700_000_000
      )
    )

    // The point of the reserved id: nothing in the reader branches on it.
    expect(project.generations).toHaveLength(1)
    expect(project.generations[0]?.stage).toBe('source')
  })
})
