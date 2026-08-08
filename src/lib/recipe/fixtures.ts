/**
 * THE FIXTURE SEAM — the only temporary thing in this spike (#33).
 *
 * Everything the editor would get from fal, the keychain and the disk comes
 * from here instead: the capability registry, two projects with a history, and
 * a deterministic stand-in for the pixels. No network, no keys, no files.
 *
 * Two things replace this later:
 *  - the registry becomes the committed JSON of PRD §5 (#25),
 *  - the projects come off disk (#23) and the previews become real assets.
 *
 * **Capability flags here are fixture-grade.** They follow PRD §9/§9.1 where
 * that table says something, and are plausible-but-unverified elsewhere. They
 * exist to drive the UI down each branch — a model with no seed, a model with
 * no end frame, a model the locked aspect ratio rules out — not to be copied
 * into the real registry.
 */

import type { ModelCapabilities } from './registry'
import type {
  EditorState,
  Generation,
  Project,
  StageKind,
  StageRecipe,
} from './types'

/** Fixed so a reload shows the same thing twice. */
const T0 = Date.UTC(2026, 7, 8, 9, 0, 0)
const MINUTE = 60_000

export const FIXTURE_REGISTRY: readonly ModelCapabilities[] = [
  // ── source ────────────────────────────────────────────────────────────────
  {
    id: 'fal-ai/flux-pro/kontext',
    label: 'FLUX Kontext Pro',
    provider: 'fal',
    stage: 'source',
    aspects: ['16:9', '21:9', '2:1', '3:2', '1:1'],
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    durationParam: null,
    durations: [],
    resolutionParam: null,
    resolutions: [],
    defaults: { guidance_scale: 3.5 },
    price: null,
    notes: 'PRD §9 — the only image model with a confirmed 21:9 enum.',
  },
  {
    id: 'fal-ai/flux-pro/v1.1',
    label: 'FLUX Pro 1.1',
    provider: 'fal',
    stage: 'source',
    // No 21:9 — so on a 21:9 project this one is refused at selection time,
    // which is the whole point of validating there rather than at submit.
    aspects: ['16:9', '3:2', '1:1'],
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    durationParam: null,
    durations: [],
    resolutionParam: null,
    resolutions: [],
    defaults: {},
    price: { amount: 0.04, unit: 'image', verifiedOn: '2026-08-08' },
    notes: 'PRD §12 — $0.04/image measured by balance delta. 21:9 unconfirmed.',
  },
  {
    id: 'fal-ai/nano-banana-pro',
    label: 'Nano Banana Pro',
    provider: 'fal',
    stage: 'source',
    aspects: ['16:9', '21:9', '2:1', '3:2', '1:1'],
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    durationParam: null,
    durations: [],
    resolutionParam: null,
    resolutions: [],
    defaults: {},
    price: null,
    notes: 'PRD §9 — 21:9 confirmed in an 11-ratio enum.',
  },

  // ── style ─────────────────────────────────────────────────────────────────
  {
    id: 'fal-ai/flux-1/dev/image-to-image',
    label: 'FLUX.1 dev — image to image',
    provider: 'fal',
    stage: 'style',
    aspects: 'inheritsFromSource',
    supportsSeed: true,
    strengthParam: 'strength',
    negativePromptParam: null,
    endFrameParam: null,
    durationParam: null,
    durations: [],
    resolutionParam: null,
    resolutions: [],
    // 0.7, not fal's 0.95 — at 0.95 the input is discarded entirely (PRD §6.3).
    defaults: { strength: 0.7 },
    price: { amount: 0.025, unit: 'image', verifiedOn: '2026-08-08' },
    notes: 'PRD §6.3 — usable window is narrow, roughly 0.65–0.8.',
  },
  {
    id: 'fal-ai/flux-pro/kontext/image-to-image',
    label: 'FLUX Kontext — image to image',
    provider: 'fal',
    stage: 'style',
    aspects: 'inheritsFromSource',
    supportsSeed: true,
    strengthParam: 'strength',
    negativePromptParam: null,
    endFrameParam: null,
    durationParam: null,
    durations: [],
    resolutionParam: null,
    resolutions: [],
    defaults: { strength: 0.7 },
    price: null,
    notes:
      'Same field name as FLUX.1 dev, API default 0.1 rather than 0.95 — PRD §5.',
  },
  {
    id: 'fal-ai/qwen-image-2.0/edit',
    label: 'Qwen-Image 2.0 — edit',
    provider: 'fal',
    stage: 'style',
    aspects: 'inheritsFromSource',
    supportsSeed: true,
    strengthParam: null,
    // The one model in the shortlist with a real negative prompt (PRD §9), so
    // the field appears here and nowhere else.
    negativePromptParam: 'negative_prompt',
    endFrameParam: null,
    durationParam: null,
    durations: [],
    resolutionParam: null,
    resolutions: [],
    defaults: { negative_prompt: '' },
    price: null,
    notes: 'PRD §9 — the `tags` exemplar; justifies the two-variant presets.',
  },

  // ── animate ───────────────────────────────────────────────────────────────
  {
    id: 'fal-ai/luma-dream-machine/ray-2',
    label: 'Luma Ray 2',
    provider: 'fal',
    stage: 'animate',
    aspects: ['16:9', '21:9', '2:1', '3:2', '1:1'],
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    durationParam: 'duration',
    durations: ['5s', '9s'],
    resolutionParam: 'resolution',
    resolutions: ['540p', '720p', '1080p'],
    // 1080p because Luma's own default is 540p — too low for a hero (PRD §5).
    defaults: { duration: '5s', resolution: '1080p' },
    price: null,
    notes: 'PRD §9.1 — explicit 21:9/9:21 enum. Seed support unverified.',
  },
  {
    id: 'fal-ai/kling-video/o1',
    label: 'Kling O1',
    provider: 'fal',
    stage: 'animate',
    aspects: 'inheritsFromSource',
    // No seed field at all — PRD §9.1 is explicit that Kling video is not
    // reproducible. This is the model the disabled-with-a-reason rule is
    // checked against.
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    durationParam: 'duration',
    durations: ['3', '4', '5', '6', '7', '8', '9', '10'],
    resolutionParam: null,
    resolutions: [],
    defaults: { duration: '5' },
    price: null,
    notes:
      'PRD §9.1 — duration is a bare string, and there is no seed, aspect or resolution parameter.',
  },
  {
    id: 'fal-ai/veo3.1/image-to-video',
    label: 'Veo 3.1',
    provider: 'fal',
    stage: 'animate',
    // 16:9 only — ruled out by a 21:9 project before it can be picked.
    aspects: ['16:9'],
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'last_frame_url',
    durationParam: 'duration',
    durations: ['4s', '6s', '8s'],
    resolutionParam: null,
    resolutions: [],
    defaults: { duration: '6s' },
    price: null,
    notes:
      'PRD §9.1 — end frame is `last_frame_url` here and `end_image_url` everywhere else.',
  },
  {
    id: 'fal-ai/ltx-video/image-to-video',
    label: 'LTX Video',
    provider: 'fal',
    stage: 'animate',
    aspects: 'inheritsFromSource',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    // No end frame — looping has nothing to hang on, so the control greys out
    // with a reason instead of vanishing.
    endFrameParam: null,
    durationParam: 'duration',
    durations: ['5s'],
    resolutionParam: null,
    resolutions: [],
    defaults: { duration: '5s' },
    price: null,
    notes:
      'Fixture-grade: stands in for a video model with no end-frame field.',
  },
]

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
  }
}

