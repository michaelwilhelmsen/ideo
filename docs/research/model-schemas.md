# fal model schemas — verified capability rows

> **Method:** every capability field below was read from fal's public per-endpoint OpenAPI document,
> `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`, fetched unauthenticated on **2026-08-09**.
> No API key, no generation call, nothing billed. 33 endpoints, all HTTP 200.
>
> **Prices come from a weaker source** than the capability fields — see "Price". Nothing here is billing-verified.
>
> **This supersedes `model-catalog.md` and `models.md`** for every field it covers. Those were assembled from web
> search and carry `[UNVERIFIED]` on most rows; where they disagree with this file, this file wins.
>
> Produced for #38.

## How to read this

Optional parameters appear as `anyOf: [<type>, null]`. Presence was read from the `anyOf` members, not the
top-level `type` — a naive read of `type` reports every optional field as absent.

`image_size` is also an `anyOf`, and this matters more than it looks: it accepts **either** a preset enum token
**or** an explicit `{width, height}` object. A model with `image_size` therefore has _more_ ratio freedom than one
with an `aspect_ratio` enum, not less. See "Ratio freedom" — an earlier draft of this document got that backwards.

"**absent**" means the field does not exist in the input schema. For `seed` that is load-bearing: PRD §1/§4.3's
recipe premise does not hold on a seedless model, and §10.1 makes that a _disabled_ headline control, not a hidden
one.

## Ratio freedom

The models split into three groups, and the grouping is the opposite of what a glance at the enums suggests.

**Free dimensions** — accept explicit `{width, height}`, so any ratio is reachable within the stated bounds:

| Model                              | Constraints                                               | A legal exact 21:9               |
| ---------------------------------- | --------------------------------------------------------- | -------------------------------- |
| `openai/gpt-image-2` (+ `/edit`)   | multiples of 16, max edge 3840, ratio ≤ 3:1, 0.66–8.29 MP | **2688 × 1152**                  |
| `fal-ai/flux-2-pro`                | multiples of 16, 256–2560 per side, ≤ 4.19 MP             | **2352 × 1008**                  |
| `fal-ai/qwen-image-2/*` (all four) | total pixels 0.26–4.19 MP                                 | **1960 × 840** or **2044 × 876** |
| `fal-ai/flux-pro/v1.1`             | none declared beyond max edge 14142                       | **2520 × 1080**                  |

Every one of those is exactly 7:3 and satisfies the model's own declared constraints. Verified as arithmetic
against the schema bounds, not by generating an image.

**Enum only** — locked to a fixed ratio list, cannot be given dimensions: the whole FLUX Kontext family, the whole
Nano Banana family, and all Grok Imagine variants. These are the models that _declare_ `21:9` (Kontext, Nano
Banana) or do not (Grok, whose widest are `2:1` and `20:9`).

**No size field at all** — geometry inherits from the input image: `fal-ai/flux/dev/image-to-image`,
`fal-ai/flux-kontext/dev`, and every video model except those with an `aspect_ratio` enum.

So aspect is a real constraint in exactly one place: **the animate stage**, where no model accepts explicit
dimensions. On the image stages it is close to a non-issue.

## Source stage (text-to-image)

