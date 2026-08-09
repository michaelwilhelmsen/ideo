# fal.ai modeller for hero-visual desktop-verktøy

Research date: 2026-08-08. Search budget brukt: 11 av maks 12 web-søk/fetch.

## Sammendrag

- **Text-to-image:** `fal-ai/flux-pro/v1.1` [DOK] har ingen native 21:9/3:2 preset — bruk custom width×height. FLUX.2-familien (`fal-ai/flux-2-pro`, `fal-ai/flux-2`) er nyere/rimeligere men ikke verifisert i detalj [SANNSYNLIG].
- **Image-to-image:** `fal-ai/flux-1/dev/image-to-image` [DOK] har en eksplisitt `strength`-parameter (default 0.95). Fals egen anbefaling ("higher is better for this model") er kontraintuitiv for komposisjonsbevarende restyling — må testes empirisk, ikke bare stole på default.
- **Image-to-video / loop:** `fal-ai/kling-video/o1/image-to-video` [DOK] har et eksplisitt `end_image_url`-parameter direkte på i2v-endepunktet — sett det likt startbildet for en sømløs loop. Dette er den klareste og best dokumenterte loop-mekanismen funnet. Flere andre modeller (Veo 3.1 first-last-frame, Vidu start-end, Framepack flf2v) har lignende mekanismer men er ikke verifisert i samme detalj. Kling/MiniMax/Seedance/Wan/LTX "standard" i2v-varianter har **ingen** dokumentert loop/end-frame-støtte i denne runden.
- **API-mekanikk:** Queue-flow (`queue.fal.run/{model-id}` → status → result), SSE-streaming for status, webhook via `?fal_webhook=`, auth via `Authorization: Key $FAL_KEY` — alt bekreftet mot fals egen dokumentasjon [DOK].
- **Auth for desktop-app:** ingen fal-dokumentasjon funnet som spesifikt adresserer lokale desktop-klienter — kun generell "ikke eksponer nøkkel i browser-JS"-føring. Nøkkelformat, scoping og rate-limit-tall er **ikke funnet**.

## 1. Text-to-image (bred aspect, abstrakte/grafiske bakgrunner)

Kandidater funnet så langt (fal.ai/models):

- `fal-ai/flux-pro/v1.1` — FLUX Pro 1.1. Pris ~$0.055/megapixel [SANNSYNLIG — pricepertoken.com aggregator, ikke fal selv, må verifiseres]. https://fal.ai/models/fal-ai/flux-pro/v1.1
- `fal-ai/flux-2-pro` — FLUX.2 [pro], nyere modell, ~$0.03/megapixel [SANNSYNLIG], opptil 4MP output, forbedret typografi. https://fal.ai/models/fal-ai/flux-2-pro
- `fal-ai/flux-2` — FLUX.2 [dev], støtter LoRA, rimeligere/raskere enn pro. https://fal.ai/models/fal-ai/flux-2
- `fal-ai/flux/schnell` — FLUX.1 [schnell], ultra-rask, lavere pris, lavere kvalitet.
- `fal-ai/flux-pro/v1.1-ultra-finetuned` — Ultra-variant, opptil 2K oppløsning, bedre fotorealisme [SANNSYNLIG].
- `fal-ai/flux-general` — generell FLUX-variant (playground funnet, ikke verifisert schema).

### `fal-ai/flux-pro/v1.1` — verifisert fra fal API-spec-side [DOK] (https://fal.ai/models/fal-ai/flux-pro/v1.1/api)