const ATLAS_SUBJECT =
  'a single translucent glass monolith on a dark wet plane, one hard rim light, empty space to the right'

const atlasSource = recipe({
  modelId: 'fal-ai/flux-pro/kontext',
  prompt: ATLAS_SUBJECT,
  params: { guidance_scale: 3.5 },
})

/**
 * The populated project. Its history is arranged to put every awkward case on
 * screen at once: a rejected candidate that is still there, a style candidate
 * made from a source that is no longer selected, and two style candidates that
 * share a pinned seed and differ by exactly one fragment.
 */
const ATLAS: Project = {
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
        modelId: 'fal-ai/flux-1/dev/image-to-image',
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
        modelId: 'fal-ai/flux-1/dev/image-to-image',
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
        modelId: 'fal-ai/flux-1/dev/image-to-image',
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
        modelId: 'fal-ai/kling-video/o1',
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
      modelId: 'fal-ai/flux-1/dev/image-to-image',
      prompt: 'restyle',
      presetId: 'sun-bleached-film',
      seed: { mode: 'pinned', value: 640_213_889 },
      params: { strength: 0.7 },
    }),
    animate: recipe({
      modelId: 'fal-ai/kling-video/o1',
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
const LEDGER: Project = {
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
      modelId: 'fal-ai/flux-1/dev/image-to-image',
      prompt: 'restyle',
      presetId: 'clean-product-studio',
      params: { strength: 0.7 },
    }),
    animate: recipe({
      modelId: 'fal-ai/luma-dream-machine/ray-2',
      prompt: 'motion',
      presetId: 'gentle-pulse',
      params: { duration: '5s', resolution: '1080p' },
      options: { rewind: false, loop: true },
    }),
  },
}

export function initialEditorState(): EditorState {
  return {
    projects: [ATLAS, LEDGER],
    activeProjectId: ATLAS.id,
    activeStage: 'style',
    showRejected: false,
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
