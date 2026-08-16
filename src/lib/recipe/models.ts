/**
 * The capability registry — PRD §5's hand-maintained file, as data.
 *
 * **Every row here was read from a live fal schema on 2026-08-09** and is
 * recorded in `docs/research/model-schemas.md` (33 endpoints, all HTTP 200) or,
 * for the two provisional defaults, in PRD §9. Nothing is inferred from a model
 * card, a blog post or a name. A wrong capability produces a 422 at the one
 * step that costs money and looks like an app bug, so an unverified row is
 * worse than a missing one.
 *
 * Three things about this file that are decisions rather than transcription:
 *
 * 1. **`defaults` are ours, never the provider's** (PRD §5, §6.3). fal defaults
 *    `strength` to 0.95, which discards the input; Luma defaults `resolution`
 *    to 540p, which is not a hero. Both are overridden below.
 * 2. **Dimension bounds are tightened, never loosened.** `multipleOf` is 16
 *    everywhere, including on models declaring none, because PRD §12 caught fal
 *    snapping 1280×720 to 1280×704 and changing the locked ratio. `maxEdge` and
 *    `maxPixels` are capped at what a hero actually needs on the
 *    megapixel-billed endpoints, so a generous schema is not a surprise bill.
 * 3. **Models surveyed and left out.** `minimax/h3/image-to-video` and
 *    `fal-ai/wan-flf2v` have no duration enum (a free integer and `num_frames`
 *    respectively), and `fal-ai/pika/v2.2/pikaframes` has no duration field at
 *    all. Adding them means teaching the duration control a fourth idiom, which
 *    is its own ticket.
 *
 * Not user-extendable, by design (PRD §5). The escape hatch is a PR against
 * this file, which is exactly the review an incorrect capability needs.
 */

import {
  validateRegistry,
  type DimensionConstraints,
  type ModelCapabilities,
} from './registry'
import type { StageKind } from './types'

/** 2026-08-09 — every price and capability below was read on this date. */
const VERIFIED_ON = '2026-08-09'

// ── Dimension bounds ────────────────────────────────────────────────────────

/**
 * Qwen-Image 2: total pixels 0.26–4.19 MP, no per-edge or multiple declared.
 * The 16-multiple and the edge range are ours (see the header).
 */
const QWEN_DIMENSIONS: DimensionConstraints = {
  multipleOf: 16,
  minEdge: 256,
  maxEdge: 2560,
  minPixels: 262_144,
  maxPixels: 4_194_304,
  maxRatio: null,
}

/** FLUX 2 Pro: multiples of 16, 256–2560 per side, ≤ 4.19 MP. All declared. */
const FLUX_2_PRO_DIMENSIONS: DimensionConstraints = {
  multipleOf: 16,
  minEdge: 256,
  maxEdge: 2560,
  minPixels: 65_536,
  maxPixels: 4_194_304,
  maxRatio: null,
}

/** gpt-image-2: multiples of 16, max edge 3840, ratio ≤ 3:1, 0.66–8.29 MP. */
const GPT_IMAGE_2_DIMENSIONS: DimensionConstraints = {
  multipleOf: 16,
  minEdge: 256,
  maxEdge: 3840,
  minPixels: 660_000,
  maxPixels: 8_290_000,
  maxRatio: 3,
}

/**
 * FLUX Pro 1.1 and FLUX schnell declare nothing beyond a 14142 max edge. These
 * are billed per megapixel, so the ceiling below is ours: 4.19 MP is already
 * more than a hero needs, and the schema's would cost two orders of magnitude
 * more for pixels nobody ships.
 */
const CAPPED_DIMENSIONS: DimensionConstraints = {
  multipleOf: 16,
  minEdge: 256,
  maxEdge: 2560,
  minPixels: 65_536,
  maxPixels: 4_194_304,
  maxRatio: null,
}

// ── Ratio enums ─────────────────────────────────────────────────────────────

/**
 * FLUX Kontext, every variant: `21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16,
 * 9:21`. No 2:1, which is what rules it out of a 2:1 project.
 */
const KONTEXT_RATIOS = {
  '16:9': '16:9',
  '21:9': '21:9',
  '3:2': '3:2',
  '1:1': '1:1',
  '3:4': '3:4',
  '9:16': '9:16',
} as const