- **image_size** presets: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` — **ingen native 21:9 eller 3:2 preset**. Custom width/height objekt kan brukes i stedet for enum → 21:9/3:2 må settes som eksplisitt bredde×høyde.
- Params: `prompt`, `image_size`, `seed`, `num_images` (default 1), `output_format` (jpeg/png), `safety_tolerance` (1-6), `enhance_prompt`, `sync_mode`.
- Maks oppløsning: ikke dokumentert på siden [IKKE FUNNET].
- Pris: ikke oppgitt på API-spec-siden selv, kun via aggregator pricepertoken.com: ~$0.055/megapixel [SANNSYNLIG, ikke primærkilde].
- Latency: siden nevner "10x accelerated speeds" vs. forgjenger, ingen konkret ms/s-tall [IKKE FUNNET].
- Lisens: bruk må følge "FLUX.1 PRO Terms of Service".

Andre kandidater (kun sett via search-snippets, IKKE verifisert mot egen API-spec-side ennå):

- `fal-ai/flux-2-pro` — FLUX.2 [pro], ~$0.03/MP [SANNSYNLIG], opptil 4MP output. https://fal.ai/models/fal-ai/flux-2-pro
- `fal-ai/flux-2` — FLUX.2 [dev], støtter LoRA.
- `fal-ai/flux/schnell` — FLUX.1 [schnell], ultra-rask/billig.
- `fal-ai/flux-pro/v1.1-ultra-finetuned` — Ultra-variant, opptil 2K oppløsning, bedre fotorealisme [SANNSYNLIG].

Anbefaling for brede/grafiske bakgrunner: bruk custom width×height (ikke preset) på flux-pro/v1.1 eller flux-2-pro for å tvinge 21:9/3:2 — presets alene støtter ikke disse ratioene.

## 2. Image-to-image / restyling

### `fal-ai/flux-1/dev/image-to-image` [DOK] (https://fal.ai/models/fal-ai/flux-1/dev/image-to-image/api)

- Bildeinput: aksepterer offentlig URL **eller** base64 data-URI (fil-opplasting også nevnt).
- Strength-parameter kalles eksplisitt **`strength`**, default `0.95`, beskrevet som "strength of the initial image"; dokumentasjonen sier "higher strength values are better for this model" — merk: 0.95 er et _høyt_ endringsnivå (mindre komposisjons-bevaring). For god komposisjons-bevaring ved restyling bør man sannsynligvis teste lavere verdier (f.eks. 0.4-0.7), men fal sin egen anbefaling går motsatt vei — dette bør A/B-testes, ikke tas for gitt.
- Andre parametre: `num_inference_steps` (default 40), `guidance_scale` (default 3.5), `num_images`, `seed`, `enable_safety_checker`, `output_format`, `acceleration`.
- Komposisjonsbevaring: ikke eksplisitt dokumentert på siden [IKKE FUNNET] — er implisitt i img2img-mekanismen (strength styrer dette), men fal beskriver det ikke direkte som "preserves composition".
- Pris: ikke oppgitt på API-spec-siden, henvises til /pricing [IKKE FUNNET i denne runden].
- Lisensiering: "suitable for personal and commercial use".

Andre kandidater sett i søk (ikke verifisert i detalj):

- `fal-ai/clarity-upscaler` — img2img, mer for oppskalering/detalj-restaurering enn stilrestyling.
- LoRA-baserte img2img-varianter (`fal-ai/lora/inpaint` m.fl.) — mer for inpainting enn full restyling.
- Merk: FLUX.2-familien har sannsynligvis også en image-to-image/editing-variant (`fal-ai/flux-2/...`) men endepunkt-ID og strength-parameternavn er ikke verifisert i denne research-runden [IKKE FUNNET — bør sjekkes ved behov for nyere/bedre kvalitet enn flux-1/dev].

## 3. Image-to-video (ambient loops)

**Nøkkelfunn: for sømløse loops er det first/last-frame (start+end image) conditioning som er den relevante mekanismen** — sett `end_image_url` = samme bilde som `start`/input-bilde, og modellen genererer en overgang som lander tilbake der den startet. Ingen fal-modell nevner en dedikert "loop flag" i denne søkerunden.

### Modeller MED start/end-frame (last-frame) støtte → kan brukes til seamless loops

- **`fal-ai/kling-video/o1/image-to-video`** — Kling O1, "First Frame to Last Frame" generator, dual-keyframe interpolasjon mellom start- og sluttbilde med tekst-styrt stil. [DOK — modellnavn/beskrivelse] https://fal.ai/models/fal-ai/kling-video/o1/image-to-video — pris/varighet/oppløsning IKKE verifisert i denne runden.
- **Kling 3.0 Pro** — aksepterer `end_image_url` parameter i tillegg til start-bilde, samme start→end-transition-mønster [SANNSYNLIG, fra søk-snippet, ikke fetch-verifisert]. Eksakt endepunkt-ID ikke bekreftet (sannsynligvis `fal-ai/kling-video/v3/pro/image-to-video` -stil, men IKKE FUNNET direkte).
- **`fal-ai/veo3.1/first-last-frame-to-video`** og fast-variant **`fal-ai/veo3.1/fast/first-last-frame-to-video`** — Google Veo 3.1, dedikerte first/last-frame-endepunkter. [DOK — endepunkt-ID fra søk] https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video — pris/varighet ikke verifisert.
- **`fal-ai/vidu/start-end-to-video`** og **`fal-ai/vidu/q1/start-end-to-video`** — Vidu, genererer overgang mellom start- og sluttbilde. [DOK — endepunkt-ID] https://fal.ai/models/fal-ai/vidu/start-end-to-video/api
- **`fal-ai/framepack/flf2v`** — "flf2v" = First-Last-Frame-to-Video, egen Framepack-variant nettopp for dette. [DOK — navn tyder klart på funksjon] https://fal.ai/models/fal-ai/framepack/flf2v

### Modeller UTEN dokumentert last-frame/loop-støtte (kun bekreftet som ren image-to-video, start-bilde → fri bevegelse)

- **`fal-ai/kling-video/v2.1/standard/image-to-video`** (eller lignende "Kling 2.1 Standard") — standard i2v, IKKE nevnt med end-frame-parameter i søkeresultatene → sannsynligvis **ingen** loop/end-frame-støtte på denne enklere/billigere varianten [SANNSYNLIG, basert på fravær i søk, ikke eksplisitt bekreftet "does not support"].
- **MiniMax Hailuo-02 Image-to-Video** — 768p/512p oppløsning nevnt, ingen end-frame/loop-mekanisme funnet i søk → **antatt ingen** first/last-frame-støtte [IKKE BEKREFTET NEGATIVT — kun fravær av omtale].
- **Seedance 2.0 Mini** — beskrevet som rask/billig variant, ingen loop/end-frame-omtale funnet [IKKE FUNNET].
- **Wan 2.5 / Wan 2.7** — Wan 2.5 er tekst-til-video ifølge snippet (ikke i2v i utgangspunktet); Wan 2.7 beskrives som "enhanced motion smoothness" generelt, ingen end-frame-mekanisme nevnt [IKKE FUNNET].
- **LTX-2.3 (Pro/Fast)** — text/image/audio-to-video, ingen end-frame/loop-mekanisme nevnt i søk [IKKE FUNNET].
- **Luma Ray** — ikke dukket opp i søkeresultatene i det hele tatt i denne runden; fal har historisk hostet Luma Dream Machine/Ray-modeller, men verken tilstedeværelse, endepunkt-ID eller loop-støtte er bekreftet [IKKE FUNNET — bør søkes spesifikt "fal.ai Luma Ray2 image-to-video" hvis dette er en prioritert kandidat].

### Fortsatt uverifisert for ALLE video-kandidater (pga søkebudsjett)

- Eksakt maks varighet (sekunder) pr modell.
- Eksakt oppløsning pr modell (utover Hailuo-02s 768p/512p).
- Pris pr sekund eller pr klipp — ingen tall funnet i denne runden for noen video-modell [IKKE FUNNET].
- Om noen modell har en ekte "loop"-boolean-parameter (motsatt av å manuelt sette end_image = start_image) — ikke observert noe sted.

> **Rettelse, 2026-08-09 (#30): påstanden over er feil — én modell har en ekte `loop`-boolean.**
>
> `fal-ai/luma-dream-machine/ray-2/image-to-video` deklarerer `loop: { type: boolean, default: false }`, verifisert
> live og uautentisert mot
> `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/luma-dream-machine/ray-2/image-to-video`.
> Den er den eneste i hele feltet vi har kartlagt. Beskrivelsen i skjemaet er verdt å lese nøye: _"Whether the video
> should loop (end of video is blended with the beginning)"_ — altså en **blanding** av slutten inn i starten i
> etterkant, ikke betinging på et sluttbilde.
>
> #30 bruker den derfor **ikke**. Modellen får aldri beskjed om å komme tilbake til første bilde, så bevegelsen er
> ikke laget for å lukke seg; blandingen skjuler et klipp i stedet for å fjerne det. Vi sender start-stillbildet på
> nytt i `end_image_url` også på denne raden, akkurat som på Kling, Seedance, LTX og FLUX 3 — én mekanisme på tvers
> av hele registeret. `loop: true` er holdt i reserve dersom sluttbilde-betinging viser seg å gi en synlig skjøt.

**Praktisk konklusjon for "seamless ambient loops":** sett `image_url` (start) og `end_image_url`/`tail_image_url` (samme bilde eller en subtilt beveget variant) på en first/last-frame-modell. Kling O1 og Veo 3.1 first-last-frame ser mest lovende ut basert på beskrivelse, men pris/kvalitet/latency må testes — ingen av disse er billige high-volume modeller sannsynligvis (Veo/Kling er typisk premium-priset per klipp).

### `fal-ai/kling-video/o1/image-to-video` — verifisert fra egen API-spec-side [DOK] (https://fal.ai/models/fal-ai/kling-video/o1/image-to-video/api)

- Parametre: `prompt` (kan referere `@Image1`/`@Image2` for start/slutt), **`start_image_url`** (required), **`end_image_url`** (optional — dette er selve loop-mekanismen: sett lik `start_image_url` for en sømløs loop), `duration` (enum: 3-10 sekunder, default 5).
- Bildekrav: maks 10.0MB, min 300px pr side, aspect ratio 0.40–2.50.
- Output: én MP4-fil (URL, filstørrelse, content-type, filnavn).
- Oppløsning: ikke spesifisert på API-spec-siden [IKKE FUNNET].
- Pris (fra separat søk, sekundærkilde/aggregator-type snippet, IKKE fra samme primærside) [SANNSYNLIG]: **$0.112/sekund** → 5s ≈ $0.56, 10s ≈ $1.12. Denne prisen kan gjelde en annen Kling O1-variant (reference-to-video) og bør reverifiseres direkte mot fal `/pricing` før bruk i kalkyle.

**Konklusjon:** `fal-ai/kling-video/o1/image-to-video` er den klareste, best dokumenterte kandidaten for loop-bruk siden `end_image_url` er et eksplisitt, valgfritt API-parameter direkte på selve i2v-endepunktet (ikke et separat "start-end" spesialendepunkt man må slå opp).

## 4. API-mekanikk (queue submit → poll → result)

Verifisert direkte fra fal sin dokumentasjonsside [DOK] (https://fal.ai/docs/documentation/model-apis/inference/queue):

**Endepunkt-URL-former (queue.fal.run):**

- Submit: `POST https://queue.fal.run/{model-id}` (evt. med ekstra path for sub-endepunkter, f.eks. `/image-to-image`)
- Status: `GET https://queue.fal.run/{model-id}/requests/{request_id}/status`
- Status (streaming): `GET https://queue.fal.run/{model-id}/requests/{request_id}/status/stream` — **SSE støttes** (`text/event-stream`), altså ikke bare polling.
- Resultat: `GET https://queue.fal.run/{model-id}/requests/{request_id}`
- Kansellering: `PUT https://queue.fal.run/{model-id}/requests/{request_id}/cancel`

