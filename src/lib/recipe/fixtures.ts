/**
 * THE FIXTURE SEAM — what the editor still cannot get from anywhere real.
 *
 * Shrinking each time a slice lands. #23 made projects come off disk, so the
 * two projects below are test data rather than what the app boots into; #25
 * replaced the fixture capability registry with the verified one in `models.ts`,
 * so the model ids here name real endpoints and resolve against it. What remains
 * temporary:
 *  - the presets, until #28,
 *  - `previewArt`, the stand-in for pixels a stage cannot generate yet. The
 *    source stage produces real files; style and animate arrive in #28/#29.
 */

import type {
  EditorState,
  Generation,
  Project,
  ProjectSummary,
  StageKind,
  StageRecipe,
} from './types'

/** Fixed so a reload shows the same thing twice. */
const T0 = Date.UTC(2026, 7, 8, 9, 0, 0)
const MINUTE = 60_000

/** PRD §6 — two independent libraries, mixed freely. */
export interface Preset {
  readonly id: string
  readonly name: string
  readonly fragment: string
}

export const STYLE_PRESETS: readonly Preset[] = [
  {
    id: 'editorial-noir',
    name: 'Editorial noir',
    fragment: 'high-contrast monochrome, hard key light, deep falloff',
  },
  {
    id: 'sun-bleached-film',
    name: 'Sun-bleached film',
    fragment: 'washed highlights, warm cast, soft halation, ISO 3200 grain',
  },
  {
    id: 'clean-product-studio',
    name: 'Clean product studio',
    fragment: 'seamless backdrop, even diffuse light, no visible shadow',
  },
  {
    id: 'liquid-chrome',
    name: 'Liquid chrome',
    fragment: 'polished metal, caustic reflections, cool specular highlights',
  },
]

export const MOTION_PRESETS: readonly Preset[] = [
  {
    id: 'slow-drift',
    name: 'Slow drift',
    fragment: 'slow lateral drift, no cuts',
  },
  {
    id: 'gentle-pulse',
    name: 'Gentle pulse',
    fragment: 'subtle breathing scale',
  },
  {
    id: 'parallax-push',
    name: 'Parallax push',
    fragment: 'slow push in, layered parallax',
  },
]

export function presetsForStage(stage: StageKind): readonly Preset[] {
  return stage === 'animate' ? MOTION_PRESETS : STYLE_PRESETS
}

export function presetById(id: string | null): Preset | null {
  if (id === null) return null
  return [...STYLE_PRESETS, ...MOTION_PRESETS].find(p => p.id === id) ?? null
}

// ── The seeded projects ─────────────────────────────────────────────────────

function recipe(
  partial: Partial<StageRecipe> & Pick<StageRecipe, 'modelId'>
): StageRecipe {
  return {
    prompt: '',
    presetId: null,
    seed: { mode: 'roll' },
    params: {},
    options: {},
    inputGenerationId: null,
    ...partial,
  }
}

function generation(
  id: string,
  stage: StageKind,
  ordinal: number,
  seed: number | null,
  minutes: number,
  stageRecipe: StageRecipe,
  verdict: Generation['verdict'] = 'unrated'
): Generation {
  return {
    id,
    stage,
    ordinal,
    seed,
    verdict,
    createdAt: T0 + minutes * MINUTE,
    recipe: stageRecipe,
    // No file behind a fixture — which is also the state of a real generation
    // whose stage has no model call yet, so nothing special-cases it.
    asset: null,
  }
}

const ATLAS_SUBJECT =
  'a single translucent glass monolith on a dark wet plane, one hard rim light, empty space to the right'

const atlasSource = recipe({
  modelId: 'fal-ai/flux-pro/kontext/text-to-image',
  prompt: ATLAS_SUBJECT,
})

/**
 * The populated project. Its history is arranged to put every awkward case on
 * screen at once: a rejected candidate that is still there, a style candidate
 * made from a source that is no longer selected, and two style candidates that
 * share a pinned seed and differ by exactly one fragment.
 */