/** Nano Banana, both generations. 11 and 15 ratios respectively, no 2:1. */
const NANO_BANANA_RATIOS = {
  '16:9': '16:9',
  '21:9': '21:9',
  '3:2': '3:2',
  '1:1': '1:1',
  '3:4': '3:4',
  '9:16': '9:16',
} as const

/** Grok Imagine: widest is 2:1, and there is no 21:9 anywhere in the enum. */
const GROK_RATIOS = {
  '16:9': '16:9',
  '2:1': '2:1',
  '3:2': '3:2',
  '1:1': '1:1',
  '3:4': '3:4',
  '9:16': '9:16',
} as const

/**
 * Veo 3.1 and LTX 2.3: `auto`, `16:9`, `9:16` — no native ultrawide, but the
 * vertical is native. `auto` is not offered, per PRD §6.3: the project's ratio
 * is locked and handing the decision back to the provider is how a stage comes
 * back the wrong shape.
 */
const VEO_AND_LTX_RATIOS = { '16:9': '16:9', '9:16': '9:16' } as const

// ── Source ──────────────────────────────────────────────────────────────────

const SOURCE_MODELS: readonly ModelCapabilities[] = [
  {
    // PRD §9's provisional default. Cheap enough to develop against without
    // thinking about it; explicitly expected to be replaced after #35's
    // bake-off, since visual quality is the axis and no schema encodes it.
    id: 'fal-ai/flux/schnell',
    label: 'FLUX schnell',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: CAPPED_DIMENSIONS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    // `docs/research/models.md` — schnell's schema names a step count.
    extraParams: ['num_inference_steps'],
    // 4 is the model's own step count and the whole point of the distillation;
    // raising it buys nothing on a 4-step schedule.
    defaults: { num_inference_steps: 4 },
    price: { amount: 0.003, unit: 'megapixel', verifiedOn: VERIFIED_ON },
    // ~13× cheaper than anything else here, and 21:9 is reachable through
    // explicit dimensions — but not the quality tier of the shortlist (PRD §9).
    notes: 'Cheapest. Lowest quality tier.',
  },
  {
    // The text-to-image variant. `fal-ai/flux-pro/kontext` without the suffix
    // is image-to-image and requires an input image — it is the style-stage
    // sibling further down this file.
    id: 'fal-ai/flux-pro/kontext/text-to-image',
    label: 'FLUX Kontext Pro',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: KONTEXT_RATIOS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.04, unit: 'image', verifiedOn: VERIFIED_ON },
    notes: 'Cheaper Kontext tier.',
  },
  {
    id: 'fal-ai/flux-pro/kontext/max/text-to-image',
    label: 'FLUX Kontext Max',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: KONTEXT_RATIOS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.08, unit: 'image', verifiedOn: VERIFIED_ON },
    // Same schema as Kontext Pro, so the two differ only by tier and price.
    notes: 'Same, at double price.',
  },
  {
    // The endpoint the #22 spike ran live.
    id: 'fal-ai/flux-pro/v1.1',
    label: 'FLUX Pro 1.1',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: CAPPED_DIMENSIONS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.04, unit: 'megapixel', verifiedOn: VERIFIED_ON },
    // Billed per megapixel, rounded up, so the dimension cap is a cost decision.
    notes: 'Billed per megapixel.',
  },
  {
    id: 'fal-ai/flux-2-pro',
    label: 'FLUX 2 Pro',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: FLUX_2_PRO_DIMENSIONS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.03, unit: 'megapixel', verifiedOn: VERIFIED_ON },
    // Tiered upstream: $0.03 for the first megapixel then $0.015 each. The flat
    // rate above therefore over-estimates, which is the safe direction.
    notes: 'Per megapixel. Estimate over-states.',
  },
  {
    id: 'fal-ai/nano-banana-pro',
    label: 'Nano Banana Pro',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: NANO_BANANA_RATIOS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.15, unit: 'image', verifiedOn: VERIFIED_ON },
    // 4K is charged at double; the estimate assumes it is not used.
    notes: '4K costs double.',
  },
  {
    id: 'fal-ai/nano-banana-2',
    label: 'Nano Banana 2',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: NANO_BANANA_RATIOS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.08, unit: 'image', verifiedOn: VERIFIED_ON },
    // 2K and 4K carry 1.5× and 2× surcharges the estimate does not reflect.
    notes: 'Higher resolutions cost extra.',
  },
  {
    id: 'fal-ai/qwen-image-2/text-to-image',
    label: 'Qwen-Image 2',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'tags',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: QWEN_DIMENSIONS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: 'negative_prompt',
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: { negative_prompt: '' },
    price: { amount: 0.035, unit: 'image', verifiedOn: VERIFIED_ON },
    // PRD §9's `tags` exemplar, and one of two families surveyed with a real
    // negative prompt — which matters because all 44 v4 recipes carry one.
    notes: 'Keyword prompts. Real negatives.',
  },
  {
    id: 'fal-ai/qwen-image-2/pro/text-to-image',
    label: 'Qwen-Image 2 Pro',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'tags',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: QWEN_DIMENSIONS,
    },
    imageParam: null,
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: 'negative_prompt',
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: { negative_prompt: '' },
    price: { amount: 0.075, unit: 'image', verifiedOn: VERIFIED_ON },
    // Same schema as Qwen-Image 2, one tier up.
    notes: 'Qwen at pro tier.',
  },
  {
    id: 'openai/gpt-image-2',
    label: 'GPT Image 2',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: GPT_IMAGE_2_DIMENSIONS,
    },
    // No seed field at all, so PRD §4.3's recipe premise does not hold: the
    // control is shown disabled with a reason rather than hidden (§10.1).
    imageParam: null,
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    // Token-priced. There is no per-image number, and inventing one would
    // defeat the point of a dated estimate (PRD §10.2).
    price: null,
    // The largest output ceiling surveyed, at 8.29 MP.
    notes: 'Largest output. No seed.',
  },
  {
    id: 'xai/grok-imagine-image',
    label: 'Grok Imagine',
    provider: 'fal',
    stage: 'source',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: GROK_RATIOS,
    },
    imageParam: null,
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.02, unit: 'image', verifiedOn: VERIFIED_ON },
    // The only source model whose enum reaches 2:1 but not 21:9.
    notes: 'Cheapest per image. No seed.',
  },
]