| Endpoint id                                    | Ratio control                                                                                                                             | `seed`     | `negative_prompt` | Price                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fal-ai/flux-pro/kontext/text-to-image`        | `aspect_ratio` **enum only**: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**        | Your request will cost $0.04 per image.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fal-ai/flux-pro/kontext/max/text-to-image`    | `aspect_ratio` **enum only**: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**        | Your request will cost $0.08 per image.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fal-ai/flux-pro/v1.1`                         | **free `{width, height}`** — no constraints declared beyond max edge 14142                                                                | `seed`     | **absent**        | Your request will cost $0.04 per megapixel. Images are billed by rounding up to the nearest megapixel.                                                                                                                                                                                                                                                                                                                                                              |
| `fal-ai/flux-2-pro`                            | **free `{width, height}`** — multiples of 16, 256–2560 per side, ≤ 4.19 MP                                                                | `seed`     | **absent**        | Your request will cost **$0.03** for the first megapixel of output, plus **$0.015** per extra megapixel of input and output, rounded up to the nearest megapixel. For example, a **1024x1024** image will cost **$0.03**, and a **1920x1080** image will cost **$0.045** (**$0.03** for first megapixel + **$0.015** for the second megapixel). Similarly, a **512x512** output will cost **$0.03** (**$0.03** for **0.25** megapixels, rounded to **1** megapixel) |
| `fal-ai/nano-banana-pro`                       | `aspect_ratio` **enum only**: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`                             | `seed`     | **absent**        | Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times. 4K outputs will be charged at double the standard rate. If web search is used, an additional $0.015 will be charged. Note: Pricing may change in the future.                                                                                                                                                                                                         |
| `fal-ai/nano-banana-2`                         | `aspect_ratio` **enum only**: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `4:1`, `1:4`, `8:1`, `1:8` | `seed`     | **absent**        | Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged. **Note: Pricing is subject to change.**       |
| `openai/gpt-image-2`                           | **free `{width, height}`** — multiples of 16, max edge 3840, ratio ≤ 3:1, 0.66–8.29 MP                                                    | **absent** | **absent**        | Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00** output. Image tokens (per 1M): **$8.00** input, **$2.00** cached, **$30.00** output. Changing the **quality** parameter significantly affects cost; by default we use **high**. Adjust it to your preference. See the description at the bottom of this page for more details on how much canonical image sizes cost. Total cost is rounded up to the closest hundredth of a cent ($0.0001.)    |
| `fal-ai/qwen-image-2/text-to-image`            | **free `{width, height}`** — total pixels 0.26–4.19 MP                                                                                    | `seed`     | `negative_prompt` | Your request will cost $0.035 per image.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fal-ai/qwen-image-2/pro/text-to-image`        | **free `{width, height}`** — total pixels 0.26–4.19 MP                                                                                    | `seed`     | `negative_prompt` | Your request will cost $0.075 per image.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `xai/grok-imagine-image`                       | `aspect_ratio` **enum only**: `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2`         | **absent** | **absent**        | Your request will cost $0.02 per image.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `xai/grok-imagine-image/quality/text-to-image` | `aspect_ratio` **enum only**: `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2`         | **absent** | **absent**        | Your request with cost **$0.05 per image** for 1K and **$0.07 per image** for 2K.                                                                                                                                                                                                                                                                                                                                                                                   |

## Style stage (image-to-image / edit)

| Endpoint id                           | Ratio control                                                                                                                             | `seed`     | strength                    | `negative_prompt` | Price                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fal-ai/flux-pro/kontext`             | `aspect_ratio` **enum only**: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**                  | **absent**        | Your request will cost $0.04 per image.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `fal-ai/flux-pro/kontext/max`         | `aspect_ratio` **enum only**: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**                  | **absent**        | Your request will cost $0.08 per image.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `fal-ai/flux/dev/image-to-image`      | **inherits from input** (no size or aspect field)                                                                                         | `seed`     | `strength` (default `0.95`) | **absent**        | Your request will cost $0.03 per megapixel. Images are billed by rounding up to the nearest megapixel.                                                                                                                                                                                                                                                                                                                                                           |
| `fal-ai/flux-kontext/dev`             | **inherits from input** (no size or aspect field)                                                                                         | `seed`     | **absent**                  | **absent**        | Your request will cost $0.025 per megapixel. Images are billed by rounding up to the nearest megapixel.                                                                                                                                                                                                                                                                                                                                                          |
| `fal-ai/nano-banana-pro/edit`         | `aspect_ratio` **enum only**: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`                             | `seed`     | **absent**                  | **absent**        | Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times. 4K outputs will be charged at double the standard rate. If web search is used, an additional $0.015 will be charged. Note: Pricing may change in the future.                                                                                                                                                                                                      |
| `fal-ai/nano-banana-2/edit`           | `aspect_ratio` **enum only**: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `4:1`, `1:4`, `8:1`, `1:8` | `seed`     | **absent**                  | **absent**        | Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged. **Note: Pricing is subject to change.**    |
| `openai/gpt-image-2/edit`             | **free `{width, height}`** — as above; `auto` infers from input                                                                           | **absent** | **absent**                  | **absent**        | Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00** output. Image tokens (per 1M): **$8.00** input, **$2.00** cached, **$30.00** output. Changing the **quality** parameter significantly affects cost; by default we use **high**. Adjust it to your preference. See the description at the bottom of this page for more details on how much canonical image sizes cost. Total cost is rounded up to the closest hundredth of a cent ($0.0001). |
| `fal-ai/qwen-image-2/edit`            | **free `{width, height}`** — total pixels 0.26–4.19 MP; defaults to input size                                                            | `seed`     | **absent**                  | `negative_prompt` | Your request will cost $0.035 per image.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `fal-ai/qwen-image-2/pro/edit`        | **free `{width, height}`** — total pixels 0.26–4.19 MP; defaults to input size                                                            | `seed`     | **absent**                  | `negative_prompt` | Your request will cost $0.075 per image.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `xai/grok-imagine-image/edit`         | `aspect_ratio` **enum only**: `auto`, `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2` | **absent** | **absent**                  | **absent**        | Your request will cost **$0.022** per image (**$0.02** for image output + **$0.002** for image input).                                                                                                                                                                                                                                                                                                                                                           |
| `xai/grok-imagine-image/quality/edit` | `aspect_ratio` **enum only**: `auto`, `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2` | **absent** | **absent**                  | **absent**        | Your request with cost **$0.05 per output image** for 1K and **$0.07 per output image** for 2K in addition to **$0.01 per input image**.                                                                                                                                                                                                                                                                                                                         |

### The input-image field (read 2026-08-09, for #28)

Same method as above — the `components.schemas.*Input` block of each endpoint's OpenAPI
document. The column was missing from the table above, and it is not one name:

| Endpoint id                      | Input-image field        | Required |
| -------------------------------- | ------------------------ | -------- |
| `fal-ai/flux-pro/kontext`        | `image_url` (string)     | yes      |
| `fal-ai/flux-pro/kontext/max`    | `image_url` (string)     | yes      |
| `fal-ai/flux/dev/image-to-image` | `image_url` (string)     | yes      |
| `fal-ai/flux-kontext/dev`        | `image_url` (string)     | yes      |
| `fal-ai/qwen-image-2/edit`       | `image_urls` (**array**) | yes      |
| `fal-ai/qwen-image-2/pro/edit`   | `image_urls` (**array**) | yes      |
| `fal-ai/nano-banana-pro/edit`    | `image_urls` (**array**) | yes      |
| `fal-ai/nano-banana-2/edit`      | `image_urls` (**array**) | no       |

Two things matter here beyond the name. The FLUX family wants a **single string** and the
other four want an **array**, so a request builder that only remembers the field name will
still 422. And `nano-banana-2/edit` does not require its images at all — it will happily
run as text-to-image, which means an edit that silently lost its source comes back as a
plausible unrelated picture rather than an error.

## Animate stage (image-to-video)

This is the one stage where the aspect enum genuinely constrains — no video model accepts `{width, height}`.

| Endpoint id                                        | Aspect                                                     | End frame        | Duration                                                                  | Resolution                                  | `seed`     | `negative_prompt` | Price                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------- | ------------------------------------------- | ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fal-ai/kling-video/o1/image-to-video`             | **inherits from input**                                    | `end_image_url`  | `3, 4, 5, 6, 7, 8, 9, 10` (default `5`)                                   | **absent**                                  | **absent** | **absent**        | Your request will cost $0.112 per second.                                                                                                                                                                                                                                                             |
| `fal-ai/kling-video/o3/pro/image-to-video`         | **inherits from input**                                    | `end_image_url`  | `3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15` (default `5`)               | **absent**                                  | **absent** | **absent**        | For every second of video you generated, you will be charged **$0.112** (audio off) or **$0.14** (audio on). For example, a 5s video with audio on will cost **$0.70**                                                                                                                                |
| `fal-ai/veo3.1/first-last-frame-to-video`          | `auto`, `16:9`, `9:16`                                     | `last_frame_url` | `4s, 6s, 8s` (default `8s`)                                               | `720p`, `1080p`, `4k` (default `720p`)      | `seed`     | `negative_prompt` | For every second of video you generate you will be charged **$0.20** without audio or **$0.40** with audio for 720p or 1080p. At 4k, you will be charged **$0.40** per second without audio, or **$0.60** with. For example, a **5 second video** at **1080p** with **audio on** will cost **$2.00**. |
| `fal-ai/veo3.1/image-to-video`                     | `auto`, `16:9`, `9:16`                                     | **absent**       | `4s, 6s, 8s` (default `8s`)                                               | `720p`, `1080p`, `4k` (default `720p`)      | `seed`     | `negative_prompt` | For every second of video you generate you will be charged **$0.20** without audio or **$0.40** with audio for 720p or 1080p. At 4k, you will be charged **$0.40** per second without audio, or **$0.60** with. For example, a **5 second video** at **1080p** with **audio on** will cost **$2.00**. |
| `blackforestlabs/flux-3/first-last-frame-to-video` | `auto`, `21:9`, `2:1`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | `end_image_url`  | `5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20` (default `5`) | `720p`, `1080p` (default `720p`)            | **absent** | **absent**        | Your request will be charged at **0.17** $ per second of generated video at 720p, and **0.29** $ per second at 1080p.                                                                                                                                                                                 |
| `blackforestlabs/flux-3/keyframes-to-video`        | `auto`, `21:9`, `2:1`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | `keyframes`      | `5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20` (default `5`) | `720p`, `1080p` (default `720p`)            | **absent** | **absent**        | Your request will be charged at **0.17** $ per second of generated video at 720p, and **0.29** $ per second at 1080p.                                                                                                                                                                                 |
| `fal-ai/luma-dream-machine/ray-2/image-to-video`   | `16:9`, `9:16`, `4:3`, `3:4`, `21:9`, `9:21`               | `end_image_url`  | `5s, 9s` (default `5s`)                                                   | `540p`, `720p`, `1080p` (default `540p`)    | **absent** | **absent**        | Your request will cost $0.5 per 5 second.                                                                                                                                                                                                                                                             |
| `fal-ai/ltx-2.3/image-to-video`                    | `auto`, `16:9`, `9:16`                                     | `end_image_url`  | `6, 8, 10` (default `6`)                                                  | `1080p`, `1440p`, `2160p` (default `1080p`) | **absent** | **absent**        | Your request will cost $0.08 per second for 1080p, $0.16 per second for 1440p or $0.32 per second for 2160p.                                                                                                                                                                                          |
| `minimax/h3/image-to-video`                        | **inherits from input**                                    | `end_image_url`  | `duration` no enum, default `5`                                           | `768P`, `2K`, `4K` (default `2K`)           | **absent** | **absent**        | Video costs **$0.08** per second at **768p**, **$0.13** per second at **2K** and **$0.16** per second at **4K**.                                                                                                                                                                                      |
| `fal-ai/wan-flf2v`                                 | `auto`, `16:9`, `9:16`, `1:1`                              | `end_image_url`  | `num_frames` no enum, default `81`                                        | `480p`, `720p` (default `720p`)             | `seed`     | `negative_prompt` | For a video generation, your request will cost **$0.2** at 480p resolution and **0.4$** at 720p resolution. For **$1** you can run this model with **approximately 5 times**. More than the default frames will cost 1.25x more.                                                                      |
| `fal-ai/pika/v2.2/pikaframes`                      | **inherits from input**                                    | **absent**       | **absent**                                                                | `720p`, `1080p` (default `720p`)            | `seed`     | `negative_prompt` | Your request will cost $0.04 per second for 720p or $0.06 per second for 1080p, with a minimum of 5 billable seconds - $0.20 for 720p and $0.30 for 1080p.                                                                                                                                            |

