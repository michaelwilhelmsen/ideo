# fal model schemas — verified capability rows

> **Method:** every field below was read from fal's public per-endpoint OpenAPI document,
> `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`, fetched unauthenticated on **2026-08-09**.
> No API key, no generation call, nothing billed. Raw documents are reproducible from the endpoint ids listed.
>
> **This supersedes `model-catalog.md` and `models.md` for every field it covers.** Those were assembled from web
> search and page fetches and carry `[UNVERIFIED]` on most rows; where they disagree with this file, this file wins.
>
> Produced for #38. Prices were added afterwards on request and come from a **different, weaker source** than the
> schema fields — see "Price" for exactly which. Measured strength windows and default-model selection remain
> #35's, see "Handover to #35" at the end.

## How to read this

Optional parameters appear in the schema as `anyOf: [<type>, null]`. Presence was therefore read from the
`anyOf` members, not the top-level `type` — a naive read of `type` reports every optional field as absent.

"**absent**" means the field does not exist in the model's input schema. For `seed` that is load-bearing:
PRD §1/§4.3's recipe premise does not hold on a seedless model, and PRD §10.1 says that is a _disabled_
headline control, not a hidden one.

Every endpoint listed returned HTTP 200 on 2026-08-09.

## Source stage (text-to-image)

| Endpoint id                                    | 21:9                    | Aspect                                                                                                                      | `seed`     | `negative_prompt` |
| ---------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------- |
| `fal-ai/flux-pro/kontext/text-to-image`        | **yes**                 | `aspect_ratio`: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**        |
| `fal-ai/flux-pro/kontext/max/text-to-image`    | **yes**                 | `aspect_ratio`: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**        |
| `fal-ai/flux-pro/v1.1`                         | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`                     | `seed`     | **absent**        |
| `fal-ai/flux-2-pro`                            | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`                     | `seed`     | **absent**        |
| `fal-ai/nano-banana-pro`                       | **yes**                 | `aspect_ratio`: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`                             | `seed`     | **absent**        |
| `fal-ai/nano-banana-2`                         | **yes**                 | `aspect_ratio`: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `4:1`, `1:4`, `8:1`, `1:8` | `seed`     | **absent**        |
| `openai/gpt-image-2`                           | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto`             | **absent** | **absent**        |
| `fal-ai/qwen-image-2/text-to-image`            | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`                     | `seed`     | `negative_prompt` |
| `fal-ai/qwen-image-2/pro/text-to-image`        | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`                     | `seed`     | `negative_prompt` |
| `xai/grok-imagine-image`                       | no 21:9 (has 2:1, 20:9) | `aspect_ratio`: `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2`         | **absent** | **absent**        |
| `xai/grok-imagine-image/quality/text-to-image` | no 21:9 (has 2:1, 20:9) | `aspect_ratio`: `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2`         | **absent** | **absent**        |

## Style stage (image-to-image / edit)

