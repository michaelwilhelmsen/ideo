# Task 1 — E0: Verification spike

> **This is not app code.** No commits to `src/` or `src-tauri/` from this task.
> Output is answers written back into [`../prd/ideo-prd.md`](../prd/ideo-prd.md) §12
> and a first draft of the capability registry JSON.
>
> Gates **E2, E4, E5, E6**. Estimated ~1 hour.

## Why this exists

Nine facts the design depends on could not be established from documentation
(PRD §12). Several of them, if guessed wrong, cost a rewrite rather than a fix:

- The **restyle `strength` range** determines whether the style stage preserves
  composition at all.
- **Prose vs tag-list prompting** decides whether 22 drafted presets need
  reformulating.
- **Kling O1's duration enum** has returned three contradictory answers across
  research rounds.

Doc-scraping already failed on these twice. A real key answers them in minutes.

## Prerequisites

```bash
brew install jq          # response parsing
export FAL_KEY='...'     # a real fal.ai key — do NOT commit this
mkdir -p /tmp/ideo-spike && cd /tmp/ideo-spike
```

Confirmed API shapes (from `docs/research/models.md`):

| Operation | Request |
|---|---|
| Submit (queue) | `POST https://queue.fal.run/{model-id}` |
| Status | `GET https://queue.fal.run/{model-id}/requests/{id}/status` |
| Result | `GET https://queue.fal.run/{model-id}/requests/{id}` |
| Cancel | `PUT https://queue.fal.run/{model-id}/requests/{id}/cancel` |
| Auth header | `Authorization: Key $FAL_KEY` |

`https://fal.run/{model-id}` (synchronous, no queue) is widely referenced but
**unverified** — test 4 confirms whether it works, since it would simplify the
cheap-validation path considerably.

---

## Test 1 — Free key validation

**Question:** can we verify a key without being charged? (PRD §7)

Record the HTTP status for each. We want an endpoint that returns 200 with a
valid key and 401 with a bad one, while billing nothing.

```bash
# Candidate: account/billing. May require an Admin-scoped key — that's the thing to find out.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Key $FAL_KEY" \
  'https://rest.alpha.fal.ai/billing/user-balance'

curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Key $FAL_KEY" \
  'https://fal.ai/api/account/billing?expand=credits'

# Control: the same call with a deliberately bad key must NOT return 200.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Key not-a-real-key" \
  'https://rest.alpha.fal.ai/billing/user-balance'
```

Both URLs are **unverified guesses** from secondary sources. If neither works, try
the network tab on fal.ai's own dashboard while it loads your balance — that
reveals the real endpoint faster than searching.

**Record:** endpoint, status with good key, status with bad key, response body shape.

## Test 2 — 401 vs 404 discrimination

**Question:** if there's no free account endpoint, can a status lookup for a
nonexistent request id distinguish "bad key" from "no such request"? If yes,
that is a free validation path.

```bash
BOGUS=00000000-0000-0000-0000-000000000000
M=fal-ai/flux-pro/v1.1

# Valid key, nonexistent request → expect 404 if the key is accepted
curl -s -o /dev/null -w 'good key: %{http_code}\n' \
  -H "Authorization: Key $FAL_KEY" \
  "https://queue.fal.run/$M/requests/$BOGUS/status"

# Bad key, same request → expect 401
curl -s -o /dev/null -w 'bad  key: %{http_code}\n' \
  -H "Authorization: Key not-a-real-key" \
  "https://queue.fal.run/$M/requests/$BOGUS/status"
```

If these differ (404 vs 401), **use this as the validation path** — it is free and
needs no special key scope. This is the single most likely win in the spike.

## Test 3 — Schema audit → freeze the registry field list

**Question:** does the PRD §5 field list capture everything essential? (PRD §5, E2)

fal renders a JSON schema per model. Try:

```bash
for M in \
  "fal-ai/flux-pro/v1.1" \
  "fal-ai/flux-pro/kontext" \
  "fal-ai/flux-1/dev/image-to-image" \
  "fal-ai/nano-banana-pro" \
  "fal-ai/qwen-image" \
  "fal-ai/kling-video/o1/image-to-video"
do
  echo "=== $M ==="
  curl -s "https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=$M" \
    | jq -r '.components.schemas | keys[]' 2>/dev/null | head
done
```

The openapi URL is **unverified**. If it 404s, fall back to reading each model's
`/api` page in a browser and transcribing the input schema by hand.

For each model record: every input parameter, its type, default, and whether
required. Then answer:

1. Which parameters appear that PRD §5 would fail to capture? Watch for
   safety/content-filter flags, `output_format`, `acceleration`/speed modes,
   `num_images`, prompt-enhance flags, guidance naming, steps/scheduler.
2. Which proposed fields are unnecessary or derivable?
3. Are names consistent for the same concept across models — is it always `seed`,
   `image_url`, `num_images`? **Every inconsistency found is a field the registry
   must store rather than assume.**
4. Any required parameter varying per model that a generic UI could not guess?

## Test 4 — Kling O1 duration and pricing

**Question:** settle the three-way contradiction (3–10s / 3–15s / 5-or-10-only),
and get real prices. (PRD §12)

Read the allowed `duration` values straight from the schema fetched in test 3 —
do not trust any prior research note. Then check whether responses or headers
carry cost information:

```bash
curl -s -D headers.txt -X POST \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"abstract soft gradient, slow drift","image_size":{"width":1280,"height":720}}' \
  "https://queue.fal.run/fal-ai/flux-pro/v1.1" | tee submit.json
grep -i -E 'cost|bill|credit|price' headers.txt
```

Also check your fal dashboard billing page before and after the spike — the
delta divided by known calls gives real per-call cost even if no API exposes it.

**Record:** exact `duration` enum for Kling O1; per-call price for each
shortlisted model; whether cost is machine-readable anywhere.

## Test 5 — Prose vs tag-list on FLUX

**Question:** does FLUX genuinely prefer prose? (PRD §6.2 — decides 22 rewrites)

Same seed, same subject, two idioms. Use a style whose failure is visually
obvious — film grain is a good probe because it either reads as grain or it doesn't.

```bash
SEED=12345
M=fal-ai/flux-pro/v1.1

# A: tag-list idiom (how the 22 presets are currently written)
curl -s -X POST -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" \
  -d "{\"prompt\":\"abstract flowing gradient field, shot on 35mm film, visible film grain, ISO 3200, analog color desaturation, subtle halation\",\"seed\":$SEED,\"image_size\":{\"width\":1280,\"height\":720}}" \
  "https://queue.fal.run/$M" | jq -r .request_id

# B: prose idiom (woven into one sentence)
curl -s -X POST -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" \
  -d "{\"prompt\":\"An abstract flowing gradient field, photographed on 35mm film at ISO 3200 so heavy organic grain and subtle halation sit across the desaturated analog colors.\",\"seed\":$SEED,\"image_size\":{\"width\":1280,\"height\":720}}" \
  "https://queue.fal.run/$M" | jq -r .request_id
```

Poll each `request_id`, download both, compare side by side.

**Decision rule:** if prose is clearly better, the 22 presets get reformulated and
the `prose` variant becomes primary. If they're indistinguishable, keep the
existing tag-lists and save the rewrite. **Record the actual images** — this
decision should rest on pixels, not on the secondary sources that suggested it.

## Test 6 — Restyle `strength` sweep

**Question:** what value preserves composition while changing the look?
(PRD §6.3 — the style stage depends on this)

fal's default is 0.95 with a note that "higher is better for this model", which
inverts classic SD intuition. Kontext's default is 0.1. Both cannot be right for
our use case.

Pick one source image, hold prompt and seed fixed, sweep strength:

```bash
IMG='https://<a-public-url-or-data-uri>'
for S in 0.1 0.3 0.5 0.65 0.8 0.95; do
  curl -s -X POST -H "Authorization: Key $FAL_KEY" -H "Content-Type: application/json" \
    -d "{\"prompt\":\"risograph print, halftone dots, two-color ink, visible paper grain\",\"image_url\":\"$IMG\",\"strength\":$S,\"seed\":777}" \
    "https://queue.fal.run/fal-ai/flux-1/dev/image-to-image" | jq -r "\"$S \" + .request_id"
done
```

Repeat for `fal-ai/flux-pro/kontext` — **the correct value is likely different per
model**, which is exactly why the registry stores per-model defaults.

**Record:** the value where style changes but composition survives, per model.
This becomes the registry default, not a global constant.

## Test 7 — File upload

**Question:** does the REST upload flow work from a plain HTTP client? (PRD §12)

```bash
curl -s -X POST -H "Authorization: Key $FAL_KEY" \
  'https://rest.alpha.fal.ai/storage/auth/token?storage_type=fal-cdn-v3' | tee token.json
```

If that yields a token, follow with the upload it describes. If the flow doesn't
work, test the fallback: submit an image-to-image call with a **base64 data URI**
inline and find where it breaks — try ~1MB, ~5MB, ~10MB and record the ceiling,
since no documented limit exists.