## Queue shape

All 33 endpoints expose the same submit-poll queue shape (`/requests/{request_id}/status`). No candidate needs a
different job layer (PRD §5.1).

## Price

Prices are **fal's own published rates, read on 2026-08-09** — not schema data, not a billing verification, no call
made against any endpoint. Two sources, both fal's, differing in strength:

- **catalogue** — `pricingInfoOverride` from `https://fal.ai/api/models?keywords=<term>`. A JSON field, but untyped
  prose with conditional surcharges. Covers 19 of 33.
- **model page** — the price widget on `https://fal.ai/models/<id>`, read from the rendered DOM. The only source for
  the other 14, which is most of the incumbent shortlist.

There is **no structured pricing API**. `fal.ai/api/pricing` serves a bot-check HTML page; its 429 reads like
rate-limiting on a real endpoint and is not one.

Rates carry fal's own "subject to change" caveat.

## Findings

### 1. Ratio is not the selection axis it was treated as

An earlier draft of this file, and #11's risk register, treated `21:9` reachability as a gate that ruled models in
or out. That was wrong twice over:

- Four image models accept explicit `{width, height}` and can hit 21:9 exactly (see "Ratio freedom"). They were
  previously recorded as "no 21:9" because only their enum was read.
- Even where a model is enum-locked, a 16:9 or 2:1 generation is a usable hero — cropping and letterboxing exist.

