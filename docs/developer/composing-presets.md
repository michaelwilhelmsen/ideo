# Composing Presets — source and style

How a scene or a look reaches the generation form. One type and one loader in
`src/lib/recipe/presets.ts`, over **two** committed libraries —
`src/lib/recipe/source-presets.json` and `src/lib/recipe/presets.json`. The user's own
forks are in `src/services/source-presets.ts` and `src/services/style-presets.ts`, and the
control both stages share is `src/components/editor/PresetField.tsx`.

There is a **third, independent library** for movement — see
[motion-presets.md](./motion-presets.md). It keeps its own type because it genuinely needs
less. `src/lib/recipe/libraries.ts` is the only module that knows all three exist:
`presetsForStage` and `presetById` live there.

## Source and style are one shape, two libraries

A **source** preset is a whole scene, carrying composition, subject framing and negative
space. A **style** preset is a transform applied to a composition someone else already
made. That is a real difference, and it is a difference in _data_ — both hold per-idiom
variants, a compose template, a negative and a strength, so both are `Preset` and both are
read by `readPresetLibrary` (#47).

What each library declares is the difference:

|                     | Source                                | Style                                     |
| ------------------- | ------------------------------------- | ----------------------------------------- |
| Library-level block | `append` — no text, lettering, logos  | `preserve` — keep the composition         |
| Aspect hint         | yes, per preset                       | no — a restyle inherits its frame         |
| Headline zone       | yes, per preset                       | no — same reason                          |
| Built-ins           | 24 — hero-recipes v4's generate track | 28 — v4's restyle track, plus #28's eight |
| Committed in        | `source-presets.json`                 | `presets.json`                            |
| Forks live in       | `app_data_dir/presets/source/*.json`  | `app_data_dir/presets/*.json`             |

Both blocks are optional, and a library may declare neither. **Opting out is omission**: a
preset that leaves `{append}` out of its template does not get it, which is how the one
scene that wants lettering keeps it, and a preset needing stricter preserve wording writes
that wording into its own template rather than asking for a second library-level variant.

Ids are unique across all three libraries, because a recipe records one `presetId` per
stage and `presetById` resolves it without knowing which stage it came from.

### The aspect hint is a hint

A source preset names the ratio it was composed for. PRD §4.4 locks aspect at project
creation, so this is **displayed and nothing more** — it does not filter, sort or dim the
picker. Every ratio the library uses is already offered, so dimming the mismatches would
hide most of the library on a wide project, and a strong filter dressed as a hint is worse
than no hint.

### The two idioms are not word-for-word translations

Every built-in carries both variants, and they say the same thing differently. Prose can be
sequenced and conditional — one recipe specifies that halation blooms _only_ around light
sources bright enough to exceed the film's latitude, never uniformly and never on midtones.
A comma-separated list has no word for "only", so the tags variant states the positive
plainly and pushes the excluded readings into `negative`.

That works because **`promptStyle: 'tags'` and a non-null `negativePromptParam` are the
same models**. Every tags-idiom row in the registry has a real negative-prompt field and no
prose-idiom row does, so a constraint migrating out of the positive lands in a field that
exists on precisely the models that read the variant it migrated in. The reduction and
print families depend on it: "gradients, midtones, third colour" is how those palettes are
held down, and tags is the only idiom where it reaches a model at all.

The invariant is one-directional and tested: **tags subtracts everything prose subtracts,
and may subtract more.** Equality would forbid the translation; no relation at all would
let a careless tags rewrite silently drop a constraint.

Both variants carry a `negative` regardless. On prose it is dropped every time today, by
`composePreset`, per model — but that is routing, and writing `null` (documented as "this
look has nothing to subtract") would be untrue.

### Display-only metadata

Five fields are shown and never sent: `family`, `blurb`, `headlineZone` and `aspect`, plus
`note` where a look is not finished by the model alone.

| Field          | On                              | Says                                                     |
| -------------- | ------------------------------- | -------------------------------------------------------- |
| `family`       | every built-in                  | how the picker groups — one optgroup per family          |
| `blurb`        | every built-in, `null` on forks | one line on what this look is for                        |
| `headlineZone` | source presets only             | where the scene leaves room for type, from a closed list |
| `aspect`       | source presets only             | the ratio the scene was composed for — a hint, not a set |
| `note`         | four two-ink recipes            | what still has to happen outside the model               |

`note` is the one that is not decoration. The four are two scenes and the two looks that
mirror them — `gn-duotone-landscape`, `gn-halftone-highkey`, `rs-duotone-dither`,
`rs-halftone-highkey` — all authored to be dithered afterwards. The dither is #36 and does
not exist yet, so the note is displayed as an outstanding step: a two-ink reduction nobody
dithered reads as a preset that came out wrong rather than as a preset that is half a
feature. Note they are not one family — the two scenes are `illustration` and the two looks
are `reduction`, so a check that keys on family will miss half of them.

`blurb` is deliberately not carried onto a fork: it is a line about one of ours, and a fork
has its own name and its own text. `headlineZone` and `note` are carried, because they are
facts about the image the prompt describes.

### The post-treatment declaration

`note` says what still has to happen — in English, to a human. The same four recipes also
say it in a form something can read (#53), because #36 would otherwise have to re-derive
four intentions from prose or ask the user to re-enter by hand what the recipe already
said. Two fields, both optional, both `null` on the other forty:

| Field            | Values                                                     | Says                                |
| ---------------- | ---------------------------------------------------------- | ----------------------------------- |
| `ditherKernel`   | `bayer4` `bayer8` `clustered8` `floydSteinberg` `atkinson` | the kernel this recipe **prefers**  |
| `levelPlacement` | `paletteShaped` (what `null` means) or `even`              | how the quantised levels are spaced |

The kernel is a preference and not a lock — two of the four notes offer a choice on purpose
("Atkinson or Floyd-Steinberg"), and the user can still switch. The declaration records the
one each note names first, which is also the one its sibling scene names alone, so the pair
now agree by declaration rather than by accident of prose.

The five kernels are not one flat set to #36: `bayer4`, `bayer8` and `clustered8` are
ordered screens, `floydSteinberg` and `atkinson` are error diffusion, and that partition is
a property of the kernels rather than something each recipe restates.

`levelPlacement` defaults to palette-shaped and is measured rather than picked (#52): even
spacing loses up to 0.22 of mean linear luminance on a four-ink palette, because both
interior steps of an even scale land in the gap the palette has no ink for. `even` stays
reachable — it is the higher-contrast result and what the research describes — but nobody
gets a crush without asking. The knob is inert at N=2 and on every `ramp` palette, so the
default only bites where it helps. None of the four declares one.

**Nothing reads either field yet.** #36 does. They round-trip through a fork the way the
note does, for the same reason: a fork of a two-ink reduction is still a two-ink reduction.

### Template variables

A variant may have holes in it: `{{primary}}`, `{{subject}}`. Note the brace count —
`{single}` slots are the loader's and are always substituted at load, `{{double}}` ones
survive into the prompt box.

Which variables a variant has is **derived from its template**, not declared beside it.
The two can then never disagree, and a fork whose prompt still holds a literal `{{`
stays readable rather than failing the loader over legal prose. What _is_ declared is
`defaults` — the authored per-variable fallback, optional and absent on most recipes.

Resolution happens at **seed** time, in `composePreset`, over the prompt **and** the
negative — both go on the wire, so a hole in either gets a field and both are expanded from
the same values. Only the expanded prose is ever persisted. A recipe that resolved against a library we can still edit would not be a
recipe. Precedence:

1. **What the user typed** into the picker's field.
2. **The project palette**, where the key names a role (`primary`, `ink`, …) or a filled
   extra slot (`extra1`, `extra2`, …). The value is the colour's **name** — see
   [palette.md](./palette.md).
3. **The variant's `defaults` entry**.
4. **Nothing** — the `{{…}}` literal stays visible in the box, and the run button warns
   without blocking (`unresolvedVariables`). `{{` is legal prose in an editable box, so a
   hard block would be too strong; silence would be wrong too, because this is a paid
   click.

Changing a field re-seeds the prompt box, unless the box has been hand-edited — then the
existing re-seed offer appears instead and the user's text stands. The values themselves
are session state in `PresetField`, never on the project: `{{subject}}` varies per look,
and a stale one carried across recipes is a confident wrong answer.

## A preset is a seed, not a filter

Choosing one **pre-fills editable fields**, and what is in the prompt box is exactly what
is sent. Nothing is assembled at submit time. That is a product decision (#28, PRD §6)
with two consequences worth stating:

- The prompt box is where people learn what the prompt language does, so the composed
  string has to be readable by the person about to spend money on it.
- Provenance is not enough on its own. `StageRecipe` records `presetId` **and**
  `presetModified` — at 0.78 strength with two clauses rewritten, the preset is where the
  recipe started, not what it is. It flips only for the fields seeding actually writes
  (see below), on the style stage, with a preset selected: a step count is the model's
  business and moving it says nothing about provenance.

Seeding happens in the reducer (`choosePreset` → `seedFromPreset`), never in a component,
and the preset itself rides on the action: half the library lives in app data behind
TanStack Query, so the reducer must not go looking for it.

## Keyed by prompt idiom, not by model

A preset holds one variant per `PromptStyle` (`prose`, `tags`), picked by the model's
registry `promptStyle`. Adding a model is therefore a registry change, never a walk
through every preset.

`null` and _absent_ mean different things. `null` says "this preset has nothing to say in
that idiom" and is a real answer; absent means nobody wrote it down, and the loader
refuses it. Same for a variant's `negative` and `strength`.

Nothing is ever cross-sent. `composePreset(preset, model, palette, values)` returns `null` when the model's
idiom is one the preset does not speak — a tag list sent to a prose encoder reads as
malformed English (PRD §6.2). The picker disables such a preset with its reason attached
(PRD §10.1), and the reducer seeds nothing if one arrives anyway.

## What seeding fills, and what gates it

| Field    | Gate                                                             |
| -------- | ---------------------------------------------------------------- |
| prompt   | always — the whole composed string, holes expanded               |
| strength | only where the model has a `strengthParam`                       |
| negative | only where the model has a `negativePromptParam`, holes expanded |

A negative is **never** folded into the positive prompt (PRD §9): "no gradients" inside a
positive prompt is a request for gradients. Where there is no field for one it is dropped,
and where the new preset has nothing to subtract the field is cleared rather than left
holding the last preset's negative. Strength comes from the model's registry default
unless the preset overrode it, and an override is clamped to `PRESET_STRENGTH_WINDOW`.

## Switching models

The user's text is kept — always. A re-seed is **offered**, never forced:
`presetSeedState(prompt, preset, model, palette, values)` answers `none`, `seeded`, `unsupported` or
`stale`, and `stale` carries the reason key. It is derived from what is on screen rather
than recorded, so nothing new has to round-trip through the manifest. Taking the offer is
the same `choosePreset` action again.

## The two halves of the library

|              | Built-ins                      | User presets                          |
| ------------ | ------------------------------ | ------------------------------------- |
| Lives in     | the repo, as JSON              | `app_data_dir/presets/`, one per file |
| Loaded by    | `readPresetLibrary`, at import | `readUserPreset`, per file, on demand |
| A bad one is | a startup crash                | skipped, with a visible warning       |
| Editable     | no — read-only                 | update in place, or delete            |

Being app-level rather than per-project is the point: a repo update that rewrites every
built-in cannot touch a fork. The two halves are shown grouped in one picker (`optgroup`),
never merged — one is read-only and the other is not.

Saving captures the form as it stands (`userPresetFrom`) and writes a variant for the
current model's idiom **only**: a save can speak for the model in front of it and no
other. What happens to the other idiom depends on which save it is — `null` for a new
fork, and for an update **the existing variant, verbatim**, which is why
`userPresetFrom` takes the preset being updated as its second argument. A fork that
speaks both idioms is two saves' work, and updating it from one of them must not throw
the other away. Update is refused outright where `presetSeedState` says `unsupported`:
the box then holds text this fork never seeded, so writing it in as the missing idiom
would be putting words in the preset's mouth. The prompt is stored whole with a
`{transform}`-only template,
so a fork is self-contained and carries the preserve wording it was saved with rather than
tracking ours. Ids are slugified from the name and suffixed on collision, because the id
becomes a file name and Rust rejects anything outside `[A-Za-z0-9_-]{1,64}` — see
[tauri-commands.md](./tauri-commands.md).

Each library forks into its **own folder**, so a scene called "Warm" and a look called
"Warm" are two files and neither can shadow the other. Which folder is a `Library` enum in
`presets::store`, never a name crossing the boundary — see
[tauri-commands.md](./tauri-commands.md).

## Adding a built-in

1. Add an entry to `source-presets.json` or `presets.json` with both variants filled in, or
   `null` where the preset genuinely has nothing to say in that idiom.
2. Give every variant a `compose` template that places `{transform}`; add `{preserve}` or
   `{append}` where the library's block should go, and leave it out to opt out — the loader
   substitutes once, at load, and refuses a placeholder the library has no block for.
3. State `negative` and `strength` explicitly, `null` included.
4. On a source preset, name the `aspect` it was composed for; omit it where there is no
   opinion. It must be one of the curated ratios in `aspects.ts`.
5. Name any colour hole after a palette role or an `extraN` slot — `{{brand_color}}` would
   compose as a literal in a paid prompt and never say so. Add `defaults` only for the
   free-text holes worth answering in advance; a default for a hole the template does not
   have is refused at load.
6. Give it a `family` and a `blurb`, and a `headlineZone` on a source preset. Leave a
   one-off value **inlined in the prose** rather than as a hole: a concrete
   "juniper sprigs and dried citrus wheels" teaches what the clause is for and a bare
   `{{botanical}}` teaches nothing. `{{subject}}` is the exception — it is the field the
   user came here to fill.
7. Write a `note` only where the model cannot finish the look on its own. A note is an
   unfinished step; one on a finished look is permanent scaffolding. Where the note names
   a post-treatment, declare a `ditherKernel` beside it so something can read it too.
8. Run the tests. The loader names the preset it could not read.
