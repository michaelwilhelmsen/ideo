# fal.ai — Follow-up research: open gaps

Søkebudsjett brukt: 14/14 søk/fetch. Alle 14 er brukt; rapporten er derfor endelig med de hullene som står under.

## 1. Key validation without charge

[CONFIRMED] There IS a free, non-billing endpoint, but it requires an **Admin-scoped** API key, not a normal one:

- `GET /account/billing` (Platform APIs), documented at https://fal.ai/docs/platform-apis/v1/account/billing
- Auth header: `Authorization: Key YOUR_ADMIN_API_KEY`
- Security scheme is explicitly `adminApiKey` — a regular (non-admin) `FAL_KEY` will likely be rejected here even if it works fine for model calls.
- Optional query `?expand=credits` returns current credit balance/currency. This is a pure account-info read, not a generation call, so it does **not** trigger model billing.
- Base path structure implies `https://api.fal.ai/v1/account/billing?expand=credits` but I could not confirm the exact host in the docs text I fetched (the doc page itself is served under `fal.ai/docs/platform-apis/...`, not necessarily the API host) — [UNVERIFIED: exact API host/base URL for platform APIs].

Caveats / what I could NOT verify within budget:

- [UNVERIFIED] Whether a **normal** (non-admin) `FAL_KEY` can call `/account/billing` at all, or gets 401/403. Docs only show the admin scheme.
- [UNVERIFIED] Behavior of `GET /requests/{bogus-id}/status` — whether a bad key vs. a non-existent request ID are distinguishable (401 vs 404). This needs an actual live call to test; I could not find this documented, and did not want to spend a real generation call or guess.
- [UNVERIFIED] Whether docs.fal.ai has a dedicated "platform-apis" account section beyond billing (e.g. a lightweight `/account` or `/whoami`). Search only surfaced the billing endpoint and an "Authentication" reference page (which repeatedly 429'd when fetched, so its content is unconfirmed).

**Practical fallback if no free key-check path is confirmed for your key type:** the cheapest real generation call among the models checked is `flux-pro/v1.1` text-to-image at **$0.055/megapixel** [CONFIRMED, see §2] — a small square image (e.g. 512×512 ≈ 0.26MP, billed rounded up to 1MP) costs **$0.055** per call, making it the cheapest live-fire key check found in this round.

**Bottom line:** a free path plausibly exists (`/account/billing` with an Admin key) but is unverified for a standard key, and the request-status 401/404 distinction is unverified. Do not assume the free path works without an Admin key in hand to test.

## 2. Actual pricing

| Model                              | Price                                                                                                                                                                                                                                                                                                | Kilde                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flux-pro/v1.1`                    | **$0.055 per megapixel**, rounded up to nearest megapixel                                                                                                                                                                                                                                            | [SANNSYNLIG] — found via search snippet referencing fal's own model page https://fal.ai/models/fal-ai/flux-pro/v1.1 ; the general https://fal.ai/pricing page does NOT list this model directly (confirmed by direct fetch — that page only shows Wan 2.5, Kling 2.5 Turbo Pro, Veo 3, Ovi, Seedream V4, Flux Kontext Pro, Nanobanana, Qwen). Treat as [SANNSYNLIG] not fully [DOK] since I did not load the exact per-model pricing widget myself (page render likely needs JS; my fetch got a markdown conversion that omitted the price block on the model page itself). |
| `flux-2-pro`                       | [IKKE FUNNET] — not present on the general pricing page fetch, and I had no budget left for a dedicated per-model fetch. Søkte: "fal.ai flux-2-pro pricing" was not run separately due to budget.                                                                                                    |
| `flux-1/dev/image-to-image`        | [IKKE FUNNET] — same constraint; general pricing page fetch did not list this model, and no dedicated model-page fetch was made for pricing (only for the previously-confirmed `strength` param, done in an earlier round).                                                                          |
| `kling-video/o1/image-to-video`    | [IKKE FUNNET] — the model's `/api` page was fetched but the price block was not present in the converted markdown; only spec fields (duration options, image constraints) came through. General `/pricing` page lists "Kling 2.5 Turbo Pro" but that is a **different model**, not `kling-video/o1`. |
| `veo3.1/first-last-frame-to-video` | [IKKE FUNNET] — model `/api` page fetched; price block not present in converted content. General `/pricing` page lists plain "Veo 3", not the `3.1/first-last-frame-to-video` variant.                                                                                                               |

**Konklusjon for §2:** fal.ai's public `/pricing` page is a curated marketing list, not a complete price sheet — it does not cover most of the specific model IDs this app targets. Per-model `/api` pages likely do render a price widget in-browser (client-side), but my fetch tool converts to markdown and consistently dropped that widget across three separate model pages (flux-pro/v1.1, kling-video/o1, veo3.1). **Only the flux-pro/v1.1 $0.055/MP figure surfaced, and even that came from a search-engine snippet, not a page I directly rendered — so treat it as [SANNSYNLIG], not [DOK].** Recommend verifying all four prices with a live authenticated dry-run or by viewing the dashboard directly before committing to cost estimates.

## 3. Video model specs

|                        | kling-video/o1/image-to-video                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | veo3.1/first-last-frame-to-video                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output resolution      | [IKKE FUNNET] — not stated on the `/api` page as fetched (only input constraints: image ≤10MB, min 300px/side, aspect ratio 0.40–2.50, confirmed in a prior round)                                                                                                                                                                                                                                                                                                                                                                                                                                    | **720p or 1080p, 16:9 or 9:16** [CONFIRMED via model page content] https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video/api                          |
| Max duration           | Prior-round-confirmed enum: **3–10s, default 5s**. Note: this fresh fetch of the same `/api` page returned a _different_ duration list — "3,4,5,6,7,8,9,10,11,12,13,14,15" seconds — which conflicts with the previously confirmed 3–10s. ⚠️ **[INCONSISTENCY FLAGGED]**: either the model spec changed since the last research round, the fetch pulled a related/variant model's schema, or the markdown conversion merged fields from a different section. Do not rely on either number without re-checking the live JSON schema at the model's `/api` page immediately before building against it. | **4s, 6s, or 8s** [CONFIRMED] https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video/api. Optional audio generation available. Input images up to 8MB. |
| Price                  | [IKKE FUNNET] (see §2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [IKKE FUNNET] (see §2)                                                                                                                                        |
| Cheaper for a 5s clip? | **Cannot determine** — neither price was found (§2), and Veo 3.1 does not even offer a 5s option (only 4/6/8s), so a like-for-like 5s comparison isn't possible anyway; would need 4s Veo vs 5s Kling compared per-second.                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                               |

**Bottom line for §3:** resolution and duration for Veo 3.1 are solid [CONFIRMED]. Kling o1 resolution is an outright gap, and Kling o1 duration is now **contradictory** between research rounds — this is the single most important flag in this report and should be re-verified against the live API schema before any UI copy or duration limits are hard-coded.

## 4. File upload via REST (no JS SDK)

> **Resolved 2026-08-09 (#50).** The [UNVERIFIED] note this section used to carry has been replaced by the wire protocol read directly from fal's own client source — `fal-ai/fal-js` (`libs/client/src/storage.ts`, `config.ts`) and `fal-ai/fal` (`projects/fal_client/src/fal_client/client.py`). A reference client is a primary source for a wire protocol in a way a prose doc page is not: it is the thing the server is known to answer. **Ideo implements flow A2 below.**

Three of the old note's details were wrong, and each would have broken a blind implementation:

> - the host was given as `rest.alpha.fal.ai`; it is **`rest.fal.ai`**
> - the upload auth was given as a hardcoded `Bearer`; it is **`{token_type} {token}`**, echoing what the token call returned
> - the `/storage/upload/initiate` path was dismissed as "alternate/older"; it is **what the current JS client does**

There are genuinely **two** flows, both current, and fal's own clients disagree about which to use. Either works for model input files.

**A1) Token flow — what the Python client does [CONFIRMED — read at source]:**

1. `POST https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3`, `Authorization: Key $FAL_KEY`, body `{}` → `{token, token_type, base_url, expires_at}`. Expiry is compared against `datetime.now(timezone.utc)`, so `expires_at` is an ISO timestamp meant to be cached against.
2. `POST {base_url}/files/upload`, `Authorization: {token_type} {token}`, plus `Content-Type` and `X-Fal-File-Name` → `{access_url}`, which is the public URL.
3. Files over 100 MB go multipart: `{base_url}/files/upload/multipart` → `{access_url, uploadId}`, then `PUT {access_url}/multipart/{uploadId}/{part}`, then `POST …/complete`.

**A2) Initiate flow — what the JS client does [CONFIRMED — read at source]. This is what Ideo uses:**

1. `POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3`, `Authorization: Key $FAL_KEY`, body `{"content_type": "...", "file_name": "..."}` → `{file_url, upload_url}`.
2. `PUT {upload_url}` with `Content-Type` and the raw bytes as the body. **No `Authorization` header** — `upload_url` is already signed and single-purpose, and adding one risks a signature mismatch on whichever bucket is behind it.
3. `file_url` is the public URL to hand the model, valid once the PUT succeeds.

Chosen over A1 for two reasons: there is no token lifecycle to cache, expire or renew mid-run, and it authenticates with the same `Key {key}` header as every other call in this codebase, so there is one auth scheme in the client rather than two.

**B) Serverless "Files" API (different subsystem, for apps deployed on fal, not necessarily for feeding model inputs) [as rendered from https://fal.ai/docs/documentation/development/file-storage]:**

- `POST /serverless/files/file/local/{target_path}` — small files only, **~4.5MB per request** limit, target_path cannot contain `/`.
- `POST /serverless/files/file/url/{file}` — upload by referencing a URL, up to 5GB, must complete within 10 minutes.
- `GET /serverless/files/list`, `GET /serverless/files/file/{file}` — list/download.
- Auth headers for these were **not shown** in the fetched content.
- This looks like it's for fal _Serverless app_ deployments' own file storage, not the generic "give a model an input image" flow — [UNVERIFIED which one this repo actually needs].

**Practical fallback confirmed to work regardless:** model input fields accept **base64 data URIs directly in the JSON payload** (documented behavior for file inputs generally, per client-library docs) — no upload step needed at all. **Practical max size for a base64 data URI in a request payload was NOT found as a stated number** [IKKE FUNNET — søkte etter "fal.ai base64 data uri max size payload limit", not run separately due to budget]. As a rule of thumb for typical HTTP/queue APIs, keep inline base64 images well under ~10MB raw (which becomes ~13.3MB base64-encoded) — this is an inference from the Kling o1 model's own 10MB raw-image input cap [CONFIRMED in prior round] and general REST payload practice, **not a directly documented fal-wide limit.**

**Recommendation [superseded 2026-08-09]:** the original advice was to start with inline base64 for images under a few MB and only pursue the upload flow "if you hit payload-size problems". That is exactly what happened, and the call was right — inline base64 got #28 through #30 shipped without an unverified endpoint in the way.

What it under-weighted is that the problem arrives sooner than "a few MB" suggests. The image goes in the body _per field_, and a seamless loop (#30) names the same still twice, so the effective payload is double the encoded size. A 5 MB styled PNG became ~13 MB of body and timed out the submit — with the failure surfacing as a bare transport error rather than anything about size. Inline base64 is a good default only where the image is small **and** named once.

## 5. Rate limits

[IKKE FUNNET]. Two attempts to reach a rate-limits documentation page both failed:

- `https://docs.fal.ai/model-apis/rate-limits` → HTTP 429 (ironically throttled itself, or simply doesn't exist / redirects oddly)
- `https://fal.ai/docs/api-reference/model-apis/rate-limits` → HTTP 404 (page does not exist at that path)

No budget remained to search further (search budget exhausted at 14/14). I found **no documented concurrent-request cap, no per-minute limit, and no explicit statement of which HTTP status/headers signal throttling** (e.g. standard `429 Too Many Requests` with `Retry-After` is the industry default and plausible, but I have **no fal-specific confirmation** of this — do not hard-code retry logic against an assumed header without checking a live 429 response first).

**Gap explicitly flagged:** rate limiting is entirely unverified. If the Rust client needs backoff/retry logic, treat this as an open item — either test empirically against the live queue API or search fal's docs for a "Limits" or "Errors" page under `docs.fal.ai/model-apis/` (search paths not yet exhausted: `/model-apis/errors`, `/model-apis/queue`, dashboard "Usage" pages).

## 6. Max resolution and 21:9 custom size feasibility

**flux-pro/v1.1** [partially CONFIRMED from https://fal.ai/models/fal-ai/flux-pro/v1.1/api]:

- Preset `image_size` options: `square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9` (confirms prior round's note that there's no 21:9 or 3:2 _preset_).
- **Custom dimensions ARE supported** — pass `width`/`height` as an object, e.g. `{"width": 1280, "height": 720}` [CONFIRMED, same page].
- The page's aspect-ratio enum text also lists `21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 9:21` as available ratios — [SANNSYNLIG, needs care]: this looks like it may belong to a _different_ field/model variant (e.g. flux-pro/v1.1-ultra) that was mixed into the converted markdown, since the prior confirmed research explicitly said v1.1 presets have **no** 21:9. Treat the aspect-ratio list as unverified for the plain `v1.1` endpoint specifically.
- **Absolute maximum width/height numbers (in pixels) were NOT found** — the docs describe how to _set_ custom sizes but the converted content did not include a stated max (e.g. "max 2048px" or similar). [IKKE FUNNET — søkte via direct fetch of the model's `/api` page; the ceiling values were not present in the rendered markdown].
- Therefore: whether **2520×1080** (a 21:9 custom size) is within limits is **[UNVERIFIED]** — the mechanism (custom width/height) is confirmed to exist, but the numeric ceiling is not confirmed either way. Given FLUX pro models commonly cap around 1440–2048px on the long edge in community reports, 2520px width is plausibly **over** typical limits, but this is **not a documented fact** and should not be treated as one.

**flux-2-pro**: [IKKE FUNNET] — no dedicated fetch was performed for this model within budget; its `/api` page was never loaded. No max-resolution or aspect-ratio data available for this model in this report.

**Recommendation:** before shipping a 2520×1080 export size, do a live test call to `fal-ai/flux-pro/v1.1` with that exact width/height and check for a 422 validation error naming the actual max — this is faster and more reliable than continuing to search docs that don't render the limit in fetched markdown.

## Hull og usikkerhet

- Om en vanlig (ikke-admin) `FAL_KEY` kan kalle `/account/billing` gratis — kun admin-scope er dokumentert.
- Nøyaktig API-host/base-URL for platform-APIs (f.eks. `api.fal.ai` vs. noe annet).
- Hvordan `GET /requests/{id}/status` skiller 401 (feil nøkkel) fra 404 (ukjent request-id) — udokumentert, krever live-test.
- Faktisk pris for `flux-2-pro`, `flux-1/dev/image-to-image`, `kling-video/o1/image-to-video` og `veo3.1/first-last-frame-to-video` — fal sin generelle `/pricing`-side dekker ikke disse modell-ID-ene direkte, og per-modell prisvisning ble ikke hentet ut i konvertert markdown for noen av de tre modell-sidene jeg lastet.
- Output-oppløsning for `kling-video/o1/image-to-video` — ikke funnet på `/api`-siden.
- **Motstridende varighetsdata for Kling o1**: forrige runde bekreftet 3–10s (default 5s); denne runden hentet 3–15s fra samme sidetype. Må reverifiseres mot live schema.
- Eksakt wire-protokoll (feltnavn, respons-JSON, token-TTL) for `storage/auth/token` → `{base_url}/files/upload`-flyten — kun sett via sekundærkilder (GitHub/glama-speil), ikke en fal.ai-primærside jeg selv rendret.
- Praktisk maks størrelse for base64 data-URI i payload — ikke et dokumentert tall, kun en fornuftig tommelfingerregel avledet fra Klings 10MB-bildegrense.
- Rate limits: ingen dokumentasjon funnet i det hele tatt (to sidetreff: 429 og 404). Ingen bekreftet status/header for throttling.
- Maks pikselgrense for `flux-pro/v1.1` custom width/height, og dermed om 2520×1080 er innenfor grensen — mekanismen (custom size) er bekreftet, taket er ikke.
- `flux-2-pro`: ingen data hentet i denne runden (ingen dedikert fetch innenfor budsjett).

## Konklusjon / anbefaling

Denne runden bekrefter mest av det som IKKE var åpne spørsmål (Veo 3.1-spesifikasjoner er solide), men de fleste av de seks spørsmålene endte i delvise eller fulle hull — hovedsakelig fordi fal.ai sin generelle prisside ikke lister de spesifikke modell-ID-ene appen bruker, og fordi per-modell `/api`-sidenes prisvisning ikke kom med i markdown-konverteringen for tre modeller i strekk. Dette er et mønster, ikke tilfeldighet: **stol ikke på fetch-basert scraping av fal sine `/api`-sider for pris- og grenseverdier** — gjør heller et par billige live-testkall (f.eks. flux-pro/v1.1 på et lite bilde, kr ~0,055/MP) for å lese faktisk pris og valideringsfeil direkte fra APIet, og bekreft samtidig Kling o1s varighetsgrense siden den nå er selvmotsigende mellom to research-runder. For nøkkelvalidering: skaff en Admin-scope-nøkkel og test `/account/billing` — hvis det virker gratis, bruk det som helsesjekk; hvis appen bare har en vanlig nøkkel, er billigste reelle fallback et enkelt `flux-pro/v1.1`-kall til ca. $0,055.