**Aspect should be a tiebreaker, not a filter.** It genuinely constrains only the animate stage.

### 2. What actually differentiates the image models

Given ratio mostly falls away, the schema-visible axes that remain are output ceiling, whether a real
`negative_prompt` exists, whether `seed` exists, and price:

| Model                                | Ceiling           | `seed` | `negative_prompt` | Price                   |
| ------------------------------------ | ----------------- | ------ | ----------------- | ----------------------- |
| `fal-ai/nano-banana-pro` (+ `/edit`) | 4K (surcharge)    | yes    | no                | $0.15/image             |
| `fal-ai/nano-banana-2` (+ `/edit`)   | 4K (2× surcharge) | yes    | no                | $0.08/image             |
| `openai/gpt-image-2` (+ `/edit`)     | 8.29 MP           | **no** | no                | token-priced            |
| `fal-ai/qwen-image-2/pro/*`          | 4.19 MP           | yes    | **yes**           | $0.075/image            |
| `fal-ai/qwen-image-2/*`              | 4.19 MP           | yes    | **yes**           | $0.035/image            |
| `fal-ai/flux-pro/kontext` / `max`    | enum ratios       | yes    | no                | $0.04 / $0.08 per image |
| `fal-ai/flux-2-pro`                  | 4.19 MP           | yes    | no                | ~$0.03 first MP         |
| `xai/grok-imagine-image`             | 2K                | **no** | no                | $0.02/image             |

