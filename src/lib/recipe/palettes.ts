/**
 * The palette library — palettes as something you *pick* rather than type (#49).
 *
 * `palette.ts` gives a project six colour roles and the words a model is told
 * them in. This gives the roles somewhere to come from: five committed palettes,
 * plus whatever the user has forked into app data, on exactly the terms PRD §6
 * set for the three preset libraries.
 *
 * **A palette is picked, not referenced.** Applying one *copies* its entries
 * onto the project (PRD §11) and nothing records which palette they came from.
 * That is the same copy-don't-reference rule the preset libraries follow, and it
 * is what makes editing a library palette safe: it cannot reach backwards into
 * projects seeded from it. The cost is that "which palette is this" has to be
 * answered by comparing values ({@link samePalette}) rather than by reading an
 * id, and the honest answer when nothing matches is *Custom*.
 *
 * **A swap replaces the extras too.** Keeping the previous palette's extras
 * would be the "reroll rather than comparison" failure roles were introduced to
 * prevent — `extra2` of one palette has nothing to do with `extra2` of another,
 * and a recipe reaching for it would get a colour from a scheme nobody chose.
 * There is no partial apply.
 *
 * **No authored colour names anywhere in here.** Every entry is named by the
 * same nearest-colour lookup a hex the user types gets, for the reason
 * {@link DEFAULT_PALETTE} already gave: an authored name is a second copy of
 * `colour-names.json` that nothing keeps honest. A built-in whose derived name
 * reads badly is evidence of a gap in the curated vocabulary, and adding the
 * term there improves every colour anyone types rather than that one palette.
 *
 * The committed file is validated at import and a violation is a startup crash;
 * a fork in app data is *skipped* with the count carried back, because one
 * hand-edited file must not cost the library. Same split as everywhere else.
 */

import { asRecord } from './json'
import {
  copyPalette,
  PALETTE_ROLES,
  readPalette,
  type Palette,
} from './palette'
import LIBRARY_DOCUMENT from './palettes.json'
// A palette is not a preset, and these two are still the preset module's:
// `isPresetId` *is* the pattern `presets::store::validate_id` accepts, and
// `presetIdFrom` is the minting rule that agrees with it. Both are about the
// file a document lands in rather than about what is in the document, and the
// store underneath is one store — a second copy of either would be a second
// place to drift away from Rust.
import { isPresetId, presetIdFrom } from './presets'

/** Bumped when a library written today would be misread by an older build. */
export const PALETTE_LIBRARY_VERSION = 1

/**
 * A palette with a name on it.
 *
 * The palette is held rather than flattened into this, because a project stores
 * exactly the {@link Palette} and nothing else — the id and the name are the
 * *library's* facts about it, and keeping them in a wrapper is what stops them
 * being copied onto a project by accident.
 *
 * `name` is user data whoever wrote it (PRD §6) — ours are authored here and the
 * user's are typed — so no `t()` ever goes near it.
 */
export interface NamedPalette {
  readonly id: string
  readonly name: string
  readonly palette: Palette
}

/** A whole library: a version, and the palettes in it. */
export interface PaletteLibrary {
  readonly version: number
  readonly palettes: readonly NamedPalette[]
}

/**
 * A library from an untrusted document, or a throw naming what was wrong.
 *
 * Exported for the same reason `readMotionLibrary` is: the built-ins are not the
 * only source this shape arrives from.
 */
export function readPaletteLibrary(document: unknown): PaletteLibrary {
  const record = asRecord(document, 'palette library')

  const version = record.version
  if (version !== PALETTE_LIBRARY_VERSION) {
    throw new Error(
      `Palette library version ${String(version)} is not version ${PALETTE_LIBRARY_VERSION}`
    )
  }

  const documents = record.palettes
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error('Palette library lists no palettes')
  }

  const seen = new Set<string>()
  const palettes = documents.map(entry => {
    const named = readNamedPalette(entry)
    if (seen.has(named.id)) {
      throw new Error(`Palette "${named.id}" is declared twice`)
    }
    seen.add(named.id)
    return named
  })

  return { version, palettes }
}

/**
 * One named palette, from an untrusted document.
 *
 * The palette itself goes through `readPalette`, so the lightness invariant is
 * checked here on ours exactly as it is on a manifest's — a built-in that would
 * turn a two-ink recipe to mud is a crash at startup, naming the palette and the
 * slots.
 */
function readNamedPalette(document: unknown): NamedPalette {
  const record = asRecord(document, 'palette')

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') throw new Error('A palette has no id')

  const fail = (problem: string): never => {
    throw new Error(`Palette "${id}": ${problem}`)
  }

  // Every id here is eventually a file name in app data — a fork takes one —
  // so the pattern Rust enforces is checked on ours as well as theirs.
  if (!isPresetId(id)) fail('is not an id a file can be named')

  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') fail('has no name')

  let palette: Palette
  try {
    palette = readPalette(record)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }

  return { id, name, palette }
}

