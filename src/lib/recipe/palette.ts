/**
 * The project palette — six colour roles, and the words a model is told them in.
 *
 * A palette is **prompt data, not chrome** (#46). Nothing here styles the app;
 * every value in it exists to be interpolated into a prompt by
 * `composePreset`, which is why the unit that leaves this module is a *name*
 * and never a hex.
 *
 * Three decisions carry the whole design.
 *
 * **Roles, not positions.** `primary`, `secondary`, `accent`, `ink`, `paper`,
 * `neutral`, all six required, plus any number of unroled extras. A follow-up
 * (#49) makes palettes swappable from a library, and under positional slots a
 * swap would silently reassign which colour does which job in every recipe at
 * once — turning a comparison into a reroll. `ink` and `paper` being mandatory
 * is also what lets the reduction and print preset families reference the
 * palette instead of hardcoding near-black.
 *
 * **Prompts get the colour's name, never its hex.** Diffusion text encoders are
 * trained on colour language, not hex triplets; `#D9662C` in a prompt fails
 * erratically and silently. Where an entry has no authored name one is derived
 * by nearest-colour lookup against {@link COLOUR_NAMES} — a curated table of
 * pigment and material terms committed to the repo, rather than CSS names or a
 * general names package. Those optimise for precision of identification, and a
 * prompt needs fluency of description: "deep cobalt" is worth paying a model
 * for and "darkslategray" is not.
 *
 * **Validated wherever it enters the app, and loudly.** Same reasoning as the
 * registry and the preset libraries: committed or persisted data with a mistake
 * in it should be a crash, not a prompt that quietly says less than it meant to.
 * The invariant is {@link paletteProblem} — `ink` darkest, `paper` lightest, and
 * the three mid roles far enough apart in OKLCH lightness to survive a
 * two-colour reduction. That last clause is load-bearing: roughly ten recipes in
 * the incoming library reduce to two inks, and a palette whose entries sit at
 * the same lightness turns all of them to mud with no visible explanation.
 *
 * The one place that is *not* a crash is the palette editor, where the values
 * are being typed rather than read back. There the same problem is reported as
 * a disabled save with the reason attached (PRD §10.1) — which is why the
 * invariant returns a structured problem rather than a sentence.
 */

import { differenceCiede2000, nearest, oklch } from 'culori'
import COLOUR_NAME_DOCUMENT from './colour-names.json'
import { asRecord, isRecord } from './json'

/** The six jobs a palette always fills, in the order the editor lists them. */
export const PALETTE_ROLES = [
  'primary',
  'secondary',
  'accent',
  'ink',
  'paper',
  'neutral',
] as const

export type PaletteRole = (typeof PALETTE_ROLES)[number]

/**
 * One colour, and what to call it in a prompt.
 *
 * `name` is `null` rather than absent when nobody has named it — that is the
 * normal state, and it means "derive one", not "this colour is nameless".
 * Authored names are user data and never go near `t()`.
 */
export interface PaletteEntry {
  /** `#RRGGBB`, upper case. The only form anything here accepts. */
  readonly hex: string
  readonly name: string | null
}

/**
 * A project's colours: the six roles, plus whatever else it wants to carry.
 *
 * Extras are addressed positionally (`extra1`, `extra2`, …) because they have
 * no job to be named after — see {@link paletteEntryFor}. They exist for the
 * recipes that want more colours than six, and for #49's built-in palettes,
 * which carry the leftovers of a scheme the six roles could not use.
 */
export interface Palette {
  readonly roles: Readonly<Record<PaletteRole, PaletteEntry>>
  readonly extras: readonly PaletteEntry[]
}

/** Nothing else is a colour as far as this module is concerned. */
const HEX = /^#[0-9A-Fa-f]{6}$/

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