| Endpoint id                           | 21:9                    | Aspect                                                                                                                      | `seed`     | strength/denoise                   | `negative_prompt` |
| ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- | ----------------- |
| `fal-ai/flux-pro/kontext`             | **yes**                 | `aspect_ratio`: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**                         | **absent**        |
| `fal-ai/flux-pro/kontext/max`         | **yes**                 | `aspect_ratio`: `21:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:21`                                           | `seed`     | **absent**                         | **absent**        |
| `fal-ai/flux/dev/image-to-image`      | inherits                | **inherits from input** (no aspect param)                                                                                   | `seed`     | `strength` (schema default `0.95`) | **absent**        |
| `fal-ai/flux-kontext/dev`             | inherits                | **inherits from input** (no aspect param)                                                                                   | `seed`     | **absent**                         | **absent**        |
| `fal-ai/nano-banana-pro/edit`         | **yes**                 | `aspect_ratio`: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`                             | `seed`     | **absent**                         | **absent**        |
| `fal-ai/nano-banana-2/edit`           | **yes**                 | `aspect_ratio`: `auto`, `21:9`, `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `4:1`, `1:4`, `8:1`, `1:8` | `seed`     | **absent**                         | **absent**        |
| `openai/gpt-image-2/edit`             | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto`             | **absent** | **absent**                         | **absent**        |
| `fal-ai/qwen-image-2/edit`            | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`                     | `seed`     | **absent**                         | `negative_prompt` |
| `fal-ai/qwen-image-2/pro/edit`        | **no**                  | `image_size`: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`                     | `seed`     | **absent**                         | `negative_prompt` |
| `xai/grok-imagine-image/edit`         | no 21:9 (has 2:1, 20:9) | `aspect_ratio`: `auto`, `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2` | **absent** | **absent**                         | **absent**        |
| `xai/grok-imagine-image/quality/edit` | no 21:9 (has 2:1, 20:9) | `aspect_ratio`: `auto`, `2:1`, `20:9`, `19.5:9`, `16:9`, `4:3`, `3:2`, `1:1`, `2:3`, `3:4`, `9:16`, `9:19.5`, `9:20`, `1:2` | **absent** | **absent**                         | **absent**        |

## Animate stage (image-to-video)

| Endpoint id                                        | 21:9     | End frame        | Duration                                                                                                            | Resolution                                  | `seed`     | `negative_prompt` |
| -------------------------------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------- | ----------------- |
| `fal-ai/kling-video/o1/image-to-video`             | inherits | `end_image_url`  | `duration`: `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10` (default `5`)                                                   | **absent**                                  | **absent** | **absent**        |
| `fal-ai/kling-video/o3/pro/image-to-video`         | inherits | `end_image_url`  | `duration`: `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15` (default `5`)                     | **absent**                                  | **absent** | **absent**        |
| `fal-ai/veo3.1/first-last-frame-to-video`          | **no**   | `last_frame_url` | `duration`: `4s`, `6s`, `8s` (default `8s`)                                                                         | `720p`, `1080p`, `4k` (default `720p`)      | `seed`     | `negative_prompt` |
| `fal-ai/veo3.1/image-to-video`                     | **no**   | **absent**       | `duration`: `4s`, `6s`, `8s` (default `8s`)                                                                         | `720p`, `1080p`, `4k` (default `720p`)      | `seed`     | `negative_prompt` |
| `blackforestlabs/flux-3/first-last-frame-to-video` | **yes**  | `end_image_url`  | `duration`: `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15`, `16`, `17`, `18`, `19`, `20` (default `5`) | `720p`, `1080p` (default `720p`)            | **absent** | **absent**        |
| `blackforestlabs/flux-3/keyframes-to-video`        | **yes**  | `keyframes`      | `duration`: `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`, `15`, `16`, `17`, `18`, `19`, `20` (default `5`) | `720p`, `1080p` (default `720p`)            | **absent** | **absent**        |
| `fal-ai/luma-dream-machine/ray-2/image-to-video`   | **yes**  | `end_image_url`  | `duration`: `5s`, `9s` (default `5s`)                                                                               | `540p`, `720p`, `1080p` (default `540p`)    | **absent** | **absent**        |
| `fal-ai/ltx-2.3/image-to-video`                    | **no**   | `end_image_url`  | `duration`: `6`, `8`, `10` (default `6`)                                                                            | `1080p`, `1440p`, `2160p` (default `1080p`) | **absent** | **absent**        |
| `minimax/h3/image-to-video`                        | inherits | `end_image_url`  | `duration` (no enum, default `5`)                                                                                   | `768P`, `2K`, `4K` (default `2K`)           | **absent** | **absent**        |
| `fal-ai/wan-flf2v`                                 | **no**   | `end_image_url`  | `num_frames` (no enum, default `81`)                                                                                | `480p`, `720p` (default `720p`)             | `seed`     | `negative_prompt` |
| `fal-ai/pika/v2.2/pikaframes`                      | inherits | **absent**       | **absent**                                                                                                          | `720p`, `1080p` (default `720p`)            | `seed`     | `negative_prompt` |

## Queue shape

All 33 endpoints expose the same submit-poll queue shape (`/requests/{request_id}/status`).
No candidate needs a different job layer (PRD §5.1).

## Price

Prices are **fal's own published rates, read on 2026-08-09**. They are not schema data and not a billing
verification — no call was made against any endpoint. Two sources, both fal's, recorded per row because they differ
in strength:

- **catalogue** — the `pricingInfoOverride` string from `https://fal.ai/api/models?keywords=<term>`. A JSON field,
  but untyped marketing prose with conditional surcharges.
