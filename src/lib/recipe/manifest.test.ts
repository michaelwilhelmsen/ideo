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