/**
 * How far apart in OKLCH lightness `primary`, `secondary` and `accent` have to
 * sit for a two-ink reduction to keep them apart.
 *
 * A floor rather than a target. The shipped default's tightest pair is 0.106,
 * so this is not a number reverse-engineered from it — it is the point below
 * which a duotone maps two roles onto the same ink and the recipe loses the
 * distinction it was built on.
 */
export const MIN_ROLE_LIGHTNESS_GAP = 0.08

/** OKLCH lightness, 0 (black) to 1 (white). */
export function lightnessOf(hex: string): number {
  return oklch(hex)?.l ?? 0
}

/**
 * What is wrong with this palette, or `null`.
 *
 * Structured rather than a sentence because it has two readers with different
 * obligations: {@link readPalette} turns it into an `Error` that a developer
 * reads, and the palette editor turns it into a translated line under a
 * disabled save button that a user reads. One of them must not be a crash and
 * the other must not be silent, so neither gets to own the wording.
 *
 * Slots are named so the message can point at the offending entries — "the
 * palette is invalid" is not something anybody can act on.
 */
export type PaletteProblem =
  /** Something is darker than `ink`, so a reduction has nothing to key on. */
  | { readonly kind: 'inkNotDarkest'; readonly slot: string }
  /** Something is lighter than `paper`. */
  | { readonly kind: 'paperNotLightest'; readonly slot: string }
  /** Two of the three mid roles would collapse into one ink. */
  | {
      readonly kind: 'rolesTooClose'
      readonly slot: PaletteRole
      readonly other: PaletteRole
    }

/** The three roles a two-colour reduction has to be able to tell apart. */
const REDUCIBLE_ROLES: readonly PaletteRole[] = [
  'primary',
  'secondary',
  'accent',
]

export function paletteProblem(palette: Palette): PaletteProblem | null {
  const inkL = lightnessOf(palette.roles.ink.hex)
  const paperL = lightnessOf(palette.roles.paper.hex)

  for (const [slot, entry] of paletteSlots(palette)) {
    if (slot === 'ink') continue
    if (lightnessOf(entry.hex) <= inkL) {
      return { kind: 'inkNotDarkest', slot }
    }
  }

  for (const [slot, entry] of paletteSlots(palette)) {
    if (slot === 'paper') continue
    if (lightnessOf(entry.hex) >= paperL) {
      return { kind: 'paperNotLightest', slot }
    }
  }

  for (const slot of REDUCIBLE_ROLES) {
    for (const other of REDUCIBLE_ROLES) {
      if (slot === other) continue
      const gap = Math.abs(
        lightnessOf(palette.roles[slot].hex) -
          lightnessOf(palette.roles[other].hex)
      )
      if (gap < MIN_ROLE_LIGHTNESS_GAP) {
        return { kind: 'rolesTooClose', slot, other }
      }
    }
  }

  return null
}

/** The same problem as an English sentence, for a throw rather than a screen. */
export function describePaletteProblem(problem: PaletteProblem): string {
  switch (problem.kind) {
    case 'inkNotDarkest':
      return `ink must be the darkest colour, and ${problem.slot} is darker`
    case 'paperNotLightest':
      return `paper must be the lightest colour, and ${problem.slot} is lighter`
    case 'rolesTooClose':
      return `${problem.slot} and ${problem.other} are too close in lightness to survive a two-colour reduction`
  }
}

/**
 * Every entry with the name a variable would address it by — the six roles in
 * declaration order, then the extras as `extra1`, `extra2`, …
 */
export function paletteSlots(
  palette: Palette
): readonly (readonly [string, PaletteEntry])[] {
  return [
    ...PALETTE_ROLES.map(role => [role, palette.roles[role]] as const),
    ...palette.extras.map(
      (entry, index) => [`extra${index + 1}`, entry] as const
    ),
  ]
}

/** A role name, or `extraN` for an unroled entry. Anything else is free text. */
const EXTRA_SLOT = /^extra([1-9][0-9]*)$/

