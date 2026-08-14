/**
 * The composing preset libraries — PRD §6's version-controlled JSON, and the one
 * function that turns a preset into a prompt.
 *
 * **Two libraries, one type, one loader** (#47). A source preset is a whole
 * scene and a style preset is a transform applied to a composition somebody else
 * already made, which is a real difference — but it is a difference in *data*,
 * not in shape. Both carry per-idiom variants, a compose template, a negative
 * and a strength, and both assemble a prompt around one block their library
 * holds once: style has a **preserve** block, source has an **append** block.
 * Two readers for that would be two places to forget the same fix. Motion keeps
 * its own type in `motion.ts`, because it genuinely needs *less* — one whole
 * prompt, nothing to assemble.
 *
 * A preset is a **seed, not a filter** (#28): selecting one pre-fills an
 * editable prompt box, and what is in the box is exactly what is sent. So the
 * composed string has to be readable by the person about to spend money on it,
 * and everything that decides how it is assembled has to be visible in the data
 * rather than buried in whoever calls this.
 *
 * Three shape decisions, all from `docs/research/preset-schema.md`:
 *
 * 1. **Keyed by prompt idiom, not by model** (PRD §6.1). The registry's
 *    `promptStyle` picks the variant, so adding a model is a registry change and
 *    never a walk through every preset.
 * 2. **Explicit `null` beats a missing key** (§2). A variant that is `null` says
 *    "this preset has nothing to say in that idiom"; a variant that is *absent*
 *    says nobody has looked at it yet, and the loader refuses it. Same for a
 *    variant's `negative` and `strength`.
 * 3. **The compose template lives in the preset** (§2, PRD §6.1). Ordering is
 *    per-look — a strong art direction may need to lead rather than follow the
 *    preserve block — so a rule in code would be the wrong place for it.
 *
 * A variant may also have **holes in it** (#46): `{{primary}}`, `{{subject}}`.
 * Those resolve at *seed* time, against the project's palette and whatever the
 * user typed into the picker's fields, and only the expanded prose is ever
 * persisted — a recipe that resolves against a mutable library at read time is
 * not a recipe. Which variables a variant has is **derived from its template**
 * rather than declared beside it: the two cannot then disagree, and a fork
 * whose prompt still contains a literal `{{` stays readable instead of failing
 * the loader over legal prose. What *is* declared is `defaults`, the authored
 * per-variable fallback.
 *
 * Two things this module deliberately does *not* do. It never concatenates a
 * negative into the prompt: that was settled on 2026-08-09 (PRD §9), because
 * "no gradients" inside a positive prompt reads as a request for gradients. And
 * it never invents a strength — the number comes from the model's registry
 * entry unless the preset overrode it, and an override is clamped to the window
 * §6.3 actually measured.
 *
 * **The two idioms do not carry the same constraints, and that is correct**
 * (#48). The library is authored as prose first, and prose can be sequenced and
 * conditional: `rs-cinestill` says halation blooms only around light sources
 * bright enough to exceed the film's latitude, never as a uniform glow and never
 * on midtones. Comma-separation destroys that — a tag list has no word for
 * "only". So the tags variant states the positive plainly and pushes the
 * excluded readings into `negative`, and the same look ends up expressed
 * differently in the two idioms.
 *
 * That is a translation rather than a loss, because of an alignment worth
 * writing down: **`promptStyle: 'tags'` and a non-null `negativePromptParam`
 * are the same four models.** Every tags-idiom model in the registry has a real
 * negative-prompt field and no prose-idiom model does, so a constraint that
 * migrates out of the positive lands in a field that exists on precisely the
 * models that read the variant it migrated in. The reduction and print families
 * depend on it — "gradients, midtones, third colour", "more than two inks" is
 * how those palettes are held down, and tags is the only idiom where those
 * clauses ever reach a model at all.
 *
 * Every preset carries a `negative` on **both** variants regardless. On prose it
 * is dropped every time today, by `composePreset`, per-model. The text is still
 * true, and the alternative is writing `null` — whose documented meaning is
 * "this look has nothing to subtract" — into forty-four places where it would be
 * a lie.
 *
 * Validated at module load like the registry (`validateRegistry`), and for the
 * same reason: committed JSON with a typo in it should be a startup crash, not
 * a prompt that quietly says less than it meant to.
 */

import { ASPECTS } from './aspects'
import { asRecord, isRecord } from './json'
import {
  colourNameOf,
  namesPaletteSlot,
  paletteEntryFor,
  type Palette,
} from './palette'
import LIBRARY_DOCUMENT from './presets.json'
import type { ModelCapabilities, PromptStyle } from './registry'
import SOURCE_LIBRARY_DOCUMENT from './source-presets.json'
import type { AspectId } from './types'

/** Bumped when a library written today would be misread by an older build. */
export const PRESET_LIBRARY_VERSION = 1

/**
 * The usable strength range, measured on `fal-ai/flux/dev/image-to-image`
 * (PRD §6.3): below it nothing happens, above it the composition drifts, and at
 * fal's own default of 0.95 the input is discarded entirely.
 *
 * A preset may express an opinion inside this window and nowhere else — the
 * library is data a user can fork, and a fork is not permission to spend money
 * on a restyle that returns an unrelated image.
 */
export const PRESET_STRENGTH_WINDOW = { min: 0.65, max: 0.8 } as const

/** Every idiom a variant map has to answer for. */
const PROMPT_STYLES: readonly PromptStyle[] = ['prose', 'tags']