// ── Style (image-to-image and instruction edits) ────────────────────────────

/**
 * Every `imageParam` below was read from the live input schema on 2026-08-09,
 * the same way and on the same day as everything else in this file, and the
 * eight rows do **not** agree: the FLUX family (`flux-pro/kontext`,
 * `kontext/max`, `flux/dev/image-to-image`, `flux-kontext/dev`) declares a
 * single required `image_url` string, while Qwen and Nano Banana declare an
 * `image_urls` **array**. The registry records the name; whoever builds the body
 * has to honour the shape, because a string where an array is required is a 422
 * at the one step that costs money (#28).
 */
const STYLE_MODELS: readonly ModelCapabilities[] = [
  {
    // The stage default: a real negative prompt, free dimensions, a seed, and
    // the cheapest edit endpoint surveyed. Provisional until #35 looks at
    // output side by side.
    id: 'fal-ai/qwen-image-2/edit',
    label: 'Qwen-Image 2 — edit',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'tags',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: QWEN_DIMENSIONS,
    },
    imageParam: 'image_urls',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: 'negative_prompt',
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: { negative_prompt: '' },
    price: { amount: 0.035, unit: 'image', verifiedOn: VERIFIED_ON },
    // Defaults to the input size when no dimensions are sent; we send them, so
    // the project ratio survives the restyle.
    notes: 'Keyword prompts. Real negatives.',
  },
  {
    id: 'fal-ai/qwen-image-2/pro/edit',
    label: 'Qwen-Image 2 Pro — edit',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'tags',
    aspects: {
      kind: 'freeDimensions',
      param: 'image_size',
      constraints: QWEN_DIMENSIONS,
    },
    imageParam: 'image_urls',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: 'negative_prompt',
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: { negative_prompt: '' },
    price: { amount: 0.075, unit: 'image', verifiedOn: VERIFIED_ON },
    // Same schema as the Qwen edit endpoint, one tier up.
    notes: 'Qwen edit, pro tier.',
  },
  {
    id: 'fal-ai/nano-banana-pro/edit',
    label: 'Nano Banana Pro — edit',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: NANO_BANANA_RATIOS,
    },
    imageParam: 'image_urls',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.15, unit: 'image', verifiedOn: VERIFIED_ON },
    // No negative prompt, so a preset's negative fragment has to fold into the
    // prompt body.
    notes: 'Priciest edit. No negatives.',
  },
  {
    id: 'fal-ai/nano-banana-2/edit',
    label: 'Nano Banana 2 — edit',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: NANO_BANANA_RATIOS,
    },
    imageParam: 'image_urls',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.08, unit: 'image', verifiedOn: VERIFIED_ON },
    // Cheaper than the Pro edit, with the same absent negative prompt.
    notes: 'Cheaper. No negatives.',
  },
  {
    // The image-to-image endpoint. The source-stage sibling carries a
    // `/text-to-image` suffix.
    id: 'fal-ai/flux-pro/kontext',
    label: 'FLUX Kontext Pro — edit',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: KONTEXT_RATIOS,
    },
    imageParam: 'image_url',
    supportsSeed: true,
    // PRD §9's correction: no Kontext variant has a strength parameter. Earlier
    // drafts of the registry claimed one at default 0.1.
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.04, unit: 'image', verifiedOn: VERIFIED_ON },
    notes: 'Cheaper Kontext edit.',
  },
  {
    id: 'fal-ai/flux-pro/kontext/max',
    label: 'FLUX Kontext Max — edit',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: KONTEXT_RATIOS,
    },
    imageParam: 'image_url',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.08, unit: 'image', verifiedOn: VERIFIED_ON },
    // Same schema as the Kontext Pro edit, so the two differ only by tier.
    notes: 'Same, at double price.',
  },
  {
    id: 'fal-ai/flux/dev/image-to-image',
    label: 'FLUX.1 dev — image to image',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'prose',
    aspects: { kind: 'inheritsFromSource' },
    imageParam: 'image_url',
    supportsSeed: true,
    strengthParam: 'strength',
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    // 0.7, not fal's 0.95. PRD §6.3: at 0.95 the input is discarded entirely,
    // which costs the same and produces something unrelated.
    defaults: { strength: 0.7 },
    price: { amount: 0.03, unit: 'megapixel', verifiedOn: VERIFIED_ON },
    // The only endpoint of the 33 surveyed with a strength field. The usable
    // window is said out loud by the strength control itself, not here.
    notes: 'Only one with strength.',
  },
  {
    id: 'fal-ai/flux-kontext/dev',
    label: 'FLUX Kontext dev',
    provider: 'fal',
    stage: 'style',
    promptStyle: 'prose',
    aspects: { kind: 'inheritsFromSource' },
    imageParam: 'image_url',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: null,
    durations: [],
    durationFormat: null,
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: {},
    price: { amount: 0.025, unit: 'megapixel', verifiedOn: VERIFIED_ON },
    // No size field, so the restyle keeps whatever the source produced.
    notes: 'Cheapest edit. Keeps source size.',
  },
]