/**
 * The entry a template variable names, or `null` when the palette has no such
 * slot.
 *
 * `null` for an extra beyond the end is the whole point of addressing them by
 * position: a recipe asking for `extra3` of a two-extra palette falls through
 * to its own authored default and then to a visible literal. It must never wrap
 * back to the first entry — the recipes that want many colours want them
 * *contrasting*, so wrapping would assign one hex to both sides of a
 * distinction the look is built on.
 */
export function paletteEntryFor(
  palette: Palette,
  key: string
): PaletteEntry | null {
  if (isPaletteRole(key)) return palette.roles[key]

  const extra = EXTRA_SLOT.exec(key)
  if (extra === null) return null

  return palette.extras[Number(extra[1]) - 1] ?? null
}

export function isPaletteRole(value: unknown): value is PaletteRole {
  return PALETTE_ROLES.some(role => role === value)
}

/** Whether a variable key addresses the palette at all, filled or not. */
export function namesPaletteSlot(key: string): boolean {
  return isPaletteRole(key) || EXTRA_SLOT.test(key)
}

// ── Naming ───────────────────────────────────────────────────────────────────

interface ColourName {
  readonly name: string
  readonly hex: string
}

/** Bumped when a table written today would be misread by an older build. */
const COLOUR_NAME_VERSION = 1

/**
 * The curated vocabulary, from the committed table.
 *
 * Read through the same untrusted-document treatment as everything else here,
 * even though it ships with the app: a typo in it would otherwise surface as a
 * prompt asking a model for a colour called `undefined`.
 */
export const COLOUR_NAMES: readonly ColourName[] =
  readColourNames(COLOUR_NAME_DOCUMENT)

function readColourNames(document: unknown): readonly ColourName[] {
  const record = asRecord(document, 'colour name table')

  if (record.version !== COLOUR_NAME_VERSION) {
    throw new Error(
      `Colour name table version ${String(record.version)} is not version ${COLOUR_NAME_VERSION}`
    )
  }

  const entries = record.colours
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Colour name table lists no colours')
  }

  return entries.map(entry => {
    const colour = asRecord(entry, 'colour name')
    const name = typeof colour.name === 'string' ? colour.name.trim() : ''
    if (name === '') throw new Error('A colour in the table has no name')
    if (!isHex(colour.hex)) {
      throw new Error(`Colour "${name}" has no #RRGGBB hex`)
    }
    return { name, hex: colour.hex.toUpperCase() }
  })
}

/**
 * Nearest in CIEDE2000 rather than in RGB or in raw OKLCH distance: the metric
 * is the one built to model *perceived* difference, and a name is a claim about
 * perception. Built once at module load, because it precomputes the candidate
 * set.
 */
const nearestHex = nearest(
  COLOUR_NAMES.map(colour => colour.hex),
  differenceCiede2000()
)

/** The curated term closest to this colour. */
export function nearestColourName(hex: string): string {
  const match = nearestHex(hex, 1)[0]
  const colour = COLOUR_NAMES.find(entry => entry.hex === match)
  // The fallback is unreachable — the candidate set *is* the table — and it is
  // written down anyway because the one thing that must never happen is a hex
  // reaching a prompt. A wrong-but-plausible colour word costs one generation;
  // `#D9662C` in a prompt fails erratically and silently.
  return colour?.name ?? UNNAMED_COLOUR
}

/** Only ever reached if the table and the lookup disagree, which they cannot. */
const UNNAMED_COLOUR = 'neutral grey'

/**
 * What a prompt calls this colour — the authored name, or the nearest curated
 * term.
 *
 * The same table names the built-in palettes, so an authored name and a derived
 * one read alike rather than one of them sounding like a paint chip and the
 * other like a CSS keyword.
 */