/**
 * The zones a scene can leave clear for headline type.
 *
 * A closed list for the same reason the aspect hint is held to `ASPECTS`: this
 * is displayed next to a layout decision, and a zone nobody has a word for
 * describes a region of the frame the reader cannot find. `none` is a real
 * answer — several recipes are dense edge to edge and the type goes outside the
 * image — and is why the list has one more entry than it looks like it needs.
 *
 * camelCase rather than the kebab the v4 drafts used, because each value is
 * interpolated straight into a translation key and `i18n-patterns.md` asks for
 * camelCase on a multi-word segment. The alternative was a lookup table whose
 * whole job would be spelling these eight words a second time.
 */
export const HEADLINE_ZONES = [
  'bottomLeft',
  'upperLeft',
  'leftThird',
  'rightThird',
  'lowerThirdFull',
  'upperThirdFull',
  'center',
  'none',
] as const

export type HeadlineZone = (typeof HEADLINE_ZONES)[number]

/**
 * One preset in one prompt idiom.
 *
 * `transform` and `compose` are separate because only the second is a template:
 * the transform is the look, and the template says where it goes relative to the
 * block its library holds. In the JSON its placeholders are `{preserve}`,
 * `{append}` and `{transform}`; the loader substitutes the library's blocks
 * once, so a loaded variant is **self-contained** and `composePreset` needs
 * nothing but the preset and the model. That is also what makes a forked user
 * preset stable: it carries the wording it was saved with rather than tracking
 * ours.
 */
export interface PresetVariant {
  /** The look itself, in this idiom. */
  readonly transform: string
  /** How the prompt is assembled, with `{preserve}` already resolved. */
  readonly compose: string
  /**
   * Routed via `negativePromptParam` and dropped where that is null — never
   * folded into the prompt (PRD §9). `null` means this look has nothing to
   * subtract, which is a real answer and not missing data.
   */
  readonly negative: string | null
  /** An opinion about strength, or `null` to take the model's default. */
  readonly strength: number | null
  /**
   * What each `{{…}}` in the template falls back to, keyed by variable (#46).
   *
   * Only a fallback. A variable naming a palette slot takes its colour from the
   * project and never from here, so this is what the *free text* holes are for
   * — `{{subject}}` on a scene that reads well with a particular object in it —
   * and what a colour hole the palette cannot fill drops to.
   *
   * Absent in the JSON is allowed where a variant's `negative` and `strength`
   * must say `null` out loud. The absent-versus-null rule is about an idiom
   * being *unanswered*; a variant with no defaults block has answered fully, and
   * writing `"defaults": {}` on forty recipes would be ceremony rather than
   * information.
   */
  readonly defaults: Readonly<Record<string, string>>
}

/**
 * One look or one scene, in every idiom it has an opinion about.
 *
 * `name` is user data — presets are forkable (PRD §6), so the name a user gave
 * theirs is the name it has. No `t()` anywhere near it.
 */
export interface Preset {
  readonly id: string
  readonly name: string
  /**
   * The grouping the drafts use (`glass`, `product`, …). Free-form.
   *
   * Load-bearing rather than decorative since #48: the picker groups by it, and
   * a 28-entry flat list is what family exists to prevent.
   */
  readonly family: string
  /**
   * One line on what this look is for, or `null` where nobody wrote one.
   *
   * `null` is the fork's answer and not a gap in the built-ins — a fork is the
   * form someone had on screen, and inventing a blurb for it would be writing a
   * sales line for a prompt we have never seen. Every built-in carries one; a
   * test holds the libraries to that rather than the loader, because the rule is
   * about *our* material and not about the shape of a preset.
   *
   * Display-only, and user data wherever it came from — no `t()` near it.
   */
  readonly blurb: string | null
  /**
   * Where this scene leaves room for headline type, or `null`.
   *
   * A note for the person laying out the page, never a crop or a constraint on
   * the model: headline type belongs in HTML (PRD §6, and the source library's
   * whole append block), so this says where the HTML has room and stops.
   */
  readonly headlineZone: HeadlineZone | null
  /**
   * What still has to happen to this image outside the model, or `null`.
   *
   * Inert text. The four recipes that carry one — two scenes and the two looks
   * that mirror them — reduce to a flat two-ink image that is authored to be
   * dithered afterwards, and #36 is the ticket that will do the dithering — so
   * until it lands this is displayed as an unfinished step rather than quietly
   * dropped, because a two-colour reduction that was never dithered looks like a
   * preset that came out wrong.
   */
  readonly note: string | null
  /**
   * The ratio this scene was composed for, or `null` where it says nothing.
   *
   * A **hint and never a setter** (#47): PRD §4.4 locks aspect at project
   * creation and never edits it, so this is displayed and nothing more. It does
   * not filter, sort or dim the picker either — every ratio the source library
   * uses is already offered, so dimming the mismatches would hide most of the
   * library on a wide project, and a strong filter dressed as a hint is worse
   * than no hint at all.
   */
  readonly aspect: AspectId | null
  readonly variants: Readonly<Record<PromptStyle, PresetVariant | null>>
}

/** One library-level block, per idiom, explicitly null where there is none. */
export type PresetBlock = Readonly<Record<PromptStyle, string | null>>

