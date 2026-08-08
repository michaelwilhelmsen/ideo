# Ideo — Umbrella PRD

> Status: **approved design, not yet implemented**
> Last updated: 2026-08-08
> This is the umbrella spec. Each epic (E0–E9) below becomes its own task doc in
> `docs/tasks-todo/`. Nothing here should be implemented ahead of E0, which
> settles facts several other epics depend on.

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

| Field | Purpose |
|---|---|
| `id` | Provider's model/endpoint identifier |
| `provider` | `fal` for v1; field exists so a second provider is additive |
| `stage` | `image` \| `restyle` \| `video` |
| `promptStyle` | `prose` \| `tags` — selects which preset variant to use |
| `supportsNegativePrompt` | Whether a negative prompt field is sent at all |
| `supportsSeed` | Gates seed recording/pinning UI |
| `strengthParam` | **The actual API field name**, or null |
| `aspect` | `{minRatio, maxRatio, allowedPresets, allowsCustomWidthHeight, maxResolution}` |
| `durations` | Allowed duration values (video) |
| `endFrameParam` | Field name, or null — **gates whether the loop option appears** |
| `price` | `{unit, amount, verifiedOn}` |
| `notes` | Free text, including known-unverified caveats |

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

**This is not confirmed** — the Black Forest Labs primary guide 404'd; the finding
rests on consistent secondary sources. E0 verifies it against a real generation before
we commit to 22 rewrites.

### 6.3 Restyle prompting

When composition comes from the input image, the prompt should **foreground style
rather than restate the subject**. The correct `strength` range for
composition-preserving restyle is **unresolved**: fal documents 0.95 as the default for
`flux-1/dev/image-to-image` with a note that "higher is better for this model", which
is inverted relative to classic SD intuition (~0.4–0.6). Research suggests defaulting
around 0.5–0.65, explicitly as inference. E0 settles this empirically — the entire
style stage depends on it.

## 7. Keys and onboarding

- Key stored per-user in the **macOS Keychain** via the `keyring` crate. Never in
  preferences JSON, never in the webview.
- **Validated at onboarding and in Settings.** A key that looks fine and fails 30
  seconds into an expensive job is the exact failure onboarding exists to prevent.
  Prefer a free authenticated endpoint; if none exists, use the cheapest possible real
  generation call. A **format-only check is explicitly rejected** — passing a revoked
  key tells the user something false.
- **Blocking behaviour**: browsing is allowed without a key; the first *generate*
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

| Stage | Recommended | Rationale |
|---|---|---|
| Text-to-image | **FLUX Kontext (pro/max)** | Only image model with **confirmed** 21:9/9:21 enum, plus seed determinism and a documented `strength` |
| Text-to-image (alt) | **Nano Banana Pro** | 21:9 confirmed in an 11-ratio enum, multimodal input |
| Restyle | **FLUX Kontext** | Same family, `strength` documented (default 0.1) |
| Video loop | **Kling O1** | Only video model with a **confirmed** aspect range (0.40–2.50) covering 21:9; has an end-frame parameter |
| `tags` exemplar | **Qwen-Image 2.0** | Has a real `negative_prompt`, which justifies the two-variant preset schema |

### 9.1 Risk: Kling O1 is a single point of failure

Of every image-to-video model surveyed, **only Kling O1 has a confirmed aspect range
that covers 21:9**. Luma Ray 2 and Veo 3.1 both have end-frame support but neither has
ultrawide confirmed; Framepack and Vidu Q2 appear capped at standard ratios. If wide
animated heroes are the core use case, there is currently no verified fallback. E0
should confirm or refute ultrawide support for at least one alternative.

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
  *copies* defaults rather than referencing them.
- **Genuinely app-wide**: concurrency limit, ffmpeg path, export folder.

## 12. Known-unverified facts

Carried deliberately rather than papered over. All are E0 inputs.