**Auth-header:** `Authorization: Key $FAL_KEY` — samme format bekreftet både her og i separat auth-søk.

**Webhooks:** query-param `?fal_webhook=https://din-server.com/webhook` på submit-URL (evt. SDK-parameter `webhook_url`). Webhook-payload-format: `{ "request_id": "...", "gateway_request_id": "...", "status": "OK"|"ERROR", "payload": {...} }`.

**Andre nyttige headere:**

- `?logs=1` (eller SDK `with_logs=True`/`logs: true`) — inkluderer logger i status-svar.
- `X-Fal-No-Retry: 1` — deaktiverer automatisk retry.
- `X-Fal-Request-Timeout` — absolutt deadline i sekunder.
- `X-Fal-Queue-Priority: normal|low` — prioritetsstyring.

**Retry/robusthet:** fal sier eksplisitt at "requests are never dropped" og gjør automatisk retry (opptil 10x) ved server-feil, timeout eller connection-feil.

**Rate limits:** ingen eksplisitt tallfestet grense funnet i denne dokumentasjonsutdraget [IKKE FUNNET — søkte "fal.ai rate limit requests per minute", ingen konkrete tall dukket opp i søkeresultatene. Automatisk retry ved 429/rate-limit antyder at grenser finnes og håndteres server-side, men uten dokumenterte tall bør en desktop-klient selv implementere backoff/kø.]