- **model page** — the price widget on `https://fal.ai/models/<id>`, read from the rendered DOM. Present for the 14
  models whose catalogue record has no `pricingInfoOverride` at all — which is most of the incumbent shortlist.

There is **no structured pricing API**. `fal.ai/api/pricing` returns a bot-check HTML page, not JSON — its 429 reads
like rate-limiting on a real endpoint and is not one. The catalogue field is the only machine-readable price fal
exposes, and it covers 19 of 33 models.

Rates carry fal's own "subject to change" caveat. Treat every figure as dated, not fixed.

### Source stage

| Endpoint id                                    | Price                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `fal-ai/flux-pro/kontext/text-to-image`        | Your request will cost $0.04 per image.                                                                                                                                                                                                                                                                                                                                                                                                                             | model page |
| `fal-ai/flux-pro/kontext/max/text-to-image`    | Your request will cost $0.08 per image.                                                                                                                                                                                                                                                                                                                                                                                                                             | model page |
| `fal-ai/flux-pro/v1.1`                         | Your request will cost $0.04 per megapixel. Images are billed by rounding up to the nearest megapixel.                                                                                                                                                                                                                                                                                                                                                              | model page |
| `fal-ai/flux-2-pro`                            | Your request will cost **$0.03** for the first megapixel of output, plus **$0.015** per extra megapixel of input and output, rounded up to the nearest megapixel. For example, a **1024x1024** image will cost **$0.03**, and a **1920x1080** image will cost **$0.045** (**$0.03** for first megapixel + **$0.015** for the second megapixel). Similarly, a **512x512** output will cost **$0.03** (**$0.03** for **0.25** megapixels, rounded to **1** megapixel) | catalogue  |
| `fal-ai/nano-banana-pro`                       | Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times. 4K outputs will be charged at double the standard rate. If web search is used, an additional $0.015 will be charged. Note: Pricing may change in the future.                                                                                                                                                                                                         | catalogue  |
| `fal-ai/nano-banana-2`                         | Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged. **Note: Pricing is subject to change.**       | catalogue  |
| `openai/gpt-image-2`                           | Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00** output. Image tokens (per 1M): **$8.00** input, **$2.00** cached, **$30.00** output. Changing the **quality** parameter significantly affects cost; by default we use **high**. Adjust it to your preference. See the description at the bottom of this page for more details on how much canonical image sizes cost. Total cost is rounded up to the closest hundredth of a cent ($0.0001.)    | catalogue  |
| `fal-ai/qwen-image-2/text-to-image`            | Your request will cost $0.035 per image.                                                                                                                                                                                                                                                                                                                                                                                                                            | model page |
| `fal-ai/qwen-image-2/pro/text-to-image`        | Your request will cost $0.075 per image.                                                                                                                                                                                                                                                                                                                                                                                                                            | model page |
| `xai/grok-imagine-image`                       | Your request will cost $0.02 per image.                                                                                                                                                                                                                                                                                                                                                                                                                             | model page |
| `xai/grok-imagine-image/quality/text-to-image` | Your request with cost **$0.05 per image** for 1K and **$0.07 per image** for 2K.                                                                                                                                                                                                                                                                                                                                                                                   | catalogue  |

### Style stage