export function colourNameOf(entry: PaletteEntry): string {
  const authored = entry.name?.trim() ?? ''

  // A hex typed into the name field is not a name. Refused here rather than in
  // the editor because this is the single point every prompt's colour word
  // passes through, and "no hex ever reaches a prompt" is only a guarantee if it
  // holds for a hand-edited manifest too.
  if (authored === '' || isHex(authored)) return nearestColourName(entry.hex)

  return authored
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * A palette from an untrusted document, or a throw naming what was wrong.
 *
 * The document has the same shape the type does — `roles` keyed by role, then
 * `extras` — so the manifest writes a palette out as-is, exactly as it does
 * `batchSizes` and `selection`. A flatter document would read a little better
 * by hand at the cost of a writer, and a writer is one more place for the two
 * shapes to drift.
 *
 * Every role is required and absence is not tolerated. This is initial
 * development and there are no manifests in the wild to stay compatible with,
 * so a fallback would only ever hide the one bug it exists to survive: a
 * project silently acquiring a palette it was never given, and prompts quietly
 * changing colour.
 */
export function readPalette(document: unknown): Palette {
  const record = asRecord(document, 'palette')
  const roleDocuments = asRecord(record.roles, 'palette roles')

  const roles: Partial<Record<PaletteRole, PaletteEntry>> = {}
  for (const role of PALETTE_ROLES) {
    roles[role] = readEntry(roleDocuments[role], role)
  }

  const extras = record.extras
  if (extras !== undefined && extras !== null && !Array.isArray(extras)) {
    throw new Error('Palette has extras that are not a list')
  }

  const palette: Palette = {
    roles: roles as Palette['roles'],
    extras: Array.isArray(extras)
      ? extras.map((entry, index) => readEntry(entry, `extra${index + 1}`))
      : [],
  }

  const problem = paletteProblem(palette)
  if (problem !== null) {
    throw new Error(`Palette is unusable: ${describePaletteProblem(problem)}`)
  }

  return palette
}

function readEntry(document: unknown, slot: string): PaletteEntry {
  if (!isRecord(document)) {
    throw new Error(`Palette has no ${slot} colour`)
  }
  if (!isHex(document.hex)) {
    throw new Error(`Palette ${slot} has no #RRGGBB hex`)
  }

  const name = document.name
  if (name !== undefined && name !== null && typeof name !== 'string') {
    throw new Error(`Palette ${slot} has a name that is not text`)
  }

  const trimmed = typeof name === 'string' ? name.trim() : ''

  return {
    hex: document.hex.toUpperCase(),
    name: trimmed === '' ? null : trimmed,
  }
}

/**
 * The palette a new project copies, mirroring how `DEFAULT_BATCH_SIZES` works
 * (PRD §11).
 *
 * An editorial triple chosen so any two entries duotone legibly — `#D9662C`
 * warm orange, `#1F4E79` deep blue, `#B5352A` red — extended to fill all six
 * roles. Real values rather than unset, because an unfilled colour variable
 * reaching a model is the failure mode most worth eliminating by default.
 *
 * No authored names: every one of these is named by the curated table, which is
 * the same lookup a colour the user types gets. Writing the names down here
 * would be a second copy of the table that nothing keeps honest.
 *
 * Read through {@link readPalette} rather than declared as a typed literal, so
 * an editorial change that breaks the lightness invariant is a startup crash
 * rather than six recipes that quietly turn to mud.
 */
export const DEFAULT_PALETTE: Palette = readPalette({
  roles: {
    primary: { hex: '#D9662C' },
    secondary: { hex: '#1F4E79' },
    accent: { hex: '#B5352A' },
    ink: { hex: '#14110F' },
    paper: { hex: '#F4EFE6' },
    neutral: { hex: '#8A8079' },
  },
  extras: [],
})

/** A copy nothing else holds a reference into (PRD §11's copy-don't-reference). */
export function copyPalette(palette: Palette): Palette {
  return {
    roles: Object.fromEntries(
      PALETTE_ROLES.map(role => [role, { ...palette.roles[role] }])
    ) as Palette['roles'],
    extras: palette.extras.map(entry => ({ ...entry })),
  }
}
