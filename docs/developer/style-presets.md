# Style Presets

How a look reaches the generation form. Lives in `src/lib/recipe/presets.ts` (schema,
loader, compose), `src/lib/recipe/presets.json` (the committed built-ins),
`src/services/presets.ts` (the user's own library) and
`src/components/editor/PresetField.tsx` (the control).

There is a **second, independent library** for movement — see
[motion-presets.md](./motion-presets.md). A recipe picks one of each, and neither knows the
other exists.

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

Nothing is ever cross-sent. `composePreset(preset, model)` returns `null` when the model's
idiom is one the preset does not speak — a tag list sent to a prose encoder reads as
malformed English (PRD §6.2). The picker disables such a preset with its reason attached
(PRD §10.1), and the reducer seeds nothing if one arrives anyway.

## What seeding fills, and what gates it

| Field    | Gate                                             |
| -------- | ------------------------------------------------ |
| prompt   | always — the whole composed string               |
| strength | only where the model has a `strengthParam`       |
| negative | only where the model has a `negativePromptParam` |

A negative is **never** folded into the positive prompt (PRD §9): "no gradients" inside a
positive prompt is a request for gradients. Where there is no field for one it is dropped,
and where the new preset has nothing to subtract the field is cleared rather than left
holding the last preset's negative. Strength comes from the model's registry default
unless the preset overrode it, and an override is clamped to `PRESET_STRENGTH_WINDOW`.

## Switching models

The user's text is kept — always. A re-seed is **offered**, never forced:
`presetSeedState(prompt, preset, model)` answers `none`, `seeded`, `unsupported` or
`stale`, and `stale` carries the reason key. It is derived from what is on screen rather
than recorded, so nothing new has to round-trip through the manifest. Taking the offer is
the same `choosePreset` action again.

## The two halves of the library

|              | Built-ins                      | User presets                          |
| ------------ | ------------------------------ | ------------------------------------- |
| Lives in     | `presets.json`, in the repo    | `app_data_dir/presets/*.json`         |
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

## Adding a built-in

1. Add an entry to `presets.json` with both variants filled in, or `null` where the look
   genuinely has nothing to say in that idiom.
2. Give every variant a `compose` template that places `{transform}`; use `{preserve}`
   where the preserve block should go — the loader substitutes it once, at load.
3. State `negative` and `strength` explicitly, `null` included.
4. Run the tests. The loader names the preset it could not read.