| Endpoint id                           | Price                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Source     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `fal-ai/flux-pro/kontext`             | Your request will cost $0.04 per image.                                                                                                                                                                                                                                                                                                                                                                                                                          | model page |
| `fal-ai/flux-pro/kontext/max`         | Your request will cost $0.08 per image.                                                                                                                                                                                                                                                                                                                                                                                                                          | model page |
| `fal-ai/flux/dev/image-to-image`      | Your request will cost $0.03 per megapixel. Images are billed by rounding up to the nearest megapixel.                                                                                                                                                                                                                                                                                                                                                           | model page |
| `fal-ai/flux-kontext/dev`             | Your request will cost $0.025 per megapixel. Images are billed by rounding up to the nearest megapixel.                                                                                                                                                                                                                                                                                                                                                          | model page |
| `fal-ai/nano-banana-pro/edit`         | Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times. 4K outputs will be charged at double the standard rate. If web search is used, an additional $0.015 will be charged. Note: Pricing may change in the future.                                                                                                                                                                                                      | catalogue  |
| `fal-ai/nano-banana-2/edit`           | Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged. **Note: Pricing is subject to change.**    | catalogue  |
| `openai/gpt-image-2/edit`             | Text tokens (per 1M): **$5.00** input, **$1.25** cached, **$10.00** output. Image tokens (per 1M): **$8.00** input, **$2.00** cached, **$30.00** output. Changing the **quality** parameter significantly affects cost; by default we use **high**. Adjust it to your preference. See the description at the bottom of this page for more details on how much canonical image sizes cost. Total cost is rounded up to the closest hundredth of a cent ($0.0001). | catalogue  |
| `fal-ai/qwen-image-2/edit`            | Your request will cost $0.035 per image.                                                                                                                                                                                                                                                                                                                                                                                                                         | model page |
| `fal-ai/qwen-image-2/pro/edit`        | Your request will cost $0.075 per image.                                                                                                                                                                                                                                                                                                                                                                                                                         | model page |
| `xai/grok-imagine-image/edit`         | Your request will cost **$0.022** per image (**$0.02** for image output + **$0.002** for image input).                                                                                                                                                                                                                                                                                                                                                           | catalogue  |
| `xai/grok-imagine-image/quality/edit` | Your request with cost **$0.05 per output image** for 1K and **$0.07 per output image** for 2K in addition to **$0.01 per input image**.                                                                                                                                                                                                                                                                                                                         | catalogue  |

### Animate stage

| Endpoint id                                        | Price                                                                                                                                                                                                                                                                                                 | Source     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `fal-ai/kling-video/o1/image-to-video`             | Your request will cost $0.112 per second.                                                                                                                                                                                                                                                             | model page |
| `fal-ai/kling-video/o3/pro/image-to-video`         | For every second of video you generated, you will be charged **$0.112** (audio off) or **$0.14** (audio on). For example, a 5s video with audio on will cost **$0.70**                                                                                                                                | catalogue  |
| `fal-ai/veo3.1/first-last-frame-to-video`          | For every second of video you generate you will be charged **$0.20** without audio or **$0.40** with audio for 720p or 1080p. At 4k, you will be charged **$0.40** per second without audio, or **$0.60** with. For example, a **5 second video** at **1080p** with **audio on** will cost **$2.00**. | catalogue  |
| `fal-ai/veo3.1/image-to-video`                     | For every second of video you generate you will be charged **$0.20** without audio or **$0.40** with audio for 720p or 1080p. At 4k, you will be charged **$0.40** per second without audio, or **$0.60** with. For example, a **5 second video** at **1080p** with **audio on** will cost **$2.00**. | catalogue  |
| `blackforestlabs/flux-3/first-last-frame-to-video` | Your request will be charged at **0.17** $ per second of generated video at 720p, and **0.29** $ per second at 1080p.                                                                                                                                                                                 | catalogue  |
| `blackforestlabs/flux-3/keyframes-to-video`        | Your request will be charged at **0.17** $ per second of generated video at 720p, and **0.29** $ per second at 1080p.                                                                                                                                                                                 | catalogue  |
| `fal-ai/luma-dream-machine/ray-2/image-to-video`   | Your request will cost $0.5 per 5 second.                                                                                                                                                                                                                                                             | model page |
| `fal-ai/ltx-2.3/image-to-video`                    | Your request will cost $0.08 per second for 1080p, $0.16 per second for 1440p or $0.32 per second for 2160p.                                                                                                                                                                                          | catalogue  |
| `minimax/h3/image-to-video`                        | Video costs **$0.08** per second at **768p**, **$0.13** per second at **2K** and **$0.16** per second at **4K**.                                                                                                                                                                                      | catalogue  |
| `fal-ai/wan-flf2v`                                 | For a video generation, your request will cost **$0.2** at 480p resolution and **0.4$** at 720p resolution. For **$1** you can run this model with **approximately 5 times**. More than the default frames will cost 1.25x more.                                                                      | catalogue  |
| `fal-ai/pika/v2.2/pikaframes`                      | Your request will cost $0.04 per second for 720p or $0.06 per second for 1080p, with a minimum of 5 billable seconds - $0.20 for 720p and $0.30 for 1080p.                                                                                                                                            | catalogue  |

### Cost of one 5-second 21:9 hero clip