export const ATLAS: Project = {
  id: 'project-atlas',
  name: 'Atlas — hero',
  aspect: '21:9',
  createdAt: T0,
  generations: [
    generation('gen-src-1', 'source', 1, 481_562_003, 0, atlasSource),
    generation(
      'gen-src-2',
      'source',
      2,
      913_774_118,
      1,
      atlasSource,
      'approved'
    ),
    generation(
      'gen-src-3',
      'source',
      3,
      220_009_641,
      2,
      atlasSource,
      'rejected'
    ),

    // Made from source 1, which is no longer what the stage is working from —
    // still perfectly valid, just no longer comparable with the others.
    generation(
      'gen-sty-1',
      'style',
      1,
      771_400_552,
      8,
      recipe({
        modelId: 'fal-ai/flux/dev/image-to-image',
        prompt: 'restyle',
        presetId: 'editorial-noir',
        params: { strength: 0.7 },
        inputGenerationId: 'gen-src-1',
      })
    ),
    // The pinned-seed pair: same seed, same source, same strength — the only
    // difference is the preset.
    generation(
      'gen-sty-2',
      'style',
      2,
      640_213_889,
      14,
      recipe({
        modelId: 'fal-ai/flux/dev/image-to-image',
        prompt: 'restyle',
        presetId: 'editorial-noir',
        seed: { mode: 'pinned', value: 640_213_889 },
        params: { strength: 0.7 },
        inputGenerationId: 'gen-src-2',
      }),
      'approved'
    ),
    generation(
      'gen-sty-3',
      'style',
      3,
      640_213_889,
      16,
      recipe({
        modelId: 'fal-ai/flux/dev/image-to-image',
        prompt: 'restyle',
        presetId: 'sun-bleached-film',
        seed: { mode: 'pinned', value: 640_213_889 },
        params: { strength: 0.7 },
        inputGenerationId: 'gen-src-2',
      })
    ),

    generation(
      'gen-ani-1',
      'animate',
      1,
      null,
      22,
      recipe({
        modelId: 'fal-ai/kling-video/o1/image-to-video',
        prompt: 'motion',
        presetId: 'slow-drift',
        params: { duration: '5' },
        options: { rewind: false, loop: true },
        inputGenerationId: 'gen-sty-2',
      })
    ),
  ],
  selection: {
    source: 'gen-src-2',
    style: 'gen-sty-2',
    animate: 'gen-ani-1',
  },
  drafts: {
    source: atlasSource,
    style: recipe({
      modelId: 'fal-ai/flux/dev/image-to-image',
      prompt: 'restyle',
      presetId: 'sun-bleached-film',
      seed: { mode: 'pinned', value: 640_213_889 },
      params: { strength: 0.7 },
    }),
    animate: recipe({
      modelId: 'fal-ai/kling-video/o1/image-to-video',
      prompt: 'motion',
      presetId: 'slow-drift',
      params: { duration: '5' },
      options: { rewind: false, loop: true },
    }),
  },
}

const LEDGER_SUBJECT =
  'a stack of matte paper cards fanned across raw concrete, low sun'

const ledgerSource = recipe({
  modelId: 'fal-ai/flux-pro/v1.1',
  prompt: LEDGER_SUBJECT,
})

/** A second project, barely started — the editor has to look sane empty too. */
export const LEDGER: Project = {
  id: 'project-ledger',
  name: 'Ledger — hero',
  aspect: '16:9',
  createdAt: T0 + 40 * MINUTE,
  generations: [
    generation('gen-led-1', 'source', 1, 55_120_777, 41, ledgerSource),
  ],
  selection: { source: 'gen-led-1', style: null, animate: null },
  drafts: {
    source: ledgerSource,
    style: recipe({
      modelId: 'fal-ai/flux/dev/image-to-image',
      prompt: 'restyle',
      presetId: 'clean-product-studio',
      params: { strength: 0.7 },
    }),
    animate: recipe({
      modelId: 'fal-ai/luma-dream-machine/ray-2/image-to-video',
      prompt: 'motion',
      presetId: 'gentle-pulse',
      params: { duration: '5s', resolution: '1080p' },
      options: { rewind: false, loop: true },
    }),
  },
}

/**
 * A populated editor, for tests and for nothing else.
 *
 * The app no longer starts here — #23 made projects come off disk, so the
 * running app's initial state is empty (`emptyEditorState`). What survives is
 * the value of this history as *test data*: it has a rejected candidate, a
 * candidate made from a stale input, and a pinned-seed pair, which is more
 * awkwardness than a hand-built state per test would keep hold of.
 */
export function fixtureEditorState(): EditorState {
  return {
    summaries: [summaryOf(ATLAS), summaryOf(LEDGER)],
    project: ATLAS,
    directory: `/tmp/ideo-fixture/${ATLAS.id}`,
    activeStage: 'style',
    showRejected: false,
  }
}

export function summaryOf(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    aspect: project.aspect,
    createdAt: project.createdAt,
    updatedAt: project.createdAt,
    generationCount: project.generations.length,
    directory: `/tmp/ideo-fixture/${project.id}`,
  }
}

// ── The stand-in for pixels ─────────────────────────────────────────────────

/**
 * A deterministic picture for a generation.
 *
 * Split deliberately: the **composition comes from the seed alone**, and the
 * **palette from the style fragment alone**. That is PRD §4.3's claim rendered
 * literally — pin the seed, change one fragment, and the shapes hold still
 * while the colour moves. If the claim were false, the prototype could not
 * show it either way, so this is the one place the fixture is arguing for a
 * conclusion rather than just standing in.
 */
export interface PreviewArt {
  readonly background: string
  readonly accent: string
}

export function previewArt(generation: Generation): PreviewArt {
  const composition = generation.seed ?? hash(generation.id)
  const random = mulberry32(composition)

  const palette = hash(
    `${generation.recipe.presetId ?? ''}|${generation.recipe.prompt}`
  )
  const hue = palette % 360
  const accentHue = (hue + 40) % 360

  const blobs = Array.from({ length: 3 }, (_, index) => {
    const x = Math.round(random() * 100)
    const y = Math.round(random() * 100)
    const size = 30 + Math.round(random() * 40)
    const lightness = 0.72 - index * 0.14
    return `radial-gradient(${size}% ${size}% at ${x}% ${y}%, oklch(${lightness} 0.14 ${hue}) 0%, transparent 70%)`
  })

  return {
    background: [
      ...blobs,
      `linear-gradient(${Math.round(random() * 360)}deg, oklch(0.28 0.06 ${hue}), oklch(0.16 0.04 ${accentHue}))`,
    ].join(', '),
    accent: `oklch(0.7 0.16 ${accentHue})`,
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function hash(text: string): number {
  let value = 2_166_136_261
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 16_777_619)
  }
  return value >>> 0
}