/**
 * A whole library: presets plus the one block they share.
 *
 * A block lives at library level rather than on every preset because it is the
 * same clause twenty times over. Which block a library declares is the whole
 * difference between the two composing libraries:
 *
 * - **`preserve`** — the clause that separates a restyle from a reroll. Style's,
 *   because only a transform applied to somebody else's composition has a
 *   composition to preserve.
 * - **`append`** — no text, no lettering, no logos, no watermarks. Source's,
 *   because headline type belongs in HTML where it is selectable, translatable
 *   and editable without paying to regenerate.
 *
 * Both are optional, and a library may declare neither: a preset that wants
 * nothing shared is a preset whose compose template is entirely its own. That is
 * also the opt-out — a preset leaves the placeholder out of its template and
 * does not receive the block, which is how the one text-permitting source recipe
 * keeps its lettering and how a stricter preserve clause is inlined by the one
 * style recipe that wants it, with no second mechanism for either.
 */
export interface PresetLibrary {
  readonly version: number
  readonly preserve: PresetBlock | null
  readonly append: PresetBlock | null
  readonly presets: readonly Preset[]
}

/** What a preset seeds a form with. */
export interface ComposedPreset {
  /** The whole prompt, ready to pre-fill an editable box. */
  readonly prompt: string
  /** Separate, always — see the module note. `null` means send nothing. */
  readonly negative: string | null
  /** `null` on the models with no strength field, which is most of them. */
  readonly strength: number | null
  /**
   * The holes this prompt has, resolved as far as anything can resolve them —
   * one field each in the picker, in order of first appearance (#46).
   *
   * Returned alongside the prompt rather than from a second call, because they
   * are two views of one answer: the prompt is these values substituted in, and
   * a picker that asked for them separately could render fields that disagree
   * with the box above them.
   */
  readonly variables: readonly PresetVariable[]
}

/** One `{{…}}` hole, and what it is filled with right now. */
export interface PresetVariable {
  readonly key: string
  /**
   * Whether the key addresses the palette at all — a role, or an `extraN` slot.
   *
   * True even where the slot is empty, because that is the case the field has
   * to explain: `extra3` of a two-extra palette is a colour this project does
   * not have, not a piece of free text nobody has typed yet.
   */
  readonly fromPalette: boolean
  /** What it resolves to. Empty means unresolved — the literal stays visible. */
  readonly value: string
}

/** Whatever the user typed into the picker's fields, keyed by variable. */
export type PresetVariableValues = Readonly<Record<string, string>>

/** No fields filled in — the state a freshly picked preset is seeded from. */
export const NO_VARIABLE_VALUES: PresetVariableValues = {}

/**
 * A library from an untrusted document, or a throw naming what was wrong.
 *
 * Exported because the built-ins are not the only source: #28's fork flow reads
 * user presets out of app data, and those are a file someone hand-edited by
 * definition.
 */
export function readPresetLibrary(document: unknown): PresetLibrary {
  const record = asRecord(document, 'preset library')

  const version = record.version
  if (version !== PRESET_LIBRARY_VERSION) {
    throw new Error(
      `Preset library version ${String(version)} is not version ${PRESET_LIBRARY_VERSION}`
    )
  }

  const blocks: LibraryBlocks = {
    preserve: readBlock(record, 'preserve'),
    append: readBlock(record, 'append'),
  }

  const documents = record.presets
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('Preset library lists no presets')
  }

  const seen = new Set<string>()
  const presets = documents.map(entry => {
    const preset = readPreset(entry, blocks)
    if (seen.has(preset.id)) {
      throw new Error(`Preset "${preset.id}" is declared twice`)
    }
    seen.add(preset.id)
    return preset
  })

  return { version, ...blocks, presets }
}

/** Whatever a library shares with its presets — either block, or neither. */
type LibraryBlocks = Pick<PresetLibrary, 'preserve' | 'append'>

/**
 * One library-level block per idiom, or `null` where the library has no such
 * block at all.
 *
 * `preset-schema.md` §2's absent-versus-null rule applies *inside* a block and
 * not to the block itself. Within one, an idiom that is silent has to say so
 * with an explicit `null`, because there an omission really would mean nobody
 * had looked. The block as a whole is a different question — "does this library
 * share a clause of this kind at all?" — and `null` and absent are the same
 * answer to it: source shares no preserve block because there is no composition
 * to preserve, and writing that down either way is the author's choice rather
 * than a mistake to crash on.
 */
function readBlock(
  record: Record<string, unknown>,
  kind: 'preserve' | 'append'
): PresetBlock | null {
  if (!(kind in record) || record[kind] === null) return null

  const document = asRecord(record[kind], `preset library ${kind} blocks`)
  const blocks: Partial<Record<PromptStyle, string | null>> = {}

  for (const style of PROMPT_STYLES) {
    if (!(style in document)) {
      throw new Error(
        `Preset library has no ${style} ${kind} block — state null rather than omitting it`
      )
    }
    const text = document[style]
    if (text === null) {
      blocks[style] = null
      continue
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`Preset library has an empty ${style} ${kind} block`)
    }
    blocks[style] = text
  }

  return blocks as PresetBlock
}

function readPreset(document: unknown, blocks: LibraryBlocks): Preset {
  const record = asRecord(document, 'preset')
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') throw new Error('A preset has no id')

  const fail = (problem: string): never => {
    throw new Error(`Preset "${id}": ${problem}`)
  }

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') fail('has no name')

  const family = typeof record.family === 'string' ? record.family.trim() : ''
  if (family === '') fail('has no family')

  const aspect = readAspect(record.aspect, fail)
  const blurb = readNote(record.blurb, 'blurb', fail)
  const headlineZone = readHeadlineZone(record.headlineZone, fail)
  const note = readNote(record.note, 'note', fail)

  const variants = readVariants(record.variants, blocks, fail)
  if (PROMPT_STYLES.every(style => variants[style] === null)) {
    fail('supports no prompt idiom, so no model could ever use it')
  }

  return { id, name, family, aspect, blurb, headlineZone, note, variants }
}

