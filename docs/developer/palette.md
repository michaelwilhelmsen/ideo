# The Project Palette

Six colour roles a project's prompts are written in, plus any number of unroled extras.
The model is `src/lib/recipe/palette.ts`, the vocabulary is
`src/lib/recipe/colour-names.json`, and the editor is
`src/components/editor/PaletteDialog.tsx`.

A palette is **prompt data, not chrome**. Nothing in it styles the app. Every value exists
to be interpolated into a prompt by `composePreset` — see
[composing-presets.md](./composing-presets.md) for the resolution rules.

## Roles, not positions

| Role        | What it is for                                              |
| ----------- | ----------------------------------------------------------- |
| `primary`   | the lead colour                                             |
| `secondary` | the second                                                  |
| `accent`    | the third                                                   |
| `ink`       | the darkest — what a reduction reduces _to_                 |
| `paper`     | the lightest — the ground                                   |
| `neutral`   | the unsaturated one                                         |
| extras      | anything else, addressed by position as `extra1`, `extra2`… |

All six are required. Palettes are swappable from a library (#49), and under positional
slots a swap would silently reassign which colour does which job in every recipe at once —
turning a comparison into a reroll. `ink` and `paper` being mandatory is what lets the
reduction and print preset families reference the palette instead of hardcoding near-black.

Extras run out rather than wrapping. A recipe asking for `extra3` of a two-extra palette
falls through to its authored default and then to a visible literal — never back to the
first entry, because a recipe wanting many colours wants them _contrasting_.

## Prompts get names, never hex

`#D9662C` in a prompt fails erratically and silently: text encoders are trained on colour
language, not hex triplets. So the unit that leaves this module is always a word.

Where an entry has no authored name, one is derived by nearest-colour lookup in CIEDE2000
against `colour-names.json` — roughly 120 curated pigment and material terms. Deliberately
not CSS names and not a general names package: those optimise for precision of
identification, and a prompt needs fluency of description. "Deep cobalt" is worth paying a
model to read; "darkslategray" is not.

The same table names the built-in palettes, so an authored name and a derived one sound
alike. The shipped default carries no authored names at all — it is named by the same
lookup a colour the user types gets.

`culori` supplies the maths (`oklch`, `nearest`, `differenceCiede2000`), tree-shakably.

## The invariant, and where it is a crash

`paletteProblem` returns a structured problem or `null`:

- `ink` is strictly the darkest entry, extras included.
- `paper` is strictly the lightest.
- `primary`, `secondary` and `accent` are at least `MIN_ROLE_LIGHTNESS_GAP` (0.08) apart
  in OKLCH lightness.

That last clause is load-bearing. Roughly ten recipes in the incoming library reduce to two
inks, and a palette whose entries sit at the same lightness turns all of them to mud with
no visible explanation.

| Where it enters      | What a violation is                                         |
| -------------------- | ----------------------------------------------------------- |
| `palettes.json`      | a startup crash — every built-in goes through `readPalette` |
| a manifest           | `readManifest` throws and the project does not open         |
| a saved palette file | skipped, counted, and said aloud in the picker              |
| the palette editor   | a disabled Save with the reason under it (PRD §10.1)        |

The split is the point. Persisted data with a mistake in it should be loud; a half-typed
hex should not take the app down. Both use the same function, which is why the problem is
structured rather than a sentence — a throw and a translated line have different owners.

## Per project, copied at creation

Seeded from `DEFAULT_PALETTE` and then owned by the project (PRD §11), copied deeply by
`copyPalette` so a later change to the default leaves existing projects alone.

Unlike the aspect ratio, it stays **editable after creation**, and it passes §11's own test
for that: every recipe persists its expanded prose, so changing a colour cannot retroactively
alter anything already generated. It only changes what the next preset pick seeds.

The manifest carries it as a **required** field with no tolerant fallback — the one field
`readManifest` refuses to default. A missing batch size is a preference nobody expressed; a
missing palette is six colours the next prompt will be written in, and substituting ours
would turn an unopenable project into one that opens and quietly says something else.

## The library

`src/lib/recipe/palettes.ts` and `palettes.json` make a palette something you **pick**
(#49): five committed palettes, plus whatever the user has saved, on the terms PRD §6 set
for the three preset libraries. The picker is at the top of the palette editor, not in
preferences — a palette is prompt data on the same footing as a preset, and the preset
libraries put pick-and-fork in the editor for the same reason.

| Half       | Where                      | What a bad one costs                             |
| ---------- | -------------------------- | ------------------------------------------------ |
| built-ins  | `palettes.json`, committed | a startup crash, naming the palette and the slot |
| the user's | `palettes/` in app data    | that one file skipped, and the count said aloud  |

`palettes/` sits **beside** `presets/` rather than inside it, as a fourth variant of the
Rust `Library` enum. The store is shared because the storage problem is identical — one
validated-id JSON document per file, written atomically — and the folder is not, because a
palette seeds no stage and composes no prompt.

Three rules the picker rests on:

- **A pick replaces the roles _and_ the extras**, wholesale. Keeping the previous
  palette's extras is the reroll-rather-than-comparison failure roles were introduced to
  prevent: `extra2` of one palette has nothing to do with `extra2` of another.
- **Nothing records where a project's colours came from** (PRD §11), so the picker's label
  is derived by comparing values — `samePalette`, exact on hex and authored name — and
  says _Custom_ the moment one hex is off. A tolerance here is how a stale label would
  survive an edit.
- **No authored colour names anywhere in the library**, for the reason the shipped default
  carries none. A built-in whose derived name reads badly is a gap in `colour-names.json`,
  and adding the term there improves every colour anyone types.

`DEFAULT_PALETTE` is the first entry of that committed file rather than a literal of its
own, so the six hexes a new project copies have one source rather than two that can
disagree.

## Not here

- **Palette provenance on a project** — and everything that would need it: reset-to-palette,
  drift indication, update-from-palette. #49 settled that a project carries values and not
  a pointer.
- **Any use of the hex values in post-processing** — #36.
- **The app's own UI theme.** Unrelated; see `src/theme-variables.css`.
