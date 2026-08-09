# Model Capability Registry

How the app knows what each generation model supports, and how the UI derives its
behaviour from that. Lives in `src/lib/recipe/` — `registry.ts` (the rules) and
`models.ts` (the rows).

## Why a hand-written registry

fal has no capability-discovery API. What a model accepts is declared by hand, one row
per endpoint, and a wrong row produces a 422 at the paid step with no visual feedback
that anything was mis-declared. Registry entries are correctness, not taste.

Rows are transcribed from `docs/research/model-schemas.md` and `docs/research/models.md`,
which are the recorded reads of the live schemas. **Do not add a field to a row because
another model has it** — read the schema for that endpoint first.

## The three files

| File          | Holds                                                             |
| ------------- | ----------------------------------------------------------------- |
| `registry.ts` | `ModelCapabilities`, the derivation functions, `validateRegistry` |
| `models.ts`   | `MODEL_REGISTRY` — the rows themselves, validated at module load  |
| `request.ts`  | Turns a row plus a draft into a request body                      |

## Deriving UI from a row

No component decides whether a control exists. `controlAvailability(model, control)`
answers with one of three states (PRD §10.1):

- `available`
- `disabled` with a `reasonKey` — a _headline_ feature the model lacks (seed, loop,
  duration). Kept on screen so the tool never looks like it lacks a feature someone
  picked it for.
- `hidden` — plumbing (strength, negative prompt, resolution). Nobody needs to be told
  a model has no negative-prompt field.

`modelAvailability(model, aspect)` answers the same shape for the model itself, so a
model the project's locked ratio rules out is refused at _selection_ time rather than
at submit.

## The aspects union

`AspectSupport` is three variants, not a ratio list, because the field genuinely differs:

- `ratioEnum` — a fixed list, keyed by _our_ `AspectId` and valued by the provider's own
  token (`21:9` on one model, `landscape_16_9` on another). Absent means unsupported.
- `freeDimensions` — any ratio inside numeric `DimensionConstraints`, sent as
  `{width, height}`. `legalSizeFor` walks multiples of the ratio in lowest terms so the
  locked ratio is hit _exactly_; fal snaps rounded sizes and that would break the lock.
- `inheritsFromSource` — no size field at all. Every ratio is servable, nothing is sent.

A row that used a ratio list for the second case would answer "is this compatible"
correctly by accident while discarding everything the request builder needs.

## Parameters a row declares

`declaredParams` is the single source of truth for which API fields a model understands,
and it is used twice: `validateRegistry` refuses a default for an undeclared field, and
`buildRequest` drops a persisted draft param the model has never heard of.

Named columns (`strengthParam`, `durationParam`, …) cover most fields. Anything else —
`generate_audio`, `num_inference_steps` — goes in that row's optional `extraParams`:

```typescript
// ✅ GOOD: opt in per model, from that endpoint's schema
extraParams: ['generate_audio'],
defaults: { generate_audio: false },

// ❌ BAD: a shared whitelist of "extras any model might have"
```

A shared whitelist was the previous shape and it made both checks blind for every name
on it: a `guidance_scale` default on a model with no such field passed validation and
shipped in the body.

## The input image