**Bildeopplasting for input:**

- Tre metoder bekreftet: (1) offentlig tilgjengelig URL, (2) base64 data-URI direkte i requesten, (3) fals egen filopplasting via `fal.storage.upload()` (JS-klient) som returnerer en CDN-URL å bruke i requesten. [DOK for (1)+(2) fra flux-1/dev/image-to-image-siden; DOK for (3) fra queue/client-libraries-søk.]
- For et lokalt desktop-verktøy: `fal.storage.upload()`/tilsvarende REST-opplasting er sannsynligvis mest robust for store lokale bilder (unngår data-URI-størrelsesbegrensninger i selve JSON-payloaden), men eksakt REST-endepunkt for opplasting (utenom JS-SDK-metoden) er IKKE verifisert i denne runden [IKKE FUNNET — bør sjekkes mot docs.fal.ai storage-referanse hvis Tauri-appen ikke bruker JS-SDK-en direkte].

## 5. Auth / API-nøkler

- Auth-header-format [SANNSYNLIG — konsistent over flere sekundærkilder + fal docs-lenke funnet men ikke fetch-verifisert direkte pga 429]: `Authorization: Key YOUR_FAL_KEY`. Docs-side: https://docs.fal.ai/reference/platform-apis/authentication (fikk 429 ved fetch, ikke lest direkte — bør reverifiseres).
- Alternativ auth: query-parameter `?key=YOUR_FAL_KEY` nevnt i sekundærkilde [SANNSYNLIG].
- Nøkkelformat (faktisk streng-oppbygning, f.eks. prefiks/lengde): [IKKE FUNNET — søkte men fant ingen eksakt format-spesifikasjon i primærkilde].
- Skoping/restriksjon av nøkler (f.eks. read-only, per-modell, IP-lock): [IKKE FUNNET — ingen dokumentasjon funnet om scoped keys].
- Guidance for client-side/desktop-bruk: fal.ai har historisk anbefalt IKKE å eksponere nøkler i klient-kode og tilbyr en proxy-mekanisme (`@fal-ai/server-proxy` / server-side proxy pattern) for browser-apper — dette er velkjent fra fal sin JS-klient-dokumentasjon [SANNSYNLIG, basert på generell kunnskap om fal sin SDK-arkitektur, IKKE eksplisitt re-verifisert i denne research-runden — bør sjekkes direkte mot https://docs.fal.ai/model-apis/model-endpoints/client-libraries/javascript før implementasjon]. For et **lokalt desktop-verktøy** (Tauri) er risikobildet annerledes enn nettleser: nøkkelen kan lagres i OS-keychain/lokalt og sendes fra Rust-backend (ikke fra webview-JS) — dette unngår at nøkkelen er synlig i DOM/devtools, men er fortsatt et embedded secret på brukerens maskin. Ingen fal-dokumentasjon funnet som spesifikt adresserer desktop-app-scenarioet.
- Rate limits: ikke funnet konkrete tall (req/min, samtidige requests) i denne søkerunden [IKKE FUNNET — søkte "fal.ai rate limits docs"].

## Anbefalt default pr. steg

## Hull og usikkerhet