/** The committed palettes, validated at import. */
export const PALETTE_LIBRARY: PaletteLibrary =
  readPaletteLibrary(LIBRARY_DOCUMENT)

export const BUILT_IN_PALETTES: readonly NamedPalette[] =
  PALETTE_LIBRARY.palettes

/**
 * The palette a new project copies (PRD §11).
 *
 * The first built-in rather than a literal of its own, so there is one source
 * for those six hexes rather than two that can disagree. An editorial triple
 * chosen so any two entries duotone legibly — `#D9662C` warm orange, `#1F4E79`
 * deep blue, `#B5352A` red — extended to fill all six roles. Real values rather
 * than unset, because an unfilled colour variable reaching a model is the
 * failure mode most worth eliminating by default.
 *
 * Non-null asserted through a throw rather than a `!`: an empty library is
 * already refused by {@link readPaletteLibrary}, so this is unreachable, and it
 * is written down because the alternative is a project created with no colours
 * at all.
 */
export const DEFAULT_PALETTE: Palette = firstBuiltIn().palette

function firstBuiltIn(): NamedPalette {
  const first = BUILT_IN_PALETTES[0]
  if (first === undefined) throw new Error('The palette library is empty')
  return first
}

/**
 * Whether two palettes say the same thing.
 *
 * The picker's whole readout rests on this: nothing records where a project's
 * palette came from, so the only honest way to show a name above the role rows
 * is to compare values and say *Custom* when none of them match. Compared
 * exactly — hex and authored name, roles and the full extras list in order —
 * because "nearly" is not a claim the label makes. Editing one hex has to drop
 * the label, and a tolerance is how it would fail to.
 */
export function samePalette(one: Palette, other: Palette): boolean {
  const sameEntry = (
    a: Palette['extras'][number],
    b: Palette['extras'][number]
  ): boolean => a.hex === b.hex && a.name === b.name

  return (
    PALETTE_ROLES.every(role =>
      sameEntry(one.roles[role], other.roles[role])
    ) &&
    one.extras.length === other.extras.length &&
    one.extras.every((entry, index) => {
      const theirs = other.extras[index]
      return theirs !== undefined && sameEntry(entry, theirs)
    })
  )
}

/**
 * The library entry a project's colours came out of, or `null` for a custom one.
 *
 * Generic over anything holding a palette rather than over {@link NamedPalette},
 * because the picker wraps its entries in what it needs to tell one *source*
 * from another — a built-in and one of the user's own may legitimately share an
 * id, so an id is not enough to identify an entry with.
 *
 * The first match wins, and two entries only tie by being the same six colours,
 * so the caller's order is the tie-break.
 */
export function namedPaletteFor<T extends { readonly palette: Palette }>(
  palette: Palette,
  library: readonly T[]
): T | null {
  return library.find(entry => samePalette(entry.palette, palette)) ?? null
}

// ── The user's own library ──────────────────────────────────────────────────

/**
 * Bumped when a saved palette written today would be misread by an older build.
 *
 * Separate from {@link PALETTE_LIBRARY_VERSION} for the reason the preset
 * libraries keep two versions: the built-ins ship with the app and move when we
 * move them, and a fork lives in app data and has to survive an update that
 * rewrites every built-in.
 */
export const USER_PALETTE_VERSION = 1

/**
 * One saved palette, from the file it was read out of.
 *
 * Throws, naming what was wrong — including when the invariant is broken, which
 * is the case a hand-edit makes reachable. The caller skips that one file and
 * says so out loud: a palette that would turn a two-ink recipe to mud must not
 * be selectable, and one bad file must not take the library down.
 */
export function readUserPalette(document: unknown): NamedPalette {
  const record = asRecord(document, 'user palette')

  const version = record.version
  if (version !== USER_PALETTE_VERSION) {
    throw new Error(
      `User palette version ${String(version)} is not version ${USER_PALETTE_VERSION}`
    )
  }

  return readNamedPalette(record)
}

/** The document written to app data — one palette, plus what version it is. */
export function writeUserPalette(named: NamedPalette): Record<string, unknown> {
  const copy = copyPalette(named.palette)

  return {
    version: USER_PALETTE_VERSION,
    id: named.id,
    name: named.name,
    roles: copy.roles,
    extras: copy.extras,
  }
}

/**
 * An id for a newly saved palette, free of the ones already taken.
 *
 * Taken means *among palettes* and nothing else. Preset ids are unique across
 * all three preset libraries because a recipe records one and it has to resolve
 * to exactly one library; nothing anywhere records a palette id, so a palette
 * called `glass-caustics` shadows nothing and colliding with a preset costs
 * nobody anything.
 */
export function paletteIdFrom(name: string, taken: Iterable<string>): string {
  return presetIdFrom(name, taken, 'palette')
}