**Visual quality is not in this table and cannot be — no schema encodes it.** Ranking the models on output quality
needs generations looked at by a person. That is #35's call and it is the one thing here that genuinely costs money;
a 6-model bake-off at four candidates each is roughly $1.50–$2.50 at the prices above.

`openai/gpt-image-2` and every Grok variant have **no `seed`**, so per §1/§4.3 the recipe premise does not hold on
them — a headline-disabled control, not a hidden one. That is a stronger argument against them than ratio ever was.

### 3. The 21:9-versus-`negative_prompt` conflict does not exist — retracted

An earlier draft claimed no style-stage model had both 21:9 and a `negative_prompt`, and that #35 therefore had to
trade one against the other. **That was an artefact of reading only the enum.**

`fal-ai/qwen-image-2/edit` and `fal-ai/qwen-image-2/pro/edit` have a real `negative_prompt` _and_ free dimensions —
21:9 at 1960 × 840 or 2044 × 876. They are also the cheapest edit endpoints surveyed at $0.035 and $0.075 per image.

The open question is only the ordinary one: are they _good enough_ visually to be the default restyle model, against
`nano-banana-pro/edit` at $0.15 which has no `negative_prompt` at all. All 44 recipes in the v4 library carry a
`negative`, so on Nano Banana that instruction has nowhere to go and must fold into the prompt body.

### 4. Animate stage — where aspect does bite

No video model accepts explicit dimensions, so here the enum is the whole story:

- `blackforestlabs/flux-3/first-last-frame-to-video` — declares `21:9` and `2:1`, `end_image_url` **required**,
  5–20s, $0.17/s at 720p. The widest-ratio end-frame option.