`imageParam` is the field the source image goes in, and the style stage does not work
without it (#28). It is a read, never a guess, because the endpoints disagree: the FLUX
family takes a single `image_url` string, while Qwen and Nano Banana take an `image_urls`
**array**. The registry records the name; the caller has to honour the shape.

| Stage     | `imageParam`                                                                  |
| --------- | ----------------------------------------------------------------------------- |
| `source`  | always `null` — text-to-image has no input image, and validation says so      |
| `style`   | required — `image_url` or `image_urls`                                        |
| `animate` | required — the start frame: `image_url`, `start_image_url`, `first_frame_url` |

The animate rule arrived with #29 and is the style rule with more money on it: a video
model handed no start frame renders the motion prompt as text-to-video, at up to $0.47 a
second. Three spellings across eight endpoints, all of them a single URL — which is the
registry's whole argument in one column.

`imageParamShape(model)` answers whether that field is a string or an array — on fal the
name is the declaration, so the plural is the array. `validateRegistry` refuses a name the
shape table does not know, which makes a model with a differently-named input a startup
crash that asks for its shape rather than a guess that 422s at the paid step.

The value never comes from the draft: `buildRequest` drops the image field even when a
persisted manifest names it, because what belongs there is a whole image. The frontend
sends the _generation id_ instead, and Rust reads the file and inlines it — see
[external-apis.md](./external-apis.md).

## The end frame

Two separate answers, and a row that conflated them would 422 at the paid step:

- `endFrameParam` — the field's **name**, or `null`. Its presence is what makes looping
  offerable (`controlAvailability(model, 'loop')`).
- `endFrameRequired` — whether the schema makes it **mandatory**. True on
  `blackforestlabs/flux-3/first-last-frame-to-video` and
  `fal-ai/veo3.1/first-last-frame-to-video`, which refuse a submit naming only a start
  frame. Until looping lands (#30) there is no second frame to send, so `blockedReasonKey`
  disables the run with `editor.reason.needsEndFrame` — visible with a reason rather than
  hidden, because these are the rows a seamless loop will want.

`validateRegistry` refuses `endFrameRequired` on a row with no `endFrameParam`: "requires
the field it does not have" is not a state a model can be in.

## Durations

`durations` is stored verbatim as strings; `durationFormat` says what to turn them into,
and the wrong primitive is a 422. All three idioms are live across the eight video
endpoints — `integer` (LTX, FLUX 3), `string` of digits (Seedance, both Klings, each
re-fetched live and verified on **2026-08-09**; see the correction table in
`docs/research/model-schemas.md` §5), `secondsSuffixed` (Veo, Luma) — so this is read per
endpoint, never inferred from a neighbour.

Writing the list out by hand is not the rule; matching the schema is. A contiguous run of
integers may be **generated** — Seedance's `DURATIONS_4_TO_30` is `Array.from`, because
twenty-seven hand-typed strings is twenty-seven chances at a typo — so long as the emitted
strings match the schema's enum members exactly, character for character.

A value the provider offers is not automatically a value the registry offers. Seedance's
enum includes `auto`, which is left out: it hands the length back to the provider (PRD
§6.3) and makes the cost estimate uncomputable before the click (PRD §10.2). The rule is
enforced rather than remembered — `validateRegistry` refuses a duration `durationSeconds`
cannot parse.

## validateRegistry

Runs at module load, so a bad row is a startup crash rather than a 422 later. It covers
the agreements the type system cannot express: unique non-empty ids, `durations` and
`durationFormat` present together, durations that parse, a resolution default that is
actually offered, non-empty ratio tokens, dimension bounds that admit at least one
curated ratio, a dated positive price, no default for an undeclared parameter, an
`imageParam` that matches the stage (present on style and animate, absent on source) and
whose shape is recorded, and no `endFrameRequired` without an `endFrameParam`.

## Adding a model

1. Read the endpoint's schema and record it in `docs/research/model-schemas.md`.
2. Add a row to the right stage array in `models.ts`. Fill every column; use `null` and
   `[]` honestly rather than guessing.
3. Put non-column fields in `extraParams`, and only those the schema names.
4. Set `promptStyle` — it is shown to the user as a hint beside the prompt box, and it
   also picks which preset variant seeds the form (`src/lib/recipe/presets.ts`).
5. Set `imageParam` from the schema's own field name on any stage that takes an input
   image, noting whether the schema wants a string or an array. On animate that is the
   start frame, and its name is not guessable from a neighbour's — read it.
   Set `endFrameRequired` from whether the schema lists the end frame under `required`.
6. Set `price` with `verifiedOn`, or `null` if the endpoint is token-priced. An invented
   number is worse than none, because the dated estimate is what tells the user how much
   to trust it.
7. Run the tests. `validateRegistry` will name the row if it is malformed.

See also [external-apis.md](./external-apis.md) for how the request reaches fal.