Arithmetic on the published rates above, not a measured invoice. Only the three models that can actually serve a
21:9 animate stage are comparable; Veo 3.1 is listed to show what the ruled-out option would have cost.

| Model                                              | 21:9                      | Rate                  | 5s at 720p                                      |
| -------------------------------------------------- | ------------------------- | --------------------- | ----------------------------------------------- |
| `fal-ai/kling-video/o1/image-to-video`             | inherits from start image | $0.112/s              | **$0.56**                                       |
| `blackforestlabs/flux-3/first-last-frame-to-video` | declared                  | $0.17/s at 720p       | **$0.85**                                       |
| `fal-ai/luma-dream-machine/ray-2/image-to-video`   | declared                  | $0.50 per 5s clip     | **$0.50** — but 540p by default, and only 5s/9s |
| `fal-ai/veo3.1/first-last-frame-to-video`          | **cannot**                | $0.20/s without audio | $1.00 — ruled out on aspect regardless          |

Luma is cheapest per clip but must be forced off its 540p default (PRD §6.3's point about provider defaults, again)
and cannot do a 6–8s loop at all. flux-3 costs 52% more than Kling O1 and is the only one of the three that
_declares_ 21:9 rather than inheriting it.

At the source stage the spread is 7.5x: `xai/grok-imagine-image` at $0.02/image up to `fal-ai/nano-banana-pro` at
$0.15/image. Since #26 generates **four candidates per run**, that is $0.08 versus $0.60 per pick-one round, before
any restyle. Grok has neither 21:9 nor `seed`, so it is not a substitute — the cheapest 21:9-with-seed source is
`fal-ai/flux-pro/kontext/text-to-image` at $0.04/image, $0.16 per four-up.

## Findings that change existing decisions

### 1. The epic's "single point of failure for 21:9" risk is retired

#11 carries: _"Only Kling O1 has a confirmed aspect range covering ultrawide; every other end-frame-capable model
surveyed lacks confirmed support."_ The schemas say otherwise. Two further models declare **both** a `21:9`
aspect enum and an end-frame field:

- `blackforestlabs/flux-3/first-last-frame-to-video` — `21:9` and `2:1`, `end_image_url` **required**, 5–20s
- `fal-ai/luma-dream-machine/ray-2/image-to-video` — `21:9`, `end_image_url`, but only 5s/9s

And the premise about Kling O1 was miscast: **`fal-ai/kling-video/o1/image-to-video` has no aspect parameter at
all.** Its entire input is `prompt`, `start_image_url`, `end_image_url`, `duration`. It does not "support 21:9" —
it inherits geometry from the start image and cannot refuse a ratio. That is `inheritsFromSource` in
`ModelCapabilities`, not an enum. The risk as written was resting on a category error.

Conversely, `fal-ai/veo3.1/first-last-frame-to-video` offers only `auto`, `16:9`, `9:16` — **it cannot serve a
21:9 hero**, which rules out the model PRD §9.1 treats as the best-verified alternative.

### 2. Kling O1's duration is settled

#11 records that _"Kling O1's duration enum has returned three contradictory answers across research rounds."_
The schema gives one: an integer enum `3,4,5,6,7,8,9,10`, default `5`, read 2026-08-09. Note it is **bare
integers**, whereas Veo 3.1 uses strings (`4s`,`6s`,`8s`) and Luma uses `5s`/`9s`. `durations: readonly string[]`
must not assume a single idiom, and `minimax/h3` has no enum at all — an integer 5–15.

### 3. There is almost nothing to measure for `strength`

Of all 33 endpoints, exactly one exposes a strength/denoise field: `fal-ai/flux/dev/image-to-image`, with
`strength`, **schema default `0.95`** — confirming PRD §6.3's warning verbatim. Every modern edit model
(Nano Banana Pro, gpt-image-2, Qwen-Image 2, Grok, FLUX Kontext) has **no strength parameter**; they are
instruction-driven edits, not denoise-driven ones.

This materially shrinks #35: "a measured usable window per model" only has one model to measure, and only if
`flux/dev/image-to-image` survives selection at all. `strengthParam` is `null` across the modern field.

### 4. The default restyle model and `negative_prompt` are in direct conflict

The hero-recipes v4 library names `nano-banana-pro-edit` as the default restyle choice, and all 44 recipes carry
a `negative`. **`fal-ai/nano-banana-pro/edit` has no `negative_prompt` field.** On the style stage the only
candidates that do are `fal-ai/qwen-image-2/edit` and `fal-ai/qwen-image-2/pro/edit` — and those top out at
`landscape_16_9`, so they cannot produce a 21:9 restyle.

There is no style-stage model in this field that has both `negative_prompt` and 21:9. #35 has to trade one
against the other, or push the `negative` instruction into the prompt body for models that lack the field.

### 5. `model_hints` ids

| Hint in the library    | Resolves to                                     | Status                                    |
| ---------------------- | ----------------------------------------------- | ----------------------------------------- |
| `nano-banana-pro-edit` | `fal-ai/nano-banana-pro/edit`                   | resolves cleanly                          |
| `gpt-image-2`          | `openai/gpt-image-2`, `openai/gpt-image-2/edit` | **namespace is `openai/`, not `fal-ai/`** |
| `flux-kontext`         | ambiguous — five live endpoints                 | **needs a decision in #35**               |

The `flux-kontext` candidates are `fal-ai/flux-pro/kontext`, `.../kontext/max`, `.../kontext/text-to-image`,
`.../kontext/max/text-to-image`, `fal-ai/flux-kontext/dev`. They differ in stage and in whether they declare an
aspect enum, so the hint cannot be resolved mechanically.

### 6. The current fixture id for FLUX Kontext is on the wrong stage

`FIXTURE_REGISTRY` declares `fal-ai/flux-pro/kontext` at stage `source`. That endpoint is image-to-image and
**requires `image_url`** — a text-to-image call against it will fail. The source-stage id is
`fal-ai/flux-pro/kontext/text-to-image`. Both declare the same `21:9` enum, so only the id is wrong, but it is
wrong in a way that fails at submit.

### 7. `gpt-image-2` and Grok Imagine have no `seed`

`openai/gpt-image-2` (both variants) and every `xai/grok-imagine-image` variant lack `seed`. Per PRD §1/§4.3 the
recipe premise does not hold on those models, so they surface as a **disabled** seed control with a reason, not a
hidden one. Grok additionally has no `21:9` — its widest are `2:1` and `20:9`.

## Gap in `ModelCapabilities` (reported, not closed)

`aspects` is typed `readonly AspectId[] | 'inheritsFromSource'`, which assumes every model speaks in ratio ids.
The field splits into **three** idioms, not two:

1. `aspect_ratio` with ratio-string enums — FLUX Kontext, Nano Banana, Luma, Grok, flux-3
2. `image_size` with **named tokens** (`landscape_16_9`, `square_hd`, …) — FLUX Pro 1.1, FLUX 2 Pro,
   Qwen-Image 2, gpt-image-2
3. no aspect field at all — Kling O1/O3, Minimax H3, `flux/dev/image-to-image`

Idiom 2 cannot express 21:9 _at all_, and mapping an `AspectId` onto a named token is lossy in general. Modelling
it as `AspectId[]` would record "no 21:9" correctly but would lose the fact that the request builder must emit a
different field name with different values. This is a real gap; #25 should decide the shape.

## Handover to #35

Settled here, no further work needed:

- Endpoint ids for every candidate, all returning 200
- Aspect idiom, enum and 21:9 reachability per model
- `seed`, `negative_prompt`, end-frame, duration and resolution presence, names, enums and schema defaults
- Queue shape: uniformly submit-poll
- Stage for the two previously-unevaluated candidates: **Minimax H3 is a video model** (`minimax/h3/*`), not an
  image model; **Grok Imagine** is both, via `xai/grok-imagine-image` and `xai/grok-imagine-video`

Still open, and still human work:

- ~~**Price.**~~ Collected — see "Price". All 33 models have a published rate as of 2026-08-09: the catalogue
  field where it exists, the rendered model page for the 14 where it does not. Still needs a human eye on the
  conditional surcharges (audio on/off, resolution multipliers, token-priced gpt-image-2) before any of it becomes
  a `price` field, and none of it is billing-verified.
- **Measured strength window** — now a one-model question at most (see finding 3).
- **Default model per stage**, including the 21:9-versus-`negative_prompt` trade on the style stage (finding 4).
- **PRD §9 rewrite**, and the `flux-kontext` hint decision (finding 5).
