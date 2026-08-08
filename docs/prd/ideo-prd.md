# Ideo — Umbrella PRD

> Status: **approved design; verification spike complete, no feature code yet**
> Last updated: 2026-08-08
> This is the umbrella spec. Work is tracked as GitHub issues under
> [#11](https://github.com/michaelwilhelmsen/ideo/issues/11) — see §13.
> Facts marked verified in §12 were checked against the live fal API on 2026-08-08;
> everything still marked open should be treated as unverified.

## 1. Purpose

Ideo is a local-only macOS desktop app for producing **landing-page hero visuals** —
image and video, no text or copy. It replaces an ad-hoc workflow of prompting a
model in a browser, hand-editing the result, and separately encoding a video that
is small enough to actually ship on a web page.

Three stages, each a model call:

1. **Source** — generate an image from a prompt, or upload one.
2. **Style** — apply a look via a preset prompt recipe (image-to-image restyle).
3. **Animate** — turn the still into a short, subtly moving, seamless loop.

Then export web-ready assets (MP4 + WebM + poster frame).

### Why the recipe matters more than the file

The expensive artefact is not the output image — it is the **combination** of prompt,
style preset, model, parameters and seed that finally looked right. Rediscovering it
means paying for generation again. Ideo persists that combination as a re-runnable
recipe. This premise drives most decisions below (persistence, seed pinning,
per-generation model recording).

## 2. Users and constraints

- **Users**: a small internal team. Not a single-user tool, but not a product either.
- **Local only.** No servers, no proxy, no shared backend, no hosted state.
- **Per-user API keys.** Each person supplies their own fal.ai key, stored in their
  own macOS Keychain. Cost lands on the individual's own fal account.
- **macOS only** in practice, though the template is cross-platform.

### Non-goals

- Text, copy, or typography in the generated visual.
- Any form of team sync, sharing service, or multi-user state.
- Cumulative spend tracking (fal's own dashboard already does this).
- Arbitrary user-supplied model IDs (see §5).
- Midjourney support — see §9.

## 3. Architecture

### 3.1 Where code lives

All authenticated API calls happen in **Rust via `reqwest`**, never in the webview.
This is the pattern already prescribed by
[`docs/developer/external-apis.md`](../developer/external-apis.md), and it gives three
things: the API key never enters JavaScript, CORS is irrelevant, and fal's
queue-based long-running jobs are far easier to model as a Rust command emitting
Tauri events than as fetch-in-a-hook.

```
React component → TanStack Query → tauri-specta command → reqwest → fal.ai
```

### 3.2 Data: disk authoritative, SQLite as index

Projects persist. Storage is **hybrid**:

- **Files on disk**, one folder per project, containing all generated assets and a
  `project.json` manifest describing the full recipe.
- **SQLite** (`rusqlite`, `bundled` feature) as a queryable **index**, written
  alongside the manifest.

**Disk is the source of truth.** The database is rebuildable by rescanning project
folders. The reason: a corrupted or deleted DB must be a non-event rather than the
loss of every recipe, and Finder-inspectable output is genuinely useful for an
internal design tool. Cost is writing the manifest twice, which is cheap.

`rusqlite` over `sqlx` because the queries are trivial (list, load, upsert) and the
actual async work is HTTP, not SQL. Compile-time SQL checking would mean a dev-time
database and migration tooling for roughly six queries.

### 3.3 Job execution

fal's queue API is submit → poll → fetch result. Consequently:

- **`request_id` is persisted to SQLite immediately on submit.** The user is charged
  the moment a job is accepted, so abandoning it on app quit throws money away.
  On relaunch, unfinished jobs resume polling.
- **Polling, not SSE.** ~2s interval with backoff. Progress granularity on a
  30-second job does not justify streaming HTTP and its reconnection edge cases —
  and a resumed job uses the identical code path as a fresh one, whereas a resumed
  SSE stream is a special case.
- **Concurrency limit 2–3.** A 4-up image batch is already 4 concurrent calls.
- **Cancellation is exposed** (`PUT /requests/{id}/cancel`). The UI must not promise
  a refund — cancelling may or may not prevent the charge depending on job progress.

## 4. The three stages

### 4.1 Stage independence

The stages are **independently re-runnable**, not a forward-only wizard. You can swap
the style on an existing source without regenerating the source, or re-roll the video
on an approved still. A wizard would force paying for a new source image every time
you wanted a different style — backwards, since the source is the expensive part and
the style is what gets iterated ten times.

**Video is optional.** Export is available at every stage; plenty of heroes are stills,
and animation is the slowest and most expensive call.

### 4.2 Batching

Configurable, defaulting to **4 images / 1 video**. Picking from four beats serial
re-rolling and image calls are cheap; video is expensive enough per clip that a 4-up
would genuinely hurt.

### 4.3 Seeds

Every generation **records its seed**, and the seed can be **pinned**. Without pinning,
changing a style fragment also re-rolls the composition, so you can never tell which
change caused which difference. Pinned seeds are also what make a persisted recipe
genuinely re-runnable rather than approximately re-runnable.

### 4.4 Aspect ratio

**Locked at project creation**, inherited by all stages, chosen from a **curated list
validated end-to-end** (16:9, 21:9, 2:1, 3:2, square), with each entry marked for
whether animation is possible at that ratio.

This is load-bearing. Video models are far pickier about dimensions than image models,
and a ratio the video model rejects would fail at the **last and most expensive step**.
Validating once at creation is the cheapest place to catch it. Automatic cropping to
satisfy an API limit is explicitly rejected — silently altering the user's composition
produces confusing output.

### 4.5 Looping

**Optional, and capability-gated** — the control only appears for models that support it.

- **Default: native end-frame conditioning.** Set the model's end-frame parameter to
  the same image as the start frame; the model generates motion that returns to where
  it began. One API call, genuinely seamless.
- **Option: rewind (ping-pong).** Play forward then reverse via ffmpeg. Always
  seamless, but reads wrong for directional motion (falling, flowing). Costs almost
  nothing to offer since ffmpeg is in the stack anyway.

Both are user-selectable rather than us guessing which reads better.

## 5. Model capability registry

A **hand-maintained JSON file committed to the repo** declaring what each model
supports. fal has no capability-discovery API — nothing will tell us "this model
supports end frames."

The UI **derives from this registry** rather than hardcoding controls. Per model:

| Field                    | Purpose                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `id`                     | Provider's model/endpoint identifier                                              |
| `provider`               | `fal` for v1; field exists so a second provider is additive                       |
| `stage`                  | `image` \| `restyle` \| `video`                                                   |
| `promptStyle`            | `prose` \| `tags` — selects which preset variant to use                           |
| `supportsNegativePrompt` | Whether a negative prompt field is sent at all                                    |
| `supportsSeed`           | Gates seed recording/pinning UI                                                   |
| `strengthParam`          | **The actual API field name**, or null                                            |
| `aspect`                 | `{minRatio, maxRatio, allowedPresets, allowsCustomWidthHeight, maxResolution}`    |
| `durations`              | Allowed duration values (video) — **verbatim**, since formats differ              |
| `durationFormat`         | `string` \| `secondsSuffixed` \| `integer` — see §9.1; four models, three formats |
| `endFrameParam`          | Field name, or null — **gates whether the loop option appears**                   |
| `aspectParam`            | Field name, or null when aspect is inherited from the source image                |
| `resolutionParam`        | Field name + allowed values; needed because some models default low               |
| `defaults`               | Our chosen defaults, **not** the API's — see §6.3                                 |
| `price`                  | `{unit, amount, verifiedOn}`                                                      |
| `notes`                  | Free text, including known-unverified caveats                                     |

Two fields exist purely because of things the spike caught:

- **`defaults` is ours, not theirs.** `flux-1/dev/image-to-image` defaults `strength` to
  0.95, which discards the input entirely (§6.3); Luma Ray 2 defaults `resolution` to
  540p, too low for a hero. Inheriting API defaults produces bad output at no lower
  cost, so every default we send is a deliberate choice recorded here.
- **`durationFormat` avoids a whole class of 422s.** Duration is a bare string on Kling,
  a second-suffixed string on Luma and Veo, and an integer on Vidu. Sending the wrong
  primitive fails the request.

Three fields earn their keep: `promptStyle` (which preset variant), `endFrameParam`
(whether looping is even offered), and `strengthParam` — because it is named
differently across models **and carries wildly different defaults** (0.95 on
`flux-1/dev/image-to-image` versus 0.1 on FLUX Kontext, a 9.5× difference for the
same-named concept). Hardcoding either would break on the second model.

Registry entries are **correctness**, not taste: a wrong capability produces confusing
API failures with no visual feedback that you got it wrong. So they live in the repo
where a PR reviews them, and are **not** user-extendable — unlike style presets.

**No arbitrary model IDs in v1.** Without a capability entry we cannot build the right
request or the right UI, so an arbitrary ID would mostly produce API errors that look
like app bugs. The escape hatch is adding a registry entry, which is a small PR.

The field list above must be **validated against real fal schemas** before being
frozen — see E0.

### 5.1 Provider abstraction

v1 ships **fal only**, with the `provider` field present but single-valued. The
abstraction exists so a second provider is additive rather than a refactor. Note that
a non-fal provider may be **synchronous** (OpenAI's image endpoints return directly)
rather than fal's submit-poll queue, so the job layer must tolerate both shapes.

## 6. Preset libraries

**Two independent libraries**, mixed freely:

- **Style presets** — the look of the still.
- **Motion presets** — how the video moves.

Independent because look and movement are orthogonal: any style might want slow drift
or gentle pulse. Coupling them would duplicate every motion across every style.

Both get the same treatment: **built-in presets as version-controlled JSON in the
repo**, plus **fork-to-customize** stored per-user in app data. Forking is how people
learn what the prompt language does, and it means a user's edits never conflict with a
repo update to the built-ins. A later "export as JSON" path lets a good custom preset
be PR'd into the built-in set.

### 6.1 Keyed by prompt style, not by model

A preset carries a **`prose` variant and a `tags` variant**, and the registry's
`promptStyle` decides which is used. Model-keyed variants would mean editing every
preset each time a model is added — exactly the maintenance trap the registry exists
to avoid.

Each variant carries its own compose-template string, so prompt-assembly ordering
lives in preset data rather than hardcoded in app code. Adding a model family becomes
a data change.

### 6.2 Known problem: the drafted presets are in the wrong idiom

22 style presets are drafted in
[`docs/research/style-presets.md`](../research/style-presets.md), all written as
**comma-separated tag lists** — SDXL idiom. Research indicates FLUX prefers **prose**,
with style woven into the same sentence as the subject, because its text encoder is
prose-trained and reads tag-lists as malformed. If that holds, all 22 need
reformulating into prose.

**Tested 2026-08-08 — and the rewrite is off.** Same subject, same seed, both idioms,
on `flux-pro/v1.1`. Prose was **not** better: the tag-list output carried slightly more
texture and contrast, while the prose version came out smoother — i.e. further from
what was asked. Keep the drafted tag-list presets.

**A different problem surfaced instead: neither output showed visible film grain.**
The grain / ISO-3200 / halation language barely registered in either idiom. So the
film-grain preset family is unreliable on this model regardless of phrasing, and the
same may apply to other texture-led styles. Worth probing per style family before
shipping a library where grain is a headline look — possibly by applying grain at
export instead of asking the model for it.

Caveat on scope: one prompt, one model, one seed. Enough to refute "prose is clearly
better", not enough to characterise every style family.

### 6.3 Restyle prompting

When composition comes from the input image, the prompt should **foreground style
rather than restate the subject**.

**Measured on `flux-1/dev/image-to-image`, 2026-08-08** — same source, prompt and seed,
sweeping `strength`:

| Value    | Result                                                     |
| -------- | ---------------------------------------------------------- |
| 0.3      | source returned essentially unchanged; no style            |
| 0.5      | negligible style; composition intact                       |
| **0.65** | style clearly visible; composition intact                  |
| **0.75** | style stronger; composition still intact                   |
| 0.85     | strong style, but composition drifts — reframed and zoomed |
| **0.95** | **input discarded entirely — returned an unrelated image** |

0.95 is **fal's own documented default**, and it does not restyle at all; it generates
from scratch. Their note that "higher strength values are better for this model" is
actively misleading for composition-preserving work.

Consequences:

- **Never inherit the API default.** Ship **0.7** as the default, with a UI range of
  roughly 0.5–0.85 and a warning above that.
- Store this per model in the registry, not as a constant — Kontext defaults to 0.1,
  so the same field means something different from model to model.
- The usable window is **narrow** (~0.65–0.8). Below it nothing happens; above it the
  image is gone. That narrowness is itself a reason to expose the control rather than
  hide it.

## 7. Keys and onboarding

- Key stored per-user in the **macOS Keychain** via the `keyring` crate. Never in
  preferences JSON, never in the webview.
- **Validated at onboarding and in Settings, free of charge.** A key that looks fine
  and fails 30 seconds into an expensive job is the exact failure onboarding exists to
  prevent. A **format-only check is explicitly rejected** — passing a revoked key tells
  the user something false.

  **Verified 2026-08-08:** `GET https://rest.alpha.fal.ai/billing/user_balance` returns
  `200` and a bare number (e.g. `9.9416`) for a valid key, and `401` for a bad,
  malformed, or absent one. No charge, no special key scope needed. Note the
  **underscore** — the hyphenated `user-balance` returns 404.

  Two bonuses from the same endpoint: it doubles as a **cost meter** (read the balance
  before and after a job to get the real price, allowing for a few minutes' billing
  lag), and it gives us a **low-balance warning** before an expensive video call fails
  for lack of funds.

  A key is 69 characters, `uuid:hex32`. Do not validate on that shape alone.

- **Blocking behaviour**: browsing is allowed without a key; the first _generate_
  requires one.
- **Onboarding is a replayable modal** over the main UI, driven by a declarative step
  array so adding a step later is one entry rather than new routing. Completion is
  stored as a **version integer, not a boolean**, so a future added step can re-prompt
  existing users.

## 8. Export

Raw model output is typically far too heavy for a landing page. Export produces
**MP4 + WebM + poster JPEG** at sane bitrates, plus the ping-pong concat when rewind
looping is selected.

**v1 uses system ffmpeg**: detected at startup, with a `brew install ffmpeg` prompt if
missing. Bundling a static binary would mean vendoring, licensing (GPL), signing and
notarisation — days of work for an internal tool whose users are all developers on
Macs. The export code sits behind an abstraction that does not care which ffmpeg it
talks to, so bundling later is a contained change if this ever ships externally.

## 9. Model shortlist

Verification strength matters more than benchmark scores here, because an unverified
capability becomes a runtime failure at the most expensive step.

**Every capability claim below was read from fal's live per-endpoint OpenAPI document on
2026-08-09** — see `docs/research/model-schemas.md` for the full field, 33 endpoints, and
the raw constraints. Prices are fal's published rates of the same date, not a billing
check.

Two framing corrections from that round:

- **Aspect ratio is a tiebreaker, not a filter.** `image_size` accepts an explicit
  `{width, height}` as well as a preset token, so four image models reach 21:9 exactly
  (`gpt-image-2` at 2688×1152, `flux-2-pro` at 2352×1008, `qwen-image-2` at 1960×840,
  `flux-pro/v1.1` at 2520×1080). Enum-locked models still crop to a hero from 16:9 or
  2:1. Ratio genuinely constrains only the **animate** stage, where no model accepts
  dimensions.
- **`seed` absence is the firm disqualifier**, not ratio. Without it §4.3's recipe premise
  does not hold — the artefact you paid to rediscover cannot be pinned.

### Provisional defaults

**Chosen 2026-08-09, provisionally, to unblock building.** Visual quality is what should
decide this and no schema encodes it, so these stand until the app can generate and the
output can be judged by eye. Both were verified against their live schemas before being
written here.

| Stage   | Default                                 | Why                                                                                                                                |
| ------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Source  | `fal-ai/flux/schnell`                   | $0.003/MP — ~13× cheaper than the next option. Has `seed`, and `image_size` takes explicit `{width, height}`, so 21:9 is reachable |
| Animate | `bytedance/seedance-2.5/image-to-video` | Has `end_image_url`, so the §4.5 loop premise holds; aspect inherits from the source, so no ratio ceiling                          |

Four things about these defaults that the code has to account for:

- **`seedance-2.5` has no `seed`.** §4.3's recipe premise does **not** hold on the animate
  stage under this default — a clip cannot be re-run to the same output. Per §10.1 that
  surfaces as a _disabled_ seed control with a reason, not a hidden one. Kling O1 has the
  same gap; Veo 3.1 is the only end-frame model surveyed that has `seed`.
- **`seedance-2.5` is the most expensive animate option surveyed** — $0.4730/s at 720p, so
  **$2.36 for a 5s clip**, against $0.56 for Kling O1, $0.85 for flux-3 and $1.00 for Veo
  3.1. Fine as a quality-first default; expensive as a default to develop against.
- **`generate_audio` defaults to `true`** on `seedance-2.5`. A hero loop is silent, so this
  should be set `false` explicitly — it is billed and unwanted.
- **`seedance-2.5` caps at 720p** (`480p`/`720p` only). No 1080p, which is worth knowing for
  a hero visual before §4 settles export resolution. Its `duration` enum also stops at
  `16` while its own description claims "4 to 30 seconds" — trust the enum.

`fal-ai/flux/schnell` is a 4-step distilled model (`num_inference_steps` defaults to 4).
Fast and near-free, which is what makes it a good default to build against, but it is not
the quality tier the shortlist below is drawn from — expect to replace it after testing.

What follows is the verified field to choose from when that testing happens.

| Stage   | Candidate                               | `seed` | `negative_prompt` | Ratio control                        | Price        |
| ------- | --------------------------------------- | ------ | ----------------- | ------------------------------------ | ------------ |
| Source  | `fal-ai/flux-pro/kontext/text-to-image` | yes    | no                | enum, incl. 21:9/9:21                | $0.04/image  |
| Source  | `fal-ai/nano-banana-pro`                | yes    | no                | enum, 11 ratios incl. 21:9           | $0.15/image  |
| Source  | `fal-ai/nano-banana-2`                  | yes    | no                | enum, 15 ratios incl. 21:9, 4:1, 8:1 | $0.08/image  |
| Source  | `fal-ai/qwen-image-2/text-to-image`     | yes    | **yes**           | free dims, 0.26–4.19 MP              | $0.035/image |
| Source  | `openai/gpt-image-2`                    | **no** | no                | free dims, ×16, ≤3:1, ≤8.29 MP       | token-priced |
| Source  | `xai/grok-imagine-image`                | **no** | no                | enum, widest 2:1 / 20:9              | $0.02/image  |
| Restyle | `fal-ai/nano-banana-pro/edit`           | yes    | no                | enum incl. 21:9                      | $0.15/image  |
| Restyle | `fal-ai/qwen-image-2/edit`              | yes    | **yes**           | free dims, 0.26–4.19 MP              | $0.035/image |
| Restyle | `fal-ai/flux-pro/kontext`               | yes    | no                | enum incl. 21:9                      | $0.04/image  |
| Animate | see §9.1                                |        |                   |                                      |              |

**Correction: no FLUX Kontext variant has a `strength` parameter.** Earlier drafts of this
table claimed one, documented at default 0.1, on both the text-to-image and restyle rows.
The field does not exist on `flux-pro/kontext`, `kontext/max` or `flux-kontext/dev` — all
three are instruction-driven edits. Across all 33 endpoints surveyed, exactly one exposes a
strength field: `fal-ai/flux/dev/image-to-image`, and its schema default is **0.95**, which
discards the input almost entirely (§6.3).

`Qwen-Image 2.0` remains the `tags` exemplar that justifies the two-variant preset schema —
it has a real `negative_prompt`, and it is now also the cheapest edit endpoint surveyed with
free dimensions. All 44 recipes in the v4 preset library carry a `negative`, so on any model
without the field that instruction has to fold into the prompt body.

### 9.1 Ultrawide video: risk refuted, two options confirmed

Originally flagged as a single point of failure. **Resolved 2026-08-08** by reading live
schemas — there are two ultrawide-capable loop models, and **Luma Ray 2 is arguably the
better primary**:

| Model          | End-frame param      | Duration             | Ultrawide                         | Notes                                                                          |
| -------------- | -------------------- | -------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| **Luma Ray 2** | `end_image_url`      | `"5s"`, `"9s"`       | **explicit `21:9` + `9:21` enum** | also `resolution` 540p/720p/1080p — **defaults to 540p**, must be overridden   |
| **Kling O1**   | `end_image_url`      | integers `3`–`10`    | inherits from `start_image_url`   | no aspect, resolution or **seed** param at all → video is **not reproducible** |
| Veo 3.1        | **`last_frame_url`** | `"4s"`,`"6s"`,`"8s"` | no — `auto`/16:9/9:16             | has `seed`                                                                     |
| Wan FLF2V      | `end_image_url`      | —                    | no — adds 1:1 only                | has `seed`                                                                     |
| Vidu Q2        | `end_image_url`      | **integers `2`–`8`** | no                                | has `seed`                                                                     |

Luma gives explicit aspect control where Kling only inherits it from the source, which
fits the locked-aspect design in §4.4 far better — but it defaults to 540p and offers only
5s and 9s.

**Two amendments from the 2026-08-09 schema round:**

- **A third ultrawide option:** `blackforestlabs/flux-3/first-last-frame-to-video` declares
  `21:9` _and_ `2:1`, runs 5–20s, and costs $0.17/s at 720p. Note `end_image_url` is
  **required** on it, so it is a loop-only endpoint and cannot serve a non-looping animate.
- **Veo 3.1 is not disqualified by its 16:9 ceiling.** It is the only end-frame model with
  both `seed` and `negative_prompt`, so it is the only one on which the animate stage is
  reproducible at all. A 16:9 clip crops to a usable hero. Weigh that against ultrawide
  rather than treating aspect as a gate.

Kling O1's duration was previously recorded three contradictory ways; the schema gives one,
an integer enum `3`–`10` defaulting to `5`. The claimed aspect range of 0.40–2.50 is **not
in the schema** — Kling O1 has no aspect parameter, so nothing bounds the ratio but the
input image. Vidu Q2 was not re-verified in this round and its row remains unconfirmed.

**This table is the empirical case for the registry (§5).** The same concept is named
`end_image_url` on four models and `last_frame_url` on a fifth; duration appears as
bare strings, second-suffixed strings, and integers. Seed support is inconsistent. No
generic UI could guess any of this — it has to be declared per model.

### 9.2 Midjourney is excluded

No self-serve API as of August 2026 — the official API is Enterprise-application only,
and every third-party "Midjourney API" automates Discord in violation of their terms.
Not a compliance risk worth building into an internal tool.

## 10. UI

Uses the template's existing layout components rather than new chrome:

- **Left sidebar** — project list. A persistent list supports the "swap the style on
  this old hero" workflow better than a gallery you must navigate out of.
- **Main** — the three-stage editor for the active project.
- **Right sidebar** — parameters and presets for the selected stage.
- **Command palette** — New project, Regenerate, Export.

**Model selection is per generation**, not per project, and is recorded in the recipe.
This enables drafting on a cheap model and re-running the winner on an expensive one —
valuable when video costs real money. Selection is validated against the project's
locked aspect ratio at **selection** time, not submit time.

### 10.1 Missing capabilities

- **Headline features** (loop, rewind, duration) → shown **disabled with a reason**
  ("Looping requires a model with end-frame support"). Hiding them makes the tool look
  like it lacks the feature someone chose it for.
- **Plumbing** (`strength`, guidance) → **hidden** when irrelevant. Nobody needs to be
  told a model has no negative-prompt field.
- **Never** auto-switch the user's model when they toggle a control. Helpfulness that
  spends money is not helpful.

### 10.2 Cost display

Show a **per-action estimate before expensive calls**, labelled approximate with the
`verifiedOn` date — e.g. "~$0.55 for 5s (price checked 2026-08-08)". A rough number
beats silence when someone is deciding whether to spend money, and the date makes
staleness visible instead of implying precision we do not have. **Never present an
unverified price as exact.** No cumulative spend tracking.

### 10.3 Asset retention

Keep everything, including rejected candidates; surface **per-project size** and offer
a deliberate **"clean up unused assets"** action. Auto-deleting discards is wrong
because "actually the second one was better" happens constantly and re-rolling costs
money — but unbounded video growth on a laptop needs a visible pressure valve.

### 10.4 Strings

English only, but **all UI strings go through `t()`** with English-only locale files,
per the template's i18n conventions. Near-zero cost while writing components, and
fighting the house pattern costs more than following it.

## 11. Global vs per-project settings

Split by **whether changing it should affect existing projects**:

- **Seeded from globals at project creation, then owned by the project**: aspect ratio,
  batch sizes. Changing a default later must **not** mutate old projects — so creation
  _copies_ defaults rather than referencing them.
- **Genuinely app-wide**: concurrency limit, ffmpeg path, export folder.

## 12. Known-unverified facts

Rows are answered in place, never deleted — the table is the honest record of what
was assumed and what was checked. **Verified against the live API on 2026-08-08**
(E0 spike, total spend $0.23).

| Unknown                                                      | Status                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free key validation                                          | **RESOLVED.** `GET https://rest.alpha.fal.ai/billing/user_balance` → `200` + bare number with a valid key; `401` for bad, malformed, or absent. Free. Note the **underscore** — the hyphenated variant 404s.                                                                          |
| Real pricing                                                 | **MEASURED** by balance delta: `flux-pro/v1.1` **$0.04**/image and `flux-1/dev/image-to-image` **$0.025**/image at 0.90 MP. Billing lags a few minutes, so read the balance twice. Video prices still unmeasured.                                                                     |
| **Kling O1 duration** (three contradictory research answers) | **RESOLVED.** Enum `"3"`–`"10"`, default `"5"` — **strings, not integers**.                                                                                                                                                                                                           |
| Whether FLUX prefers prose over tag-lists                    | **RESOLVED — no rewrite.** See §6.2.                                                                                                                                                                                                                                                  |
| Correct `strength` range                                     | **RESOLVED.** See §6.3. fal's own default of 0.95 destroys the input.                                                                                                                                                                                                                 |
| Whether any video model other than Kling O1 supports 21:9    | **RESOLVED — yes.** Luma Ray 2 has an explicit `aspect_ratio` enum containing `21:9` and `9:21`, plus `end_image_url`. §9.1's risk is refuted.                                                                                                                                        |
| Key format                                                   | **RESOLVED.** 69 chars, `uuid:hex32`.                                                                                                                                                                                                                                                 |
| Queue URL construction                                       | **RESOLVED — do not construct.** Submit returns `status_url` / `response_url` / `cancel_url`, and they drop the version sub-path (`fal-ai/flux-pro/requests/...`, not `.../flux-pro/v1.1/requests/...`). Constructing the versioned form returns `405`. Always use the returned URLs. |
| Requested dimensions honoured?                               | **NO.** 1280×720 came back as 1280×704 — height snapped to a multiple of 16, changing the aspect from 1.78 to 1.82. Validation must tolerate adjustment; do not assume exact output dimensions.                                                                                       |
| REST file-upload flow                                        | **STILL OPEN.** Sidestepped in the spike by reusing fal-hosted result URLs as img2img input, which works and is free. Needs testing before local uploads (#27) ship.                                                                                                                  |
| fal rate limits                                              | **STILL OPEN.** Untested. Client-side backoff needed regardless.                                                                                                                                                                                                                      |
| Whether gpt-image-2 is reachable via fal                     | **STILL OPEN.** Untested.                                                                                                                                                                                                                                                             |

## 13. Work breakdown

Tracked as GitHub issues under umbrella
[#11](https://github.com/michaelwilhelmsen/ideo/issues/11), as **tracer-bullet vertical
slices** — each cuts a complete path through every layer and is demoable on its own.
Dependencies arrive with the first slice that needs them rather than in a foundations
ticket. Blocking edges use GitHub's native issue dependencies, so the frontier is
queryable rather than described here.

| Issue   | Slice                                                               | Blocked by    |
| ------- | ------------------------------------------------------------------- | ------------- |
| ~~#20~~ | ~~Verify fal.ai facts with a real key~~ — **done, results in §12**  | —             |
| #21     | Enter, store and validate a fal API key                             | #20           |
| #22     | Generate one image from a prompt and see it — **the tracer bullet** | #21           |
| #23     | Save a generation as a project you can reopen                       | #22           |
| #24     | Jobs survive quit, and can be cancelled                             | #23           |
| #25     | Pick a model; controls follow its capabilities                      | #20, #22      |
| #26     | Generate four candidates and pick one                               | #23, #25      |
| #27     | Upload your own image as the source                                 | #23           |
| #28     | Apply a style preset to an image                                    | #20, #25, #27 |
| #29     | Animate a still into a clip                                         | #25, #28      |
| #30     | Make the clip loop seamlessly                                       | #29           |
| #31     | Export web-ready files                                              | #29           |
| #32     | Onboarding walks a new user to their first key                      | #21           |

An earlier horizontal breakdown (E0–E9 epics, issues #1–#10) was closed as superseded:
slicing by layer meant nothing was demoable until several tickets landed together.

## Appendix — research sources

Raw notes, with per-claim `[CONFIRMED]`/`[UNVERIFIED]` markers, in
[`docs/research/`](../research/):

| File               | Contents                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `models.md`        | fal queue mechanics, auth, Kling O1 params, FLUX img2img          |
| `models-gaps.md`   | Pricing gaps, key validation, REST upload, rate limits            |
| `style-presets.md` | 22 drafted style presets (tag-list idiom)                         |
| `preset-schema.md` | Variant schema, composition order, motion fragments               |
| `model-catalog.md` | Model/provider survey, capability matrix, video ultrawide support |

Two notes on these files: they are written in Norwegian, and several claims are marked
unverified. Committed docs going forward are English — these will be translated as
their contents are distilled into implementation docs.