// ── Animate ─────────────────────────────────────────────────────────────────

/**
 * Seedance's whole-second enum, written out rather than typed by hand.
 *
 * Twenty-seven values, and the point of the widest range in the registry is
 * that the cost lever is visible: at $0.473 a second, 30 seconds is roughly $14
 * and 4 is under $2, which is the difference the duration control exists to put
 * in front of someone before they click (PRD §10.2).
 */
const DURATIONS_4_TO_30: readonly string[] = Array.from(
  { length: 27 },
  (_, index) => String(index + 4)
)

const ANIMATE_MODELS: readonly ModelCapabilities[] = [
  {
    // PRD §9's provisional animate default. Chosen for the end frame, which is
    // what §4.5's seamless loop rests on, and because inherited geometry means
    // no ratio ceiling. Expensive, and not reproducible — see below.
    id: 'bytedance/seedance-2.5/image-to-video',
    label: 'Seedance 2.5',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: { kind: 'inheritsFromSource' },
    imageParam: 'image_url',
    // No seed. PRD §4.3's premise does not hold on this model, so the control
    // is disabled with a reason rather than hidden (§10.1).
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    endFrameRequired: false,
    durationParam: 'duration',
    // The enum as it was re-read on 2026-08-09: `auto` and every whole second
    // from 4 to 30. `auto` is deliberately not offered — it hands the length
    // back to the provider, which is both PRD §6.3's "never inherit a provider
    // default" and, at $0.473 a second, an estimate that cannot be computed
    // before the money is spent (PRD §10.2).
    durations: DURATIONS_4_TO_30,
    // Strings of integers on the wire, not integers: the schema's enum is
    // `"4"`…`"30"`, and an integer where a string enum is declared is a 422.
    durationFormat: 'string',
    resolutionParam: 'resolution',
    resolutions: ['480p', '720p'],
    // PRD §9 — the one field outside the registry's columns this model has.
    extraParams: ['generate_audio'],
    defaults: {
      duration: '5',
      resolution: '720p',
      // PRD §9 — the provider defaults this to true. A hero loop is silent and
      // the audio is billed, so it is switched off explicitly.
      generate_audio: false,
    },
    price: { amount: 0.473, unit: 'second', verifiedOn: VERIFIED_ON },
    // The most expensive animate option surveyed, and the only one that caps at
    // 720p. The `auto` duration and the upstream audio default are handled above.
    notes: 'Priciest. Caps at 720p.',
  },
  {
    id: 'fal-ai/kling-video/o1/image-to-video',
    label: 'Kling O1',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: { kind: 'inheritsFromSource' },
    // The odd one out of the three start-frame spellings, and required here.
    imageParam: 'start_image_url',
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    endFrameRequired: false,
    durationParam: 'duration',
    durations: ['3', '4', '5', '6', '7', '8', '9', '10'],
    // Live schema re-fetch 2026-08-09: strings of digits, not integers. An
    // earlier note said integer, and the wrong primitive is a 422 at the paid
    // step.
    durationFormat: 'string',
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: { duration: '5' },
    price: { amount: 0.112, unit: 'second', verifiedOn: VERIFIED_ON },
    // The cheapest end-frame model surveyed. The whole input is prompt, start
    // image, end image and duration — no aspect, resolution or seed.
    notes: 'Cheapest end-frame model.',
  },
  {
    id: 'fal-ai/kling-video/o3/pro/image-to-video',
    label: 'Kling O3 Pro',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: { kind: 'inheritsFromSource' },
    imageParam: 'image_url',
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    endFrameRequired: false,
    durationParam: 'duration',
    durations: [
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
    ],
    // Live schema re-fetch 2026-08-09: strings of digits, not integers, exactly
    // as on Kling O1.
    durationFormat: 'string',
    resolutionParam: null,
    resolutions: [],
    extraParams: [],
    defaults: { duration: '5' },
    // $0.14/s rather than $0.112/s if audio is enabled, which we never do.
    price: { amount: 0.112, unit: 'second', verifiedOn: VERIFIED_ON },
    // Kling O1's schema with a longer duration enum and the commoner
    // start-frame spelling.
    notes: 'Kling with longer clips.',
  },
  {
    id: 'fal-ai/luma-dream-machine/ray-2/image-to-video',
    label: 'Luma Ray 2',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: {
        '16:9': '16:9',
        '21:9': '21:9',
        '3:4': '3:4',
        '9:16': '9:16',
      },
    },
    imageParam: 'image_url',
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    endFrameRequired: false,
    durationParam: 'duration',
    durations: ['5s', '9s'],
    durationFormat: 'secondsSuffixed',
    resolutionParam: 'resolution',
    resolutions: ['540p', '720p', '1080p'],
    extraParams: [],
    // 1080p, not Luma's own 540p — too low for a hero, and it costs the same
    // (PRD §5).
    defaults: { duration: '5s', resolution: '1080p' },
    price: { amount: 0.1, unit: 'second', verifiedOn: VERIFIED_ON },
    // The only animate model with an explicit 21:9 enum and an end frame.
    notes: 'Native 21:9. End frame.',
  },
  {
    id: 'blackforestlabs/flux-3/first-last-frame-to-video',
    label: 'FLUX 3 — first/last frame',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: {
        '16:9': '16:9',
        '21:9': '21:9',
        '2:1': '2:1',
        '1:1': '1:1',
        '3:4': '3:4',
        '9:16': '9:16',
      },
    },
    imageParam: 'start_image_url',
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    // Required upstream, so every run of this row loops (#30): the loop switch
    // shows itself on and unclickable, and the end frame is the start still
    // sent again. It cannot serve a *non*-looping animate at all.
    endFrameRequired: true,
    durationParam: 'duration',
    durations: [
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
    ],
    durationFormat: 'integer',
    resolutionParam: 'resolution',
    resolutions: ['720p', '1080p'],
    extraParams: [],
    defaults: { duration: '5', resolution: '1080p' },
    // $0.17/s at 720p; the rate below is the 1080p we default to.
    price: { amount: 0.29, unit: 'second', verifiedOn: VERIFIED_ON },
    // The widest ratio enum of any animate model — 21:9 and 2:1 both.
    notes: 'Widest ratios. Loops only.',
  },
  {
    id: 'fal-ai/veo3.1/first-last-frame-to-video',
    label: 'Veo 3.1 — first/last frame',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: VEO_AND_LTX_RATIOS,
    },
    // Spelled `first_frame_url` here, `start_image_url` on Kling O1 and FLUX 3,
    // and `image_url` on the rest — PRD §9.1's case for the registry, twice over.
    imageParam: 'first_frame_url',
    // The only end-frame model surveyed with a seed, which makes it the only
    // one on which the animate stage is reproducible at all (PRD §9.1).
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: 'negative_prompt',
    // Spelled `last_frame_url` here and `end_image_url` on every other model.
    endFrameParam: 'last_frame_url',
    // And required, so this row loops on every run like its FLUX 3 neighbour —
    // selectable for animate since #30, with the switch locked on.
    endFrameRequired: true,
    durationParam: 'duration',
    durations: ['4s', '6s', '8s'],
    durationFormat: 'secondsSuffixed',
    resolutionParam: 'resolution',
    resolutions: ['720p', '1080p', '4k'],
    extraParams: [],
    defaults: { duration: '6s', resolution: '1080p', negative_prompt: '' },
    // $0.40/s with audio, which we never enable.
    price: { amount: 0.2, unit: 'second', verifiedOn: VERIFIED_ON },
    notes: 'Reproducible loop. No ultrawide.',
  },
  {
    id: 'fal-ai/veo3.1/image-to-video',
    label: 'Veo 3.1',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: VEO_AND_LTX_RATIOS,
    },
    imageParam: 'image_url',
    supportsSeed: true,
    strengthParam: null,
    negativePromptParam: 'negative_prompt',
    // No end frame on this variant, so looping greys out with a reason rather
    // than disappearing (PRD §10.1).
    endFrameParam: null,
    endFrameRequired: false,
    durationParam: 'duration',
    durations: ['4s', '6s', '8s'],
    durationFormat: 'secondsSuffixed',
    resolutionParam: 'resolution',
    resolutions: ['720p', '1080p', '4k'],
    extraParams: [],
    defaults: { duration: '6s', resolution: '1080p', negative_prompt: '' },
    price: { amount: 0.2, unit: 'second', verifiedOn: VERIFIED_ON },
    // The plain variant — the first/last-frame sibling is the one to pick when
    // the loop matters.
    notes: 'Veo without the loop.',
  },
  {
    id: 'fal-ai/ltx-2.3/image-to-video',
    label: 'LTX 2.3',
    provider: 'fal',
    stage: 'animate',
    promptStyle: 'prose',
    aspects: {
      kind: 'ratioEnum',
      param: 'aspect_ratio',
      values: VEO_AND_LTX_RATIOS,
    },
    imageParam: 'image_url',
    supportsSeed: false,
    strengthParam: null,
    negativePromptParam: null,
    endFrameParam: 'end_image_url',
    endFrameRequired: false,
    durationParam: 'duration',
    durations: ['6', '8', '10'],
    durationFormat: 'integer',
    resolutionParam: 'resolution',
    resolutions: ['1080p', '1440p', '2160p'],
    extraParams: [],
    defaults: { duration: '6', resolution: '1080p' },
    // $0.16/s at 1440p and $0.32/s at 2160p; the rate below is the 1080p floor.
    price: { amount: 0.08, unit: 'second', verifiedOn: VERIFIED_ON },
    // The only animate model whose floor is 1080p.
    notes: 'Cheapest. 1080p floor.',
  },
]

/**
 * The registry, checked at import.
 *
 * Validated here rather than in a test so a malformed entry is a crash on
 * launch with the entry named, not a 422 from fal after the user has typed a
 * prompt and pressed a button that charges them.
 */
export const MODEL_REGISTRY: readonly ModelCapabilities[] = validateRegistry([
  ...SOURCE_MODELS,
  ...STYLE_MODELS,
  ...ANIMATE_MODELS,
])

/**
 * What a new project starts each stage on (PRD §9, provisional).
 *
 * Named explicitly rather than taken as "the first row of the stage", so
 * reordering the file for readability cannot silently change what every new
 * project costs to run.
 */
export const DEFAULT_MODEL_IDS: Readonly<Record<StageKind, string>> = {
  source: 'fal-ai/flux/schnell',
  style: 'fal-ai/qwen-image-2/edit',
  animate: 'bytedance/seedance-2.5/image-to-video',
}