**Record:** whether REST upload works; practical max inline payload.

## Test 8 — Ultrawide video fallback

**Question:** does any video model other than Kling O1 accept 21:9? (PRD §9.1 —
currently a single point of failure)

Submit a 2520×1080 (2.33) start frame to each and record accept/reject:

- `fal-ai/luma-dream-machine/ray-2/image-to-video` (has confirmed `end_image_url`)
- `fal-ai/veo3.1/first-last-frame-to-video`
- `fal-ai/wan-flf2v`

Rejections are cheap — a 4xx costs nothing. **Record:** which accept ultrawide,
and each one's end-frame parameter name.

---

## Deliverables

1. **PRD §12 updated** — every row either answered with the value and date, or
   restated as still-unknown with what was tried. Do not delete rows; the table is
   the honest record.
2. **Registry field list frozen** in PRD §5, amended per test 3.
3. **First `models.json` draft** with real entries for FLUX Kontext, flux-pro/v1.1,
   flux-1/dev/image-to-image, Nano Banana Pro, Kling O1 — including per-model
   `strengthParam` defaults from test 6 and `price.verifiedOn` from test 4.
4. **Preset idiom decision** recorded in PRD §6.2, with the two test-5 images
   committed as evidence.
5. **Key validation strategy** chosen in PRD §7 — free endpoint, 401/404 trick, or
   cheapest paid call.

## Results — run 2026-08-08, total spend $0.23

| # | Question | Answer | Verified |
|---|---|---|---|
| 1 | Free validation endpoint | **Yes.** `GET rest.alpha.fal.ai/billing/user_balance` → 200 + bare number; 401 on bad/malformed/absent key. Note the underscore; `user-balance` 404s. | ✅ live |
| 2 | 401 vs 404 discriminates | **Moot** — the constructed status URL returns 405 regardless of key. Not needed; #1 is better. | ✅ live |
| 3 | Registry fields missing | Added `durationFormat`, `aspectParam`, `resolutionParam`, `defaults`. Duration appears as bare string / `"5s"` / integer across models; end-frame is `end_image_url` on four models but `last_frame_url` on Veo. | ✅ live schemas |
| 4 | Kling O1 duration enum | `"3"`–`"10"`, default `"5"` — **strings**. Settles the three-way contradiction. Kling has **no** aspect, resolution or seed param. | ✅ live |
| 4 | Real prices | `flux-pro/v1.1` **$0.04**/img; `flux-1/dev/image-to-image` **$0.025**/img at 0.90 MP. Measured by balance delta; billing lags minutes. Video unmeasured. | ✅ measured |
| 5 | Prose or tag-list | **Tag-list — no rewrite.** Prose was smoother, i.e. further from the brief. Separately: **neither showed film grain**, so texture-led styles are unreliable on this model. | ✅ images |
| 6 | Restyle strength | 0.3 no-op → 0.65/0.75 style + composition intact → 0.85 drifts → **0.95 (fal's default) discards the input**. Ship 0.7. | ✅ images |
| 7 | REST upload / base64 ceiling | **Still open.** Sidestepped by reusing fal-hosted result URLs as img2img input (works, free). Must be settled before #27. | ❌ |
| 8 | Ultrawide video fallback | **Yes — Luma Ray 2**, explicit `21:9`/`9:21` enum plus `end_image_url`. Arguably the better primary since Kling only inherits aspect from the source. | ✅ live schemas |

### Also found, unprompted

- **Never construct queue URLs.** Submit returns `status_url`/`response_url`/`cancel_url`, and they omit the version sub-path — the constructed versioned form 405s.
- **Requested dimensions are not honoured.** 1280×720 → 1280×704 (snapped to /16), changing aspect 1.78 → 1.82.
- **Key format:** 69 chars, `uuid:hex32`.
- **The balance endpoint doubles as a cost meter and a low-balance guard** before expensive video calls.

### Still open after this spike

REST upload flow, fal rate limits, whether gpt-image-2 is reachable via fal, and real video pricing. None block the next ticket (#21).

## Notes

- **Do not commit `FAL_KEY`.** Nothing from `/tmp/ideo-spike` belongs in the repo
  except the two test-5 comparison images.
- Every URL marked unverified above is a guess from secondary sources. A 404 is a
  finding, not a failure — record it and move on rather than searching for long.
- Total spend should be well under $5. If a test looks like it will cost more than
  that, stop and reconsider the design instead.