/**
 * A line of display-only prose, or `null` where there is none.
 *
 * Absent and `null` mean the same thing here, and the absent-versus-null rule
 * does not apply: these are notes *about* a preset rather than answers a preset
 * owes per idiom, and a fork legitimately has none of them. What is refused is
 * the empty string, which is a field somebody started and left — it renders as a
 * blank line where a sentence should be, which reads as a bug rather than as
 * silence.
 */
function readNote(
  document: unknown,
  kind: 'blurb' | 'note',
  fail: (problem: string) => never
): string | null {
  if (document === undefined || document === null) return null
  if (typeof document !== 'string' || document.trim() === '') {
    fail(`has an empty ${kind}`)
  }
  return document.trim()
}

/** The headline hint, held to the zones the layout has words for, or `null`. */
function readHeadlineZone(
  document: unknown,
  fail: (problem: string) => never
): HeadlineZone | null {
  if (document === undefined || document === null) return null
  if (
    typeof document !== 'string' ||
    !HEADLINE_ZONES.some(zone => zone === document)
  ) {
    fail(`has a headline zone we have no word for: ${String(document)}`)
  }
  return document as HeadlineZone
}

/**
 * The aspect hint, held to the curated list, or `null` where there is none.
 *
 * Absent is allowed here where it is refused on a variant, and the difference is
 * that this is not an idiom: a style preset restyles whatever it is given and
 * has no ratio to have an opinion about, so writing `"aspect": null` on all
 * twenty of them would be ceremony rather than information. A ratio that is
 * *stated* is checked against `ASPECTS`, because a hint the aspect picker has
 * never heard of would render as a ratio the project cannot be.
 */
function readAspect(
  document: unknown,
  fail: (problem: string) => never
): AspectId | null {
  if (document === undefined || document === null) return null
  if (
    typeof document !== 'string' ||
    !ASPECTS.some(aspect => aspect.id === document)
  ) {
    fail(`has an aspect hint that is not a ratio we offer: ${String(document)}`)
  }
  return document as AspectId
}

function readVariants(
  document: unknown,
  blocks: LibraryBlocks,
  fail: (problem: string) => never
): Preset['variants'] {
  if (!isRecord(document)) fail('has no variants')
  const variants: Partial<Record<PromptStyle, PresetVariant | null>> = {}

  for (const style of PROMPT_STYLES) {
    // `preset-schema.md` §2 — the distinction the whole schema rests on: null
    // is "not supported in this idiom", absent is "nobody wrote it down".
    if (!(style in document)) {
      fail(`has no ${style} variant — state null rather than omitting it`)
    }
    const entry = document[style]
    variants[style] =
      entry === null ? null : readVariant(style, entry, blocks, fail)
  }

  return variants as Preset['variants']
}

function readVariant(
  style: PromptStyle,
  document: unknown,
  blocks: LibraryBlocks,
  fail: (problem: string) => never
): PresetVariant {
  if (!isRecord(document)) fail(`has a ${style} variant that is not a variant`)

  const transform =
    typeof document.transform === 'string' ? document.transform.trim() : ''
  if (transform === '') fail(`has a ${style} variant with no transform`)

  const compose =
    typeof document.compose === 'string' ? document.compose.trim() : ''
  if (compose === '') fail(`has a ${style} variant with no compose template`)
  if (!compose.includes(TRANSFORM_SLOT)) {
    fail(`has a ${style} compose template that never places ${TRANSFORM_SLOT}`)
  }

  const preserveBlock = blocks.preserve?.[style] ?? null
  const appendBlock = blocks.append?.[style] ?? null
  for (const [slot, block] of [
    [PRESERVE_SLOT, preserveBlock],
    [APPEND_SLOT, appendBlock],
  ] as const) {
    if (compose.includes(slot) && block === null) {
      fail(
        `has a ${style} compose template asking for ${slot}, which this library has none of`
      )
    }
  }

  if (!('negative' in document)) {
    fail(
      `has a ${style} variant with no negative — state null rather than omitting it`
    )
  }
  const negative = document.negative
  if (negative !== null && (typeof negative !== 'string' || negative === '')) {
    fail(`has a ${style} variant with an empty negative`)
  }

  if (!('strength' in document)) {
    fail(
      `has a ${style} variant with no strength — state null rather than omitting it`
    )
  }
  const strength = document.strength
  if (
    strength !== null &&
    (typeof strength !== 'number' || !(strength > 0) || strength > 1)
  ) {
    fail(`has a ${style} variant with a strength outside 0–1`)
  }

  const variant: PresetVariant = {
    transform,
    compose: compose
      .replaceAll(PRESERVE_SLOT, preserveBlock ?? '')
      .replaceAll(APPEND_SLOT, appendBlock ?? ''),
    negative,
    strength,
    defaults: readDefaults(document.defaults, style, fail),
  }

  // A default for a hole the template does not have is a typo, and a silent one
  // — the value never appears anywhere, so the recipe reads as if the author
  // simply forgot to write it (#46).
  const holes = new Set(variantHoles(variant))
  for (const key of Object.keys(variant.defaults)) {
    if (!holes.has(key)) {
      fail(
        `has a ${style} default for {{${key}}}, which its template never uses`
      )
    }
  }

  return variant
}