| Unknown | Impact if wrong |
|---|---|
| Real pricing for most models | Cost estimates are wrong; `/pricing` lists different variants than the endpoint IDs we use |
| **Kling O1 duration** — research returned "3–10s default 5", "3–15s", and "5 or 10 only" across three rounds | Duration control offers invalid values; **do not code to any of these** |
| Whether FLUX truly prefers prose over tag-lists | 22 preset rewrites, or not |
| Correct `strength` range for composition-preserving restyle | The style stage's core behaviour |
| Whether a normal `FAL_KEY` can read `/account/billing` (may need Admin scope) | Determines free vs paid key validation |
| REST file-upload flow (found only via GitHub mirrors, wire format unverified) | Fall back to inline base64 data URI; no documented size cap |
| fal rate limits — entirely undocumented | Concurrency limit is a guess; needs client-side backoff regardless |
| Whether any video model other than Kling O1 supports 21:9 | Whether §9.1's single point of failure has a fallback |
| Whether gpt-image-2 is reachable via fal (landing page exists; fetch was rate-limited) | Whether a second provider is needed sooner |

## 13. Epics

Each becomes a task doc in `docs/tasks-todo/`. **E0 gates E2, E4, E5 and E6.**

| ID | Epic | Depends on | Notes |
|---|---|---|---|
| **E0** | **Verification spike** | — | ~1h of `curl` with a real key. Settles every row in §12. Not app code. |
| **E1** | Foundations: `reqwest`, `keyring`, `rusqlite`, app-data layout | — | Dependencies and wiring only |
| **E2** | Model capability registry: schema, JSON, loader, validation | E0, E1 | Field list frozen only after E0's schema audit |
| **E3** | Key management + onboarding modal | E1 | Validation strategy from E0, but structure can start |
| **E4** | Job system: submit, persist `request_id`, poll, resume, cancel, concurrency | E0, E1 | The generic abstraction all three stages reuse |
| **E5** | Project data layer: folders, `project.json`, SQLite index, rebuild-from-disk | E1 | |
| **E6** | Stage 1 — source: prompt-to-image and upload, 4-up batch, seed capture | E2, E4, E5 | |
| **E7** | Stage 2 — style: preset libraries (style + motion), fork-to-customize, restyle | E6 | Preset idiom decided by E0 |
| **E8** | Stage 3 — animate: video generation, native loop, capability-gated controls | E6 | |
| **E9** | Export: ffmpeg detection, MP4/WebM/poster, ping-pong rewind | E8 | |

### E0 scope

One hour, one real fal key, `curl` only — no app code. Answers:

1. Real prices for the shortlisted models.
2. Kling O1's actual duration enum (settles a three-way contradiction).
3. Whether `GET /account/billing` works with a normal key → free validation or not.
4. Whether the REST upload flow works, and the practical base64 payload ceiling.
5. **Prose vs tag-list on FLUX** — same subject, both idioms, compare.
6. **`strength` sweep** on Kontext (0.1 / 0.3 / 0.5 / 0.7 / 0.95) for composition
   preservation.
7. Schema audit across 4–6 fal models to freeze the registry field list (§5).
8. Whether any alternative video model accepts 21:9 (§9.1).

## Appendix — research sources

Raw notes, with per-claim `[CONFIRMED]`/`[UNVERIFIED]` markers, in
[`docs/research/`](../research/):

| File | Contents |
|---|---|
| `models.md` | fal queue mechanics, auth, Kling O1 params, FLUX img2img |
| `models-gaps.md` | Pricing gaps, key validation, REST upload, rate limits |
| `style-presets.md` | 22 drafted style presets (tag-list idiom) |
| `preset-schema.md` | Variant schema, composition order, motion fragments |
| `model-catalog.md` | Model/provider survey, capability matrix, video ultrawide support |

Two notes on these files: they are written in Norwegian, and several claims are marked
unverified. Committed docs going forward are English — these will be translated as
their contents are distilled into implementation docs.
