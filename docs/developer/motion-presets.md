# Motion Presets

The second preset library — how a _movement_ reaches the animate form. Lives in
`src/lib/recipe/motion.ts` (schema and loader), `src/lib/recipe/motion-presets.json` (the
committed built-ins), `src/services/motion.ts` (the user's own) and the `MotionPresetField`
half of `src/components/editor/PresetField.tsx`.

Read [style-presets.md](./style-presets.md) first. Everything it says about presets being
seeds, about the two halves of a library, and about forks living in app data applies here
unchanged. This page is only about the differences.

## Two libraries, because look and movement are orthogonal

A recipe picks one style preset and one motion preset. Drifting clouds is worth having over
a glass monolith and over a sun-bleached beach, so a combined library would be every look
times every movement — and every new look would mean re-writing every movement.

They are independent all the way down: separate JSON, separate loaders, separate commands,
separate folders in app data. An id may exist in both and mean two different things.

## A deliberately smaller schema

```json
{ "version": 1, "presets": [{ "id": "…", "name": "…", "prompt": "…" }] }
```

| Style presets have         | Motion presets do not, because                            |
| -------------------------- | --------------------------------------------------------- |
| per-`promptStyle` variants | all eight video endpoints read prose; there is one idiom  |
| a `compose` template       | there is nothing to assemble — the preset _is_ the prompt |
| a library-level `preserve` | the still already holds the composition                   |
| `strength`                 | no video model surveyed has a strength field              |
| `negative`                 | only Veo has `negative_prompt` — see below                |
| a `family`                 | grouping eight movements adds a column and no information |

Consequences worth stating: no motion preset is ever `unsupported`, so nothing in the
picker is ever disabled; seeding writes the **prompt and nothing else**, so duration,
resolution and the loop/rewind options survive a change of movement; and an update in place
cannot destroy an idiom it was not saved from, because there is only one.

## Camera negations live in the prompt text

Seven of the eight video endpoints have no `negative_prompt`, so a negation that is not in
the prompt is not sent at all. Every built-in therefore ends with `no pan, no zoom, no
dolly, no camera shake` — which is how the ticket's "subtle ambient movement rather than
dramatic camera moves" is actually enforced, and it is asserted in `motion.test.ts` rather
than left to whoever edits the JSON next.

This is `docs/research/preset-schema.md` §4's own practical rule; the eight built-ins are
that section's eight fragments restated as whole prompts.

## Where the user's own live

`app_data_dir/presets/motion/*.json`, one file per preset — nested inside `presets/` and
skipped by the style library's listing, which only ever reads files. `presets::store` takes
the folder as a parameter rather than being duplicated: everything else about the two
libraries on disk is identical, and a second copy of that module would be a second place to
forget a path-traversal fix.

Commands mirror the style family one for one: `motion_presets_list`, `motion_preset_save`,
`motion_preset_delete`. Six commands rather than three taking a library name, because a
name crossing the boundary is a _folder_ crossing the boundary — `validate_id` guards the
file name, not the directory.

## Adding a built-in

1. Add `{ id, name, prompt }` to `motion-presets.json`. The id has to match
   `[A-Za-z0-9_-]{1,64}`; it may become a file name when somebody forks it.
2. Name one continuous movement, ask for a seamless loop, and spell out the camera
   negations. Do not describe the subject — the still already has one.
3. Run the tests. The loader names the preset it could not read, and a malformed built-in
   is a startup crash rather than a paid clip that says less than it meant to.