/** The authored per-variable fallbacks, or none at all. */
function readDefaults(
  document: unknown,
  style: PromptStyle,
  fail: (problem: string) => never
): Readonly<Record<string, string>> {
  if (document === undefined || document === null) return {}
  if (!isRecord(document)) fail(`has ${style} defaults that are not a mapping`)

  const defaults: Record<string, string> = {}
  for (const [key, value] of Object.entries(document)) {
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`has an empty ${style} default for {{${key}}}`)
    }
    defaults[key] = value.trim()
  }

  return defaults
}

const PRESERVE_SLOT = '{preserve}'
const APPEND_SLOT = '{append}'
const TRANSFORM_SLOT = '{transform}'

/**
 * A hole in a prompt: `{{subject}}`, `{{primary}}`.
 *
 * Two braces rather than the one the library-level slots use, and the
 * difference is deliberate — `{preserve}` is substituted once at *load* and is
 * never seen outside this module, while `{{…}}` survives into the prompt box,
 * where the user may edit it, leave it, or type one of their own.
 */
const VARIABLE = /\{\{([A-Za-z0-9_]+)\}\}/g

/** One variant's whole prompt — the template with the look dropped into it. */
function variantPrompt(variant: PresetVariant): string {
  return variant.compose.replaceAll(TRANSFORM_SLOT, variant.transform).trim()
}

/**
 * Every `{{…}}` in some text, deduped, in order of first appearance.
 *
 * One function for two readings of the same question, because they are the same
 * scan. Over a *template* it lists the holes a variant has, which is what the
 * picker renders a field for. Over the *form* it lists the holes still unfilled,
 * which is what the run button warns on — and by that point the box is the only
 * authority, since the text may have been edited, seeded from a preset since
 * deleted, or typed from scratch with a `{{` in it.
 *
 * Warning rather than blocking is settled (#46): `{{` is legal prose in an
 * editable box, so a hard block would be wrong, but silence is wrong too,
 * because this is a paid click.
 */
export function unresolvedVariables(text: string): readonly string[] {
  const keys = [...text.matchAll(VARIABLE)].flatMap(match =>
    match[1] === undefined ? [] : [match[1]]
  )
  return [...new Set(keys)]
}

/**
 * What each hole in this variant resolves to, in order of first appearance.
 *
 * The order of precedence, and every step of it is a settled rule:
 *
 * 1. **What the user typed.** The fields are editable, and an edited field that
 *    lost to a palette entry would be a control that does nothing.
 * 2. **The palette**, where the key names a role or a filled `extraN` slot. The
 *    value is the colour's *name* — no hex ever reaches a prompt.
 * 3. **The variant's authored default**, which is where `{{subject}}` gets a
 *    concrete object and where a colour hole the palette cannot fill lands.
 * 4. **Nothing**, which leaves the `{{…}}` literal visible in the box.
 */
function resolveVariables(
  variant: PresetVariant,
  palette: Palette,
  values: PresetVariableValues
): readonly PresetVariable[] {
  return variantHoles(variant).map(key => {
    const entry = paletteEntryFor(palette, key)
    const authored = variant.defaults[key] ?? ''

    // A field the user has touched wins outright, *including* when they have
    // emptied it. Falling back to the palette there would refill a field the
    // moment it was cleared, which is a control fighting the person using it —
    // and would leave the field and the prompt box saying different things.
    const typed = values[key]

    return {
      key,
      fromPalette: namesPaletteSlot(key),
      value:
        typed !== undefined
          ? typed.trim()
          : entry !== null
            ? colourNameOf(entry)
            : authored,
    }
  })
}

/**
 * Every hole in a variant — the prompt's and the negative's.
 *
 * The negative is in here because it goes on the wire too: a `{{…}}` left in one
 * is a hole in something a model is paid to read, and a field the picker never
 * offered is a hole nobody could have filled.
 */
function variantHoles(variant: PresetVariant): readonly string[] {
  return unresolvedVariables(
    `${variantPrompt(variant)} ${variant.negative ?? ''}`
  )
}

/** The template with every resolved hole filled, and the rest left visible. */
function expandVariables(
  text: string,
  variables: readonly PresetVariable[]
): string {
  const resolved = new Map(
    variables
      .filter(variable => variable.value !== '')
      .map(variable => [variable.key, variable.value])
  )

  return text.replace(
    VARIABLE,
    (literal, key: string) =>
      // The literal, deliberately: an unresolved hole is more use on screen than
      // an empty gap, which would read as a sentence the preset simply forgot to
      // finish.
      resolved.get(key) ?? literal
  )
}

/**
 * What selecting this preset should put in the form, or `null` when the model's
 * idiom is one this preset does not speak.
 *
 * `null` rather than a fallback into the other idiom: a tag list sent to a
 * prose-trained encoder reads as malformed English (PRD §6.2), so the honest
 * answer is that there is nothing to seed and the caller keeps the user's text
 * and offers a re-seed (#28's settled model-switch rule).
 *
 * The model is the second argument rather than a bare `promptStyle` because
 * every remaining answer is also the registry's: whether the model has a
 * strength field, what it defaults to, and whether there is anywhere to put a
 * negative. Splitting those out would mean every caller re-deriving them, which
 * is where "the negative was folded into the prompt after all" comes from.
 *
 * The palette is the third for the same reason (#46): expansion belongs at the
 * layer that already refuses to fold a negative into a prompt, so that nothing
 * downstream is ever handed a template and left to decide what to do with it.
 * The string this returns is fully expanded, which is what makes it safe for
 * the only thing that is ever persisted.
 *
 * The negative is expanded from the same values as the prompt, and its holes get
 * fields like any other. No recipe in the library puts a variable in one today,
 * but a negative goes on the wire exactly as a prompt does, and a hole the
 * picker never offered a field for is one nobody could have filled.
 */
