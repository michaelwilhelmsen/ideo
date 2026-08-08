# Model-Capability Registry — Research Notes

> Dato: 2026-08-08
> Søkebudsjett: maks 12 søk/fetch

## 1. gpt-image-2

- **Eksisterer, ja.** OpenAI kunngjorde gpt-image-2 med API-tilgjengelighet fra ca. 21. april 2026, model-id `gpt-image-2`. [SANNSYNLIG — sekundærkilde MindStudio/community-tråd, ikke primær OpenAI-blogg lest direkte] Kilde: https://community.openai.com/t/introducing-gpt-image-2-available-today-in-the-api-and-codex/1379479 og https://developers.openai.com/api/docs/models/gpt-image-2
- Modellsiden hos OpenAI Developer docs finnes: https://developers.openai.com/api/docs/models/gpt-image-2 (ikke fetchet i detalj enda — se under).
- **Kritisk funn: gpt-image-2 ER tilgjengelig via fal.ai** — det finnes en dedikert fal-side: https://fal.ai/gpt-image-2 ("GPT Image 2 | State-of-the-Art Image Model live on fal") [DOK — fal.ai landing page finnes, url bekreftet via søk, ikke enda fetchet for full param-liste].
- Til sammenligning finnes en hel familie av OpenAI-bildemodeller på fal: `fal-ai/gpt-image-1`, `fal-ai/gpt-image-1-mini`, `fal-ai/gpt-image-1.5`, og nå gpt-image-2 — se https://fal.ai/explore/openai
- gpt-image-1 (forgjenger) på fal støtter text-to-image (`fal-ai/gpt-image-1/text-to-image`) og edit/image-to-image (`fal-ai/gpt-image-1/edit-image`). Pris-modell: input-tekst-tokens + output pr kvalitetsnivå (low/medium/high) og størrelse (1024x1024 vs andre). Kilde: https://fal.ai/models/fal-ai/gpt-image-1/text-to-image/api
- Direkte fra OpenAI: gpt-image-modellene er autoregressive (ikke diffusion som DALL-E 2/3), støtter image-to-image/editing, tekst-rendering, foto-realisme. [SANNSYNLIG]
- **OpenAI-direkte API-detaljer** [DOK — https://developers.openai.com/api/docs/models/gpt-image-2]:
  - Model-id: `gpt-image-2`
  - Endepunkt: `v1/images/generations` (tekst→bilde) og `v1/images/edits` (bilde-editering/image-to-image, inkl. inpainting)
  - Auth header: ikke spesifisert i den hentede siden — standard OpenAI-mønster er `Authorization: Bearer <OPENAI_API_KEY>`, men dette er **[UNVERIFIED]** for denne spesifikke siden.
  - Bildestørrelser: siden nevner kun "flexible image sizes" — ingen eksakt liste over faste vs. egendefinerte width/height funnet. **[UNVERIFIED]**
  - Negative prompts: ikke nevnt i dokumentasjonen — sannsynligvis IKKE støttet (OpenAI-bildemodeller har historisk ikke hatt negative prompts). **[UNVERIFIED, men konsistent med DALL-E/gpt-image-1 mønster]**
  - Seeds: ikke nevnt — **[UNVERIFIED]**, historisk har OpenAI image-modeller ikke eksponert seed-parameter til brukere.
- fal.ai/gpt-image-2 landingsside finnes og annonserer modellen som "live on fal", men fetch av siden ga HTTP 429 (rate-limited) og kunne ikke bekreftes i detalj i denne runden. **[UNVERIFIED — url funnet via søk, innhold ikke lest]**: https://fal.ai/gpt-image-2

## 2. Top-tier text-to-image modeller for abstrakte/grafiske wide-aspect bakgrunner

Utover FLUX er dette de sterkeste kandidatene funnet (alle via fal.ai unified API, ikke direkte fra hver leverandør, med unntak av gpt-image-2/OpenAI):

| Modell | Leverandør | Via fal.ai? | Maks/fleksibel aspect ratio | Kilde |
|---|---|---|---|---|
| **Nano Banana 2 / Nano Banana Pro** (Google Gemini-basert bildemodell) | Google, via fal | Ja — `fal-ai/nano-banana-pro`, `fal-ai/nano-banana` | Eksplisitt liste: auto, **21:9**, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16 — **21:9 direkte støttet** [DOK] | https://fal.ai/models/fal-ai/nano-banana-pro/api |
| **Ideogram 4 / V4.0q** | Ideogram AI, via fal | Ja — `ideogram/v4` | Native 2K, "range of aspect ratios" (landscape/portrait/square), spesifikk 21:9-støtte ikke bekreftet i detalj | https://fal.ai/ideogram-4 , https://fal.ai/models/ideogram/v4/image-to-image |
| **Recraft V4 / V3** | Recraft, via fal | Ja — `fal-ai/recraft-v4` | Square, landscape (16:9, 4:3), portrait — ingen 21:9 bekreftet | https://fal.ai/recraft-v4 |
| **Seedream 4.5 / 5.0 Pro** (ByteDance) | ByteDance, via fal | Ja — `fal-ai/bytedance/seedream/v4.5` | Opptil 2048×2048, ratios inkl. 1:1, 16:9, 9:16 — 21:9 ikke bekreftet | https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/text-to-image/api |
| **Qwen-Image 2.0** (Alibaba) | Alibaba, via fal | Ja — `fal-ai/qwen-image-2` | Detaljert aspect-ratio-liste ikke bekreftet i denne runden — modellen støtter `negative_prompt` og CFG-scale | https://fal.ai/models/fal-ai/qwen-image/api |
| **gpt-image-2** | OpenAI (direkte) + tilsynelatende også fal | Delvis — landingsside finnes på fal (`fal.ai/gpt-image-2`), men ikke bekreftet i detalj (429-feil ved fetch) | "Flexible image sizes" — ingen eksakt liste bekreftet | Se punkt 1 |
| **FLUX.1/FLUX.2 [pro/max/Kontext]** (referanse, allerede kjent) | Black Forest Labs, via fal | Ja | **21:9 og 9:21 eksplisitt i enum**, default 16:9 [DOK] | https://fal.ai/models/fal-ai/flux-pro/kontext/api |

**Konklusjon for wide-aspect grafiske bakgrunner:** Nano Banana 2/Pro og FLUX Kontext er de to modellene med **bekreftet, eksplisitt 21:9-støtte** blant text-to-image-modellene undersøkt. Ideogram, Recraft, Seedream og Qwen-Image har ikke fått 21:9 bekreftet — de kan støtte det, men det er ikke dokumentert i kildene funnet innenfor søkebudsjettet. **[UNVERIFIED for disse fire — se Hull]**

**Midjourney** er IKKE inkludert i denne registeret som API-kandidat — se punkt 5.

**Imagen 4 (Google, separat fra Nano Banana/Gemini)** ble søkt etter spesifikt men ga ingen tydelige treff for fal.ai-tilgjengelighet i denne runden — usikkert om Imagen 4 er et eget tilgjengelig endepunkt vs. at Nano Banana-familien har overtatt som Googles fal-tilgjengelige bildemodell-linje. **[IKKE FUNNET — søkte "fal.ai Nano Banana Imagen 4 aspect ratio"]**

## 3. Per-modell kapabilitetsdimensjoner (topp 4-5 kandidater)

| Modell | Prompt-stil | Negative prompt | Seed | Image-to-image / strength-param | Aspect ratio / oppløsning |
|---|---|---|---|---|---|
| **FLUX.1/2 Kontext [pro/max]** | Naturlig språk foretrukket, subjekt først (ikke comma-tags) [DOK] | **Nei** — FLUX støtter ikke negative prompts [DOK, https://fal.ai/learn/devs/flux-2-max-prompt-guide] | Ja — samme seed+prompt+versjon gir deterministisk output [DOK] | Ja — parameter heter `strength` (0–1, default 0.1 for Kontext) [DOK] | Enum: 21:9, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16, 9:21 (default 16:9) [DOK] |
| **Nano Banana 2 / Nano Banana Pro** | Naturlig språk / multimodal (tekst+bilde input) | Ikke bekreftet — ikke nevnt i kildene | Ikke bekreftet i denne runden | Ja — editing-variant finnes (`fal-ai/nano-banana-pro/edit`) men parameternavn for strength ikke bekreftet | 11 eksplisitte ratios inkl. 21:9 [DOK] |
| **gpt-image-2 / gpt-image-1** | Naturlig språk (autoregressiv modell, ikke diffusion-comma-tags) [SANNSYNLIG] | Ikke støttet (historisk mønster for OpenAI-bildemodeller; ikke i dokumentasjonen) [UNVERIFIED] | Ikke bekreftet — sannsynligvis ikke eksponert [UNVERIFIED] | Ja — dedikert edit-endepunkt (`v1/images/edits` / `fal-ai/gpt-image-1/edit-image`), men parameternavn for "strength"-likt felt ikke bekreftet | "Flexible sizes" nevnt, ingen eksakt liste bekreftet [UNVERIFIED] |
| **Qwen-Image 2.0** | Ikke bekreftet i detalj — CFG-scale antyder diffusion-stil, sannsynligvis tolererer begge prompt-stiler | **Ja** — har `negative_prompt`-parameter [DOK, https://fal.ai/models/fal-ai/qwen-image/api] | Ja — deterministisk med samme seed+prompt+versjon [DOK] | Ikke bekreftet parameternavn for strength i denne runden | Ikke bekreftet eksakt liste i denne runden |
| **Ideogram 4 / V4.0q** | Naturlig språk, typografi-fokusert | Ikke bekreftet | Ikke bekreftet | Ja — image-to-image-variant finnes (`ideogram/v4/image-to-image`), parameternavn ikke bekreftet | Native 2K, "range of aspect ratios" — ikke eksakt liste bekreftet |
| **Recraft V4/V3** | Naturlig språk + vektor-output-modus | Ikke bekreftet | Ikke bekreftet | Ikke bekreftet | Square, 16:9, 4:3 + portrettvarianter bekreftet — 21:9 ikke bekreftet |

## 4. Image-to-video modeller med first/last-frame eller loop-støtte

| Modell | Leverandør | Via fal.ai? | End-frame parameternavn | Aspect ratio-range | Bredere enn 16:9? | Varighet | Kilde |
|---|---|---|---|---|---|---|---|
| **Kling O1** | Kuaishou, via fal | Ja — `fal-ai/kling-video/o1/image-to-video` | UI-felt "End Image Url" — eksakt API-parameternavn ikke 100 % bekreftet (sannsynligvis `tail_image_url` eller `end_image_url`, samme mønster som andre fal-modeller) [UNVERIFIED navn] | **0.40–2.50** aspect ratio-range (fritt numerisk, ikke enum) [DOK] | **Ja — klart bredere.** 2.50 > 21:9 (2.33), altså støtter til og med bredere enn 21:9 [DOK] | 5 eller 10 sekunder ($0.56 / $1.12) [DOK] | https://fal.ai/models/fal-ai/kling-video/o1/image-to-video |
| **Veo 3.1 (std/fast/lite)** | Google, via fal | Ja — `fal-ai/veo3.1/first-last-frame-to-video`, `.../fast/...`, `.../lite/...` | Ikke bekreftet eksakt parameternavn i denne runden — modellen har dedikert "first-last-frame-to-video"-modus | Ikke bekreftet eksakt liste — "customizable aspect ratios" nevnt generelt [UNVERIFIED detalj] | **Ikke bekreftet** om 21:9 støttes | Ikke bekreftet i denne runden | https://fal.ai/models/fal-ai/veo3.1/first-last-frame-to-video/api |
| **Luma Ray 2 / Ray 2 Flash** | Luma AI, via fal | Ja — `fal-ai/luma-dream-machine/ray-2/image-to-video` | `image_url` (first) + **`end_image_url`** (last) — separate parametre, dual-image interpolation [DOK] | Ikke bekreftet eksakt liste i denne runden | **Ikke bekreftet** | Ikke bekreftet i denne runden | https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/image-to-video |
| **Wan 2.1 FLF2V** | Alibaba/Wan, via fal | Ja — `fal-ai/wan-flf2v` | Ikke bekreftet eksakt navn — beskrives som "bridging first frame to end frame" | Standard 16:9 nevnt som default (jf. Framepack) — **ikke bekreftet om 21:9 mulig** | **Ikke bekreftet**, sannsynligvis begrenset til vanlige ratios | Ikke bekreftet | https://fal.ai/models/fal-ai/wan-flf2v |
| **Framepack (flf2v)** | Open-source / hostet på fal | Ja — `fal-ai/framepack/flf2v` | Ikke bekreftet eksakt navn | Default 16:9 — **ingen 21:9-støtte funnet/nevnt** | **Nei, ikke bekreftet støtte** | Ikke bekreftet | https://fal.ai/models/fal-ai/framepack/flf2v/api |
| **Seedance 2.5** | ByteDance, via fal | Ja — `bytedance/seedance-2.5/image-to-video` | Beskrives som first-frame-driven; ikke tydelig om dedikert end-frame/last-frame-modus finnes for 2.5 (kan være first-frame-only) [UNVERIFIED om flf2v støttes] | Ikke bekreftet | Ikke bekreftet | Opp til 30 sek i ett pass, 4K, 50 multimodale referanser nevnt [SANNSYNLIG] | https://fal.ai/learn/tools/what-is-seedance-2-5 |
| **Vidu Q2 (Pro/Turbo)** | Vidu (ShengShu), via fal | Ja — `fal-ai/vidu/q2/image-to-video/pro`, `.../turbo` | Ikke bekreftet — har "Reference-to-Video" med opptil 7 referansebilder, men uklart om det er samme som first/last-frame | 16:9, 9:16, 1:1, 4:3, 3:4 bekreftet — **21:9 ikke nevnt/ikke bekreftet** | **Nei, ikke bekreftet** | 2–8 sekunder, $0.10–$0.80 [DOK/SANNSYNLIG] | https://fal.ai/models/fal-ai/vidu/q2/image-to-video/pro |
| **Runway (Gen-4.5 m.fl.)** | Runway, status uklar | **Ikke bekreftet via fal** i denne runden — funnet kun via tredjepartssammenligning (Pollo AI) som viser Runway Gen-4.5 med høy Elo-score, ikke en fal-modell-side direkte | Ikke bekreftet | Ikke bekreftet | Ikke bekreftet | Ikke bekreftet | https://pollo.ai/m/runway-ai/image-to-video (sekundærkilde) |

**Konklusjon for kravet "bredere enn 16:9 (f.eks. 21:9)":** Kun **Kling O1** har en **bekreftet, dokumentert** aspect-ratio-range (0.40–2.50) som klart dekker og går forbi 21:9 [DOK]. Ingen av de andre video-modellene (Veo 3.1, Luma Ray 2, Wan FLF2V, Framepack, Seedance 2.5, Vidu Q2) fikk 21:9-støtte bekreftet innenfor søkebudsjettet — flere av dem (Framepack, Vidu Q2) har tvert imot indikasjoner på at de er begrenset til standard-ratios (16:9/9:16/1:1/4:3/3:4) uten ultrawide-opsjon.

## 5. Midjourney-lignende (ikke-API) — ekskludert

- **Midjourney**: Har fortsatt **ingen bredt tilgjengelig offentlig API** per august 2026 [SANNSYNLIG, konsistent over flere sekundærkilder: apiframe.ai, cometapi.com, 10b.ai]. Det finnes et "Midjourney Official API" som ble lansert sent i 2025, men API-nøkler er begrenset til Enterprise-dashboard og krever egen søknad om utvikleradgang — ikke selvbetjent oppstart som fal/OpenAI. Alle "Midjourney API"-tilbud man finner via generelt søk (apiframe, useapi.net, Apify) er **uoffisielle wrapper-tjenester** som automatiserer Discord-grensesnittet og som bryter Midjourneys brukervilkår.
- **Konklusjon: Midjourney ekskluderes fra model-capability-registeret.** Det passer ikke inn i et rent programmatisk kall-mønster (Discord-bot-workflow eller søknadsbasert Enterprise-API), og uoffisielle wrappere er en compliance-risiko som ikke bør bygges inn i et registrert kapabilitets-register for en desktop-app.
- Ingen andre modeller i denne undersøkelsen ble identifisert som rene ikke-API/GUI-only-verktøy blant kandidatene i punkt 2 og 4 — alle andre (FLUX, Nano Banana, Ideogram, Recraft, Seedream, Qwen-Image, gpt-image-2, Kling, Veo, Luma, Wan, Seedance, Vidu, Runway) har et dokumentert eller sekundærbekreftet API-spor, primært via fal.ai.

## Hull og usikkerhet

Søkebudsjett (12 søk/fetch) ble brukt fullt ut — én fetch mislyktes (HTTP 429 på fal.ai/gpt-image-2), noe som la et hull i verifikasjonen av fal-tilgangen til gpt-image-2. Følgende er ikke bekreftet og bør verifiseres direkte mot API-docs før implementasjon:

1. **gpt-image-2 via fal.ai** — landingssiden `fal.ai/gpt-image-2` finnes (bekreftet via søk), men innholdet (eksakt fal-modell-id, parametre) kunne ikke fetches (429-feil). Neste steg: retry fetch, eller sjekk `fal.ai/models/fal-ai/gpt-image-2` direkte.
2. **Auth-header-format for OpenAI-direkte gpt-image-2** — antatt `Authorization: Bearer <key>` basert på standard OpenAI-mønster, men ikke bekreftet på den spesifikke modellsiden.
3. **Custom width/height vs. faste størrelser for gpt-image-2** — dokumentasjonen sa bare "flexible image sizes" uten liste.
4. **Negative prompt og seed-støtte for gpt-image-1/2** — ikke nevnt i kildene; antatt IKKE støttet basert på historisk OpenAI-mønster (DALL-E-familien hadde ikke disse), men ikke eksplisitt bekreftet for gpt-image-2.
5. **Eksakt aspect-ratio-liste** for Ideogram 4, Recraft V4, Seedream 4.5/5.0, og Qwen-Image 2.0 — ingen av disse fikk 21:9 bekreftet eller avkreftet eksplisitt. Søkte: "fal.ai text-to-image models Seedream Recraft Ideogram Qwen-Image aspect ratio" og "fal.ai Ideogram Recraft Seedream Qwen-Image API negative_prompt seed strength image-to-image parameter".
6. **Imagen 4 (Google, separat linje fra Nano Banana/Gemini)** — ikke funnet som eget fal-tilgjengelig endepunkt i denne runden. Uklart om Imagen 4 fortsatt eksisterer som separat produkt eller er blitt "absorbert" av Nano Banana-linjen på fal. Søkte: "fal.ai Nano Banana Imagen 4 aspect ratio wide graphic background text-to-image".
7. **Veo 3.1 sin eksakte aspect-ratio-range og end-frame-parameternavn** — kun "customizable aspect ratios" nevnt generelt, ingen tallverdier eller enum bekreftet.
8. **Runway sin fal.ai-tilgjengelighet** — fant ingen direkte fal.ai-modellside for Runway Gen-4/4.5 i denne runden (kun tredjepartssammenligning via Pollo AI). Uklart om Runway er tilgjengelig via fal, direkte API, eller kun web-app. Bør verifiseres separat mot runwayml.com/api eller fal.ai/explore/runway.
9. **Seedance 2.5 flf2v-støtte** — beskrivelsen antyder first-frame-driven generering; uklart om den har en dedikert last-frame/end-frame-modus tilsvarende Kling O1/Luma Ray 2.
10. **Wan FLF2V og Framepack sine eksakte parameternavn** for end-frame — beskrevet konseptuelt ("bridging first frame to end frame") men ikke bekreftet API-feltnavn.
11. Ingen av kildene ble sjekket for "last updated"-dato — fal.ai-modellsider oppdateres ofte og har typisk ikke synlig dato, så staleness-flagg er ikke relevant her, men merk at feltet er i rask endring (nye modellversjoner nevnt: Seedream 5.0, Qwen-Image 2.0, Nano Banana 2/Pro, FLUX.2 — alle tyder på et marked som har beveget seg fort siden forrige kjente snapshot).

## Konklusjon / anbefaling

**Kortliste per bruksområde:**

| Bruksområde | Anbefalt modell | Leverandør/tilgang | Nøkkelbegrunnelse |
|---|---|---|---|
| Abstrakt/grafisk wide-aspect bakgrunn (text-to-image) | **FLUX.1/2 Kontext [pro/max]** | fal.ai (`fal-ai/flux-pro/kontext`) | Eneste modell med **eksplisitt bekreftet 21:9/9:21-enum**, seed-determinisme og `strength`-parameter for image-to-image — mest produksjonsklar dokumentasjon |
| Alternativ/sekundær text-to-image for wide-aspect | **Nano Banana 2 / Pro** (Google) | fal.ai (`fal-ai/nano-banana-pro`) | Eksplisitt 21:9 i 11-ratios-enum, multimodal (tekst+bilde input), god for typografi/infografikk |
| Der gpt-image-2 spesifikt kreves (f.eks. sterk instruksjonsfølging/foto-realisme) | **gpt-image-2** | OpenAI direkte (`v1/images/generations` / `v1/images/edits`) — fal-tilgang uverifisert | Krever egen verifisering av auth/size-parametre før bruk; ikke velg denne som primær hvis 21:9 er hardt krav, siden det ikke er bekreftet |
| Image-to-video med first+last-frame OG bredere-enn-16:9-krav | **Kling O1** | fal.ai (`fal-ai/kling-video/o1/image-to-video`) | Eneste video-modell med **bekreftet** aspect-ratio-range (0.40–2.50) som dekker 21:9 og bredere — dette er den klart sikreste kortlisteanbefalingen for det harde 21:9-kravet |
| Image-to-video first+last-frame, standard ratios OK | **Luma Ray 2** eller **Veo 3.1** | fal.ai | Begge har dedikert end-frame-parameter (`end_image_url` for Ray 2, dedikert first-last-frame-endepunkt for Veo 3.1), men ingen bekreftet ultrawide-støtte — bruk kun hvis 16:9/9:16 er tilstrekkelig |
| **Ekskludert** | Midjourney | Ingen selvbetjent API | Enterprise-only søknadsbasert API eller uoffisielle ToS-brytende wrappere — passer ikke et programmatisk registrert kapabilitets-register |

**Anbefaling til registeret:** Bygg registeret med FLUX Kontext og Kling O1 som de to "hardt verifiserte" ankermodellene for wide-aspect-kravet (begge har dokumentert 21:9+-støtte), og legg inn Nano Banana 2/Pro som sekundær text-to-image-kandidat. Merk gpt-image-2, Ideogram, Recraft, Seedream, Qwen-Image, Veo 3.1, Luma Ray 2, Wan FLF2V, Framepack, Seedance 2.5, Vidu Q2 og Runway som "UNVERIFIED for 21:9" i registeret til de er testet direkte mot API — ikke anta ultrawide-støtte uten bekreftelse, siden konsekvensen (feil format levert til bruker) er kostbar.