- `fal-ai/luma-dream-machine/ray-2/image-to-video` — declares `21:9`, but **540p by default** and only `5s`/`9s`.
- `fal-ai/kling-video/o1/image-to-video` — **no aspect parameter at all**; inherits from `start_image_url`. Whole
  input is `prompt`, `start_image_url`, `end_image_url`, `duration`. Cheapest at $0.112/s.
- `fal-ai/veo3.1/first-last-frame-to-video` — `auto`/`16:9`/`9:16` only, so no native ultrawide, but it has `seed`
  **and** `negative_prompt`, 4K, and is the best-verified model in §9.1. **Not ruled out** — a 16:9 clip is a
  usable hero. An earlier draft called it "out on aspect"; that judgement was ratio-absolutism and is withdrawn.

#11's "one video model is a single point of failure for 21:9" risk is retired either way: there are now three
end-frame models with wide ratios, plus Veo as a 16:9 fallback.

### 5. Kling O1's duration is settled

Integer enum `3,4,5,6,7,8,9,10`, default `5` — closing #11's "three contradictory answers". The idiom varies across
models: Veo uses `4s`/`6s`/`8s`, Luma `5s`/`9s`, `minimax/h3` has no enum (integer 5–15). `durations` cannot assume
one format.

### 6. There is almost nothing to measure for `strength`

One endpoint of 33 exposes a strength field: `fal-ai/flux/dev/image-to-image`, schema default **0.95**, confirming
PRD §6.3 verbatim. Every modern edit model is instruction-driven with no strength param. `strengthParam` is `null`
across the field, and #35's "measured usable window" is a one-model question at most.

### 7. Endpoint-id corrections

- `FIXTURE_REGISTRY` declares `fal-ai/flux-pro/kontext` at stage `source`. That endpoint is image-to-image and
  **requires `image_url`** — a text-to-image call against it fails at submit. The source id is
  `fal-ai/flux-pro/kontext/text-to-image`.
- The library's `model_hints` id `gpt-image-2` is the wrong namespace: it is `openai/gpt-image-2`, not `fal-ai/*`.
- `flux-kontext` is ambiguous across five live endpoints (`flux-pro/kontext`, `.../max`, `.../text-to-image`,
  `.../max/text-to-image`, `flux-kontext/dev`) which differ by stage, ratio control and price. Needs a decision.
- **Minimax H3 is a video model** (`minimax/h3/*`), not an image model. **Grok Imagine** is both, via
  `xai/grok-imagine-image` and `xai/grok-imagine-video`.

## Gap in `ModelCapabilities` (reported, not closed)

`aspects` is typed `readonly AspectId[] | 'inheritsFromSource'`. Neither case can represent the largest group of
image models — the ones taking explicit `{width, height}` under numeric constraints (`multiple_of`, `max_area`,
min/max edge, max ratio). Recording those as an `AspectId[]` of the ratios we happen to want would work by accident
for `modelAvailability`, but throws away what the request builder needs: a different field name carrying different
values, plus the constraint arithmetic that decides whether a chosen ratio is legal at a chosen size.

The field wants three cases, not two: ratio enum, free dimensions with constraints, inherits-from-input. #25 should
decide the shape.

## Handover to #35

Settled here:

- Endpoint ids for every candidate, all returning 200, with stage corrected from the schema where the table guessed
- Ratio control per model: enum list, free dimensions with bounds, or inherits — including exact legal 21:9 sizes
- `seed`, `negative_prompt`, end-frame, duration and resolution presence, names, enums and schema defaults
- Queue shape: uniformly submit-poll
- A dated published price for all 33

Open, and human:

- **Which models look best.** Not schema-derivable, and now the main axis. Needs a small paid bake-off — roughly
  $1.50–$2.50 for six models at four candidates each.
- **Default per stage**, informed by that bake-off, with `seed` absence as a hard strike (`gpt-image-2`, Grok) and
  `negative_prompt` presence as a real advantage for the v4 recipe library (Qwen edit).
- **The `flux-kontext` hint decision** and the PRD §9 rewrite.
- **A human read of the price surcharges** — audio on/off, resolution multipliers, token-priced `gpt-image-2`.
- **Measured strength window**, if `flux/dev/image-to-image` survives selection at all.