export function composePreset(
  preset: Preset,
  model: ModelCapabilities,
  palette: Palette,
  values: PresetVariableValues = NO_VARIABLE_VALUES
): ComposedPreset | null {
  const variant = preset.variants[model.promptStyle]
  if (variant === null) return null

  const variables = resolveVariables(variant, palette, values)

  return {
    prompt: expandVariables(variantPrompt(variant), variables),
    // Dropped where the model has no field for it, never folded in (PRD §9).
    negative:
      model.negativePromptParam === null || variant.negative === null
        ? null
        : expandVariables(variant.negative, variables),
    strength: strengthFor(model, variant),
    variables,
  }
}

/**
 * The strength to seed: the preset's opinion held to the measured window, or
 * the model's own default, or nothing at all.
 *
 * Clamped rather than refused, and clamped here rather than at load: a user
 * preset is a file someone edited, and 0.95 in it plainly means "as much style
 * as you can" — 0.8 is as much as this endpoint can give without discarding the
 * image (PRD §6.3).
 *
 * The window was measured on the *style* stage's one endpoint with a strength
 * field, and this is now reached by source presets too. Inert there today —
 * no source model in the registry has a strength parameter, so the branch above
 * returns first — and if one ever appears, the number to hold it to is that
 * model's own, measured, not this one.
 */
function strengthFor(
  model: ModelCapabilities,
  variant: PresetVariant
): number | null {
  if (model.strengthParam === null) return null

  if (variant.strength !== null) {
    const { min, max } = PRESET_STRENGTH_WINDOW
    return Math.min(max, Math.max(min, variant.strength))
  }

  // Ours, never the provider's (PRD §5, §6.3).
  const fallback = model.defaults[model.strengthParam]
  return typeof fallback === 'number' ? fallback : null
}

/**
 * The committed style built-ins — twenty-eight looks.
 *
 * Twenty are hero-recipes v4's restyle track (#48), joining the eight of #28's
 * proving set, which stay: they were drawn from `docs/research/style-presets.md`
 * and none of them duplicates a v4 recipe.
 *
 * The v4 twenty include the texture-led families the proving set deliberately
 * left out — reduction, print, and the analog-degradation looks. That is not a
 * reversal of #36. Two of them carry a `note` saying what still has to happen
 * outside the model — `rs-duotone-dither` and `rs-halftone-highkey`, the two the
 * source library mirrors with scenes of its own — because PRD §6.2 measured that
 * asking for grain barely registers: the model does the *reduction*, which it is
 * good at, and the dither is #36's kernel, which does not exist yet. Displaying
 * the unfinished step is the point.
 *
 * Every preset carries both idioms, and the module note above explains why they
 * are not word-for-word translations of each other. Nothing is ever cross-sent —
 * a variant only reaches a model whose `promptStyle` matches it.
 */
export const STYLE_PRESET_LIBRARY: PresetLibrary =
  readPresetLibrary(LIBRARY_DOCUMENT)

export const BUILT_IN_STYLE_PRESETS: readonly Preset[] =
  STYLE_PRESET_LIBRARY.presets

/**
 * The committed source built-ins — the whole hero-recipes v4 generate track,
 * twenty-four scenes (#48).
 *
 * The one-off values are **inlined into the prose** rather than left as holes,
 * which is the part of this that was not transcription. v4 wrote roughly twenty
 * of them as variables — a botanical, a camera angle, a ranking metric — and
 * every one is now a concrete phrase in the transform: "juniper sprigs and dried
 * citrus wheels" rather than `{{botanical}}`. #28's stated reason for
 * fork-to-customize is that editing a seeded prompt is how somebody learns what
 * the prompt language does, and a specific value teaches where a bare hole
 * teaches nothing — a picker of twenty empty fields is a form, not a scene.
 *
 * So no built-in carries a `defaults` block at all. The mechanism stays, because
 * a fork may acquire holes the moment somebody types `{{` into the box, and
 * because the rule it enforces — a default for a hole the template does not have
 * is a typo — is worth keeping whether or not we use it today.
 *
 * Colour holes address the palette by *role* rather than carrying a default:
 * `{{primary}}` and `{{secondary}}` for the branded colours, `{{ink}}` for the
 * near-black fields and silhouettes the reduction recipes key on, which is why
 * #46 made `ink` mandatory in the first place.
 *
 * One preset, `gn-isometric-lineup`, is the only recipe in v4 that wants
 * lettering, and opts out of the append block by leaving the placeholder out of
 * its template. `gn-vintage-surreal` is the only one authored as five labelled
 * blocks; it is flattened here by concatenation, labels intact, because the
 * labels are part of the prompt text rather than scaffolding around it.
 */
export const SOURCE_PRESET_LIBRARY: PresetLibrary = readPresetLibrary(
  SOURCE_LIBRARY_DOCUMENT
)

export const BUILT_IN_SOURCE_PRESETS: readonly Preset[] =
  SOURCE_PRESET_LIBRARY.presets

/** Look-up by id, `null` for both "no id" and "no such preset". */
export function stylePresetById(id: string | null): Preset | null {
  return presetIn(BUILT_IN_STYLE_PRESETS, id)
}

export function sourcePresetById(id: string | null): Preset | null {
  return presetIn(BUILT_IN_SOURCE_PRESETS, id)
}

function presetIn(
  library: readonly Preset[],
  id: string | null
): Preset | null {
  if (id === null) return null
  return library.find(preset => preset.id === id) ?? null
}

/**
 * Whether this preset has anything to say in the model's idiom.
 *
 * The picker asks before offering it. A preset that cannot speak to the
 * selected model is disabled with the reason attached rather than left
 * selectable — PRD §10.1's disabled-with-a-reason, for the same argument: a
 * selection that seeds nothing looks like a broken picker, and the alternative
 * (seeding the other idiom anyway) is the cross-send `composePreset` exists to
 * refuse.
 */
export function presetSupportsModel(
  preset: Preset,
  model: ModelCapabilities
): boolean {
  return preset.variants[model.promptStyle] !== null
}

/**
 * Whether the form still says what the selected preset says — and when it does
 * not, why, so a re-seed can be *offered* rather than forced (#28's settled
 * model-switch rule).
 *
 * Derived rather than recorded. The alternative was a "seeded with" field on
 * the recipe, which is a second copy of a library the user can edit and one
 * more thing a persisted manifest has to round-trip. What is on screen and what
 * the preset would produce are both here already, so the question answers
 * itself.
 *
 * `idiom` and `edited` are told apart by looking for the prompt in the preset's
 * *other* idiom: a prompt that is verbatim what the previous model's variant
 * says was seeded and then stranded by a model switch, and saying so is the
 * difference between an offer that explains itself and a button that does not.
 */
export type PresetSeedState =
  /** Nothing selected, or a stage whose library does not compose. */
  | { readonly state: 'none' }
  /** The box says exactly what this model's variant says. */
  | { readonly state: 'seeded' }
  /** This model reads an idiom the preset does not speak. */
  | { readonly state: 'unsupported' }
  /** The box says something else — offer to seed it again. */
  | { readonly state: 'stale'; readonly reasonKey: string }

export function presetSeedState(
  prompt: string,
  preset: Preset | null,
  model: ModelCapabilities,
  palette: Palette,
  values: PresetVariableValues = NO_VARIABLE_VALUES
): PresetSeedState {
  if (preset === null) return { state: 'none' }

  const composed = composePreset(preset, model, palette, values)
  if (composed === null) return { state: 'unsupported' }
  if (composed.prompt === prompt) return { state: 'seeded' }

  // Against the other idiom expanded the same way, so a model switch is still
  // told apart from an edit on a preset with holes in it. Comparing against the
  // raw template would report every variable-carrying preset as hand-edited.
  const strandedByModelSwitch = PROMPT_STYLES.filter(
    style => style !== model.promptStyle
  ).some(style => {
    const variant = preset.variants[style]
    if (variant === null) return false
    const other = resolveVariables(variant, palette, values)
    return expandVariables(variantPrompt(variant), other) === prompt
  })

  return {
    state: 'stale',
    reasonKey: strandedByModelSwitch
      ? 'editor.preset.staleIdiom'
      : 'editor.preset.staleEdited',
  }
}

// ── The user's own library (#28's fork flow) ─────────────────────────────────

/**
 * Bumped when a saved fork written today would be misread by an older build.
 *
 * Separate from {@link PRESET_LIBRARY_VERSION} because these are separate
 * artefacts with separate lifetimes: the built-ins ship with the app and move
 * when we move them, a fork lives in app data and must survive an update that
 * rewrites the built-ins entirely (PRD §6).
 */
export const USER_PRESET_VERSION = 1

/** The family a fork is filed under, since it is grouped by being yours. */
export const USER_PRESET_FAMILY = 'user'

/**
 * The ids `presets::store::validate_id` will accept — one preset is one file,
 * so an id has to be a plain file name. Rust refuses anything else rather than
 * sanitising it, which means agreeing here is the frontend's job.
 */
const PRESET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Long enough to read, short enough to leave room for a collision suffix. */
const PRESET_SLUG_MAX = 48

export function isPresetId(id: string): boolean {
  return PRESET_ID_PATTERN.test(id)
}

/**
 * One saved fork, from the file it was read out of.
 *
 * A user preset file *is* a preset — no `presets` array, no shared blocks —
 * which is what makes each fork independent of the others and of ours. Being
 * self-contained is enforced rather than assumed: composing against no blocks
 * at all means a template that still asks for `{preserve}` or `{append}` is
 * refused here, where the alternative is a prompt with a hole in it at the paid
 * step.
 *
 * One reader for forks of both composing libraries, because a fork of a source
 * preset and a fork of a style preset are the same document — they are kept in
 * separate folders on disk (#29's rule, now three-way) so that ids cannot
 * shadow each other, and that is a question about *where* a file is, which the
 * caller already knows and this does not need to.
 *
 * Throws, naming what was wrong. The caller skips that one file and says so —
 * a hand-edited fork must never be able to take the library down (#28).
 */
export function readUserPreset(document: unknown): Preset {
  const record = asRecord(document, 'user preset')

  const version = record.version
  if (version !== USER_PRESET_VERSION) {
    throw new Error(
      `User preset version ${String(version)} is not version ${USER_PRESET_VERSION}`
    )
  }

  const preset = readPreset(record, NO_BLOCKS)

  if (!isPresetId(preset.id)) {
    throw new Error(`Preset id "${preset.id}" is not one a file can be named`)
  }

  return preset
}

/** A fork carries its own wording, so there is nothing to substitute. */
const NO_BLOCKS: LibraryBlocks = { preserve: null, append: null }

/** The document written to app data — one preset, plus what version it is. */
export function writeUserPreset(preset: Preset): Record<string, unknown> {
  return {
    version: USER_PRESET_VERSION,
    id: preset.id,
    name: preset.name,
    family: preset.family,
    aspect: preset.aspect,
    blurb: preset.blurb,
    headlineZone: preset.headlineZone,
    note: preset.note,
    variants: preset.variants,
  }
}

/** The form as it stands, on its way to becoming a fork. */
export interface PresetCapture {
  readonly id: string
  /** User data, so no `t()` ever goes near it. */
  readonly name: string
  /** The idiom of the model in front of you — the only one this can claim. */
  readonly promptStyle: PromptStyle
  /** Exactly what is in the prompt box, which is exactly what was sent. */
  readonly prompt: string
  /** Whatever is in the negative field, or `null` where there is no field. */
  readonly negative: string | null
  /** The strength as set, or `null` on a model that has none. */
  readonly strength: number | null
  /**
   * The hints carried over from whatever seeded the form, or `null`.
   *
   * Not fields on the form — they are the things here the user did not type.
   * They come along anyway because the prompt does: a fork of a scene composed
   * for 3:2 is still a scene composed for 3:2, it still leaves the same corner
   * clear for a headline, and a fork of a two-ink reduction still has to be
   * dithered before it looks like anything. Dropping them would make the fork
   * say less than the text in it already knows. A fork saved from nothing
   * carries `null`, which is the honest answer.
   *
   * The blurb is deliberately *not* in here. The other three are facts about the
   * image the prompt describes; a blurb is a line about one of our presets, and
   * a fork has its own name and its own text by the time it is saved.
   */
  readonly aspect: AspectId | null
  readonly headlineZone: HeadlineZone | null
  readonly note: string | null
}

/**
 * A fork of what is on screen right now.
 *
 * One idiom is *written*: a save can only speak for the model in front of it,
 * and inventing the other idiom's wording is exactly the cross-send this schema
 * exists to prevent. So a fork seeds the models that read prompts the way this
 * one did, and is honestly disabled for the rest.
 *
 * The other idiom comes from `base` — the preset being updated in place, when
 * there is one — and is copied **verbatim**. Without it, updating a fork that
 * speaks both idioms from a prose model would silently delete its tags variant:
 * a save is a claim about the form in front of you, never a claim that the other
 * idiom has stopped existing. `null` for a brand-new fork, which has no other
 * idiom to keep.
 *
 * The prompt is stored whole, as `transform` with a `{transform}`-only
 * template. There is no preserve block to re-apply because the box already
 * contains one — the composed prompt is what was captured — and re-composing
 * would say it twice.
 */
export function userPresetFrom(
  capture: PresetCapture,
  base: Preset | null = null
): Preset {
  const negative = capture.negative?.trim() ?? ''
  const strength = capture.strength

  const variant: PresetVariant = {
    transform: capture.prompt.trim(),
    compose: TRANSFORM_SLOT,
    negative: negative === '' ? null : negative,
    // Held to what a variant may say, so a fork always reads back: an empty
    // strength field arrives here as 0, which is not an opinion about strength.
    strength:
      strength !== null && strength > 0 && strength <= 1 ? strength : null,
    // None, always. What was captured is the *expanded* prompt — resolution
    // happened at seed time — so any `{{…}}` still in it is one the user chose
    // to leave, and inheriting the original's defaults would put words back
    // into a hole they deliberately left open (#46).
    defaults: {},
  }

  return {
    id: capture.id,
    name: capture.name.trim(),
    family: USER_PRESET_FAMILY,
    aspect: capture.aspect,
    // Ours to write, so no fork ever claims one of our sales lines for a prompt
    // it has since rewritten.
    blurb: null,
    headlineZone: capture.headlineZone,
    note: capture.note,
    variants: {
      prose:
        capture.promptStyle === 'prose'
          ? variant
          : (base?.variants.prose ?? null),
      tags:
        capture.promptStyle === 'tags'
          ? variant
          : (base?.variants.tags ?? null),
    },
  }
}

/**
 * An id for a name, unused by anything in `taken`.
 *
 * Slugified rather than minted, because this is a file name someone may go
 * looking for in app data. Collisions take a numeric suffix rather than
 * overwriting: two forks called "Warmer" are two forks, and the whole promise
 * of the user library is that nothing we do can clobber it.
 */
export function presetIdFrom(name: string, taken: Iterable<string>): string {
  const base = slugify(name)
  const used = new Set(taken)
  if (!used.has(base)) return base

  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate)) return candidate
  }

  // A thousand forks of one name is not a case worth a nicer answer than an
  // id that is certainly free.
  return `${base}-${Date.now().toString(36)}`
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, PRESET_SLUG_MAX)
    .replace(/^-+|-+$/g, '')

  // A name in a script this slug cannot represent is still a valid name — it
  // just cannot be the file name, and the name is what is shown anyway.
  return slug === '' ? 'preset' : slug
}
