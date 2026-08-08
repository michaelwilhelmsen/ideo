# Prompt Engineering Structure — Style-Preset Library (Follow-up)

Dato: 2026-08-08. Bygger på tidligere bekreftet: FLUX støtter ikke negative prompts (flow-matching, fast CFG ~1); SDXL-familien støtter det; Midjourney --sref/--stylize overføres ikke til API-modeller. Disse fakta gjentas IKKE her.

## 1. Prompt-komposisjonsrekkefølge (FLUX)

**Konklusjon: subjekt først (prosa), stil vevd inn i prosa nær starten eller som en kort avsluttende prosa-sats — IKKE som anheng av kommaliste.**

- FLUX (både FLUX.1 og FLUX.2) bruker en tekstencoder trent på prosa (FLUX.2: Mistral-Small VLM). Kommaseparerte tag-lister tolkes som dårlig strukturert engelsk, ikke som distinkte konsepter à la SDXL/CLIP. [SANNSYNLIG] — konsistent på tvers av BFL-nært innhold: fal.ai learn-side «Flux 2 prompt guide» og community-guider (Ambience AI, deAPI) [DOK: https://fal.ai/learn/devs/flux-2-prompt-guide] [SANNSYNLIG for øvrige].
- Anbefalt promptlengde: 30–80 ord «sweet spot». [SANNSYNLIG — funnet i søkeresultat-sammendrag fra fal.ai/BFL-avledet innhold, kunne ikke verifisere direkte på docs.bfl.ml, se hull].
- Modellen legger mer vekt på det som står **først** i prompten; konkrete substantiv (subjektet) får høyest oppmerksomhet, spesielt tidlig i prompten. Stildeskriptorer bør plasseres **etter** subjekt/scene-informasjon, vevd inn som naturlig språk (lys, stemning, teksturord), ikke tilføyd som egen kommaliste på slutten. [SANNSYNLIG — konsistent fra flere sekundærkilder om FLUX.2 promptstruktur, ingen primær docs.bfl.ml-side kunne åpnes, se hull].
- Praktisk implikasjon for preset-biblioteket: **å hekte en kommaseparert stil-fragment bak en prosa-subjektsetning svekker sannsynligvis FLUX-resultatet** fordi det bryter den prosaflyten encoderen er trent på — dette er den mest sannsynlige tolkningen av kildene, men ikke A/B-testet i noen kilde jeg fant. [SANNSYNLIG, ikke [DOK]].

**Anbefalt mal (FLUX):**

```
{subject_prose}, {style_clause_woven_as_prose}
```

Konkret eksempel (film grain-stil, se §2 for full preset):

```
A woman in her 30s standing at a rain-soaked Tokyo crosswalk, captured on grainy 35mm film with visible halation and soft, slightly desaturated color, warm tungsten street light mixing with cool blue dusk sky.
```

Dvs. subjektsetningen kommer først (høyest attention), og stilen fortsetter som naturlig fortsettelse av samme setning/prosa-blokk — ikke `subject, tag1, tag2, tag3`.

**Hull:** Fant ikke en direkte, åpnbar primærkilde på docs.bfl.ml med et eksplisitt "style leder/følger"-avsnitt; guiden `https://docs.bfl.ml/guides/prompting_guide_t2i_fundamentals` returnerte 404 ved fetch 2026-08-08 (kan ha flyttet URL eller kreve annen sti). Konklusjonen over bygger på konsistente sekundærkilder (fal.ai learn, Ambience AI, deAPI.ai) som alle refererer til BFL sin offisielle guide, men jeg har ikke selv lest primærteksten.

## 2. Preset-skjema (tverr-modell)

Prinsipp: hold felles metadata på toppnivå, og legg modellspesifikke felt i en `variants`-map keyet på modell-familie (`flux`, `sdxl`), slik at nye modeller kan legges til uten å bryte skjemaet. FLUX-varianten har ALDRI `negative_prompt` eller `guidance` som fri parameter (fast CFG ~1, bekreftet i forrige runde); SDXL-varianten har begge pluss vektings-syntaks (`(word:1.3)` etc.).

**Skjemaforslag (JSON):**

```json
{
  "id": "film-grain",
  "label": "Film Grain",
  "description": "Analog 35mm film look with visible grain and halation",
  "category": "photographic",
  "variants": {
    "flux": {
      "style_clause": "captured on grainy 35mm film with visible halation and soft, slightly desaturated color",
      "composition_note": "weave after subject clause, prose only, no comma-tag suffix",
      "guidance": null,
      "negative_prompt": null
    },
    "sdxl": {
      "style_tags": "35mm film grain, film halation, kodak portra 400, subtle color shift, analog photography",
      "negative_prompt": "digital noise, oversharpened, plastic skin, hdr, oversaturated",
      "guidance_scale": 6.5,
      "weighting_example": "(film grain:1.2), (halation:1.1)"
    }
  },
  "compose": {
    "flux_template": "{subject_prose}, {variants.flux.style_clause}",
    "sdxl_template": "{subject_prose}, {variants.sdxl.style_tags}"
  }
}
```

Nøkkelpunkter i skjemaet:

- `variants` er en **map**, ikke en fast liste — nye modellfamilier (f.eks. Midjourney, Ideogram) legges til som nye keys uten migrasjon.
- Felt som ikke gjelder for en modell (`negative_prompt`, `guidance` for FLUX) settes explicit til `null` heller enn å utelates, slik at applikasjonslaget kan skille "ikke støttet av modell" fra "mangler data".
- `compose.*_template` holder komposisjonsregelen (jf. §1) per modellfamilie i selve preset-filen, slik at ordrelogikken ikke gjemmes i applikasjonskode og kan endres per stil om nødvendig (noen stiler kan trenge stilen først, f.eks. en sterk kunstretning som skal dominere).
- `style_tags` (SDXL) vs `style_clause` (FLUX) er bevisst forskjellige feltnavn — ikke samme streng gjenbrukt — fordi SDXL-varianten er en komma-tag-liste og FLUX-varianten er en prosa-frase; å tvinge dem til ett felt ville reprodusert nøyaktig den feilen §1 advarer mot.

Dette skjemaet er egen konstruksjon basert på de bekreftede modellbegrensningene og funnene i §1 — det er ikke hentet fra en offentlig "preset schema"-standard (fant ingen slik). [Egen syntese, ikke [DOK]].

## 3. Text-to-image vs image-to-image restyling

- **fal.ai sin offisielle default for `fal-ai/flux/dev/image-to-image` er `strength: 0.95`**, med dokumentert forklaring: "The strength of the initial image. Higher strength values are better for this model." [DOK: https://fal.ai/models/fal-ai/flux/dev/image-to-image/api, hentet 2026-08-08]. Merk: fal sin doc gir INGEN nyansert veiledning om komposisjon-vs-stil-avveiningen for dette spesifikke endepunktet — dette er kun default-verdien og en generisk one-liner, ikke en begrunnet range-anbefaling. [DOK for tallet, men doc-teksten selv er tynn].
- Bredere (SD/generisk img2img-økosystem, ikke FLUX-spesifikt) empirisk konsensus fra flere sekundærkilder (RunDiffusion, 10b.ai, Gera Tools) er en denoise/strength-skala: **~0.2–0.35** = små justeringer/rens, bevarer identitet og layout tett; **~0.4–0.6** = "samme motiv, nytt utseende" (stilendring med bevart kjernestruktur); **~0.7+** = "behold generelt layout men helt annen scene". [SANNSYNLIG — konsistent på tvers av 3 sekundærkilder, ingen primær SD/BFL-kilde funnet med tallfestet range].
- Dette står i kontrast til fal sin FLUX.1[dev] default på 0.95, som ifølge fal sin egen beskrivelse ("higher = better for this model") er ment å gi modellen mer frihet — dvs. FLUX img2img-implementasjonen ser ut til å være kalibrert annerledes enn klassisk SD-denoise-skala, og en bruker som vil bevare komposisjon på FLUX bør sannsynligvis teste **lavere** enn defaulten (f.eks. 0.5–0.7-området fra SD-heuristikken) heller enn å anta fal-defaulten er "trygg" for komposisjonsbevaring. [Egen tolkning/syntese — ikke bekreftet empirisk i noen kilde, flagget som usikkerhet].
- **Prompt: subjekt eller bare stil?** Sekundærkilder om restyling/style-reference-workflows (letsenhance, image2prompts, nightjar) er enstemmig i retning: når komposisjonen allerede kommer fra input-bildet, bør prompten fokusere på **stilbeskrivelse** (lys, palett, tekstur, kornstruktur) og IKKE re-beskrive hele subjektet i detalj — modellen "ser" subjektet fra bildet, og en tung subjekt-omskrivning i prompten kan konkurrere med/overstyre input-bildets komposisjon. Praksisen er: kort/ingen subjektsetning, tung stil-setning. [SANNSYNLIG — konsistent på 3 sekundærkilder, ingen primær FLUX/fal-dokumentasjon fant jeg som eksplisitt sier dette for img2img-endepunktet].
- **Anbefaling for preset-biblioteket:** for img2img/restyle-bruk, bruk `variants.flux.style_clause` alene (uten subject_prose) som prompt, og eksponer `strength` som brukerjustérbar parameter med UI-default satt lavere enn fal sin API-default (0.95) hvis komposisjonsbevaring er målet — foreslå å teste 0.5–0.65 som utgangspunkt. Dette er en anbefaling avledet fra syntesen ovenfor, ikke en bekreftet fasit. [Egen syntese].

**Hull:** Ingen primær FLUX/fal-kilde ga en tallfestet strength-range spesifikt for komposisjonsbevaring på flux-1/dev/image-to-image; SD-range-tallene ovenfor er fra generisk SD-økosystem og kan ikke uten videre overføres 1:1 til FLUX sin strength-parameter siden skalaene kan være kalibrert forskjellig (jf. punktet over om 0.95-default).

## 4. Video-motion prompts (subtil ambient bevegelse)

Prinsipp fra flere sekundærkilder (image-to-video prompt-guider, invideo.io, techpresso/Luma, picsart/Seedance): navngi settingen, én kontinuerlig bevegelse, og fargestemning; lås kamera eksplisitt; be om "seamless loop"; unngå alt med tydelig start/slutt. [SANNSYNLIG — konsistent på tvers av kilder, ingen primær modell-dokumentasjon (Runway/Kling/Luma) ble konsultert direkte pga. søkebudsjett].

**8 gjenbrukbare motion-fragmenter for loopende hero-bakgrunn:**

1. `static locked camera, only [water/clouds/steam/hair] drifts in a slow continuous loop, everything else perfectly still`
2. `gentle ambient motion, subtle undulation, no camera movement, calm and hypnotic`
3. `slow drifting clouds across an even sky, soft daylight, seamless loop, no visible cut`
4. `rippling water surface with a slow, even rhythm, reflections sliding gently, locked wide shot`
5. `soft continuous sway, low-amplitude motion, steady pace suitable for a seamless loop`
6. `subtle parallax drift only, foreground and background move at slightly different speeds, no dolly, no pan`
7. `barely perceptible breathing motion, minimal displacement, photorealistic, loop-ready`
8. `slow rising embers/steam/mist, even continuous motion, background otherwise static`

Praktisk regel: eksplisitt utelukke dramatiske kamerabevegelser ved å inkludere negasjoner der modellen støtter det (f.eks. `no pan, no zoom, no dolly, no camera shake`) — nyttig for modeller som tolererer negativ-lignende instruksjoner i selve prompten (de fleste video-modeller har ikke en separat negative_prompt-parameter, så negasjon må inn i hovedprompten som tekst).

**Hull:** Fant ingen primær dokumentasjon fra en spesifikk image-to-video-modell (Runway Gen-4, Kling, Luma Ray, Seedance) om subtil-vs-dramatisk motion-styrke-parametre; alle 8 fragmentene ovenfor er syntetisert fra sekundære prompt-guide-artikler, ikke testet av meg og ikke fra modellutviklernes egne docs.

## Hull og usikkerhet (samlet)

- Primær BFL-kilde `docs.bfl.ml/guides/prompting_guide_t2i_fundamentals` ga 404 ved fetch 2026-08-08 — kunne ikke lese guiden direkte, kun via sekundærkilder som siterer den. Anbefaler at neste researcher-runde finner korrekt URL (kan ha endret sti under FLUX.2-lansering) hvis §1 skal oppgraderes fra [SANNSYNLIG] til [DOK].
- Ingen tallfestet, FLUX-spesifikk strength/denoise-range for komposisjonsbevaring i img2img — kun fal sin default (0.95, [DOK]) og generisk SD-heuristikk (0.2–0.7+, [SANNSYNLIG], ikke FLUX-validert).
- Ingen primær modell-dokumentasjon for video-motion-prompts (Runway/Kling/Luma/Seedance) — hele §4 er sekundærkilde-syntese.
- "30–80 ord sweet spot" for FLUX-promptlengde er fra sekundærkilde, ikke selv lest på docs.bfl.ml.
- Preset-JSON-skjemaet i §2 er egen konstruksjon (syntese), ikke en eksisterende bransjestandard — flagget tydelig i teksten.

## Anbefaling

1. **Komposisjon:** bruk mal `{subject_prose}, {style_woven_as_prose}` for FLUX — aldri en kommaliste hektet bak. Behold `{subject_tags}, {style_tags}` kommaliste-stil for SDXL som før.
2. **Skjema:** bruk `variants`-map (per modellfamilie) med explicit `null` for ikke-støttede felt, pluss et `compose.*_template` per variant lagret i selve preset-filen (§2).
3. **Img2img/restyle:** eksponer `strength` som brukerparameter, sett UI-default lavere enn fal sin API-default (0.95) — foreslå 0.5–0.65 som utgangspunkt for komposisjonsbevaring, og bruk stil-only prompt (uten subject_prose) for restyle-modus.
4. **Video:** legg de 8 motion-fragmentene i §4 inn som et eget `motion_fragments`-bibliotek adskilt fra stil-presets, siden de er modellklasse-uavhengige (image-to-video) snarere enn modellspesifikke.

Alt over som ikke er merket [DOK] bør behandles som arbeidshypotese til validert empirisk i produktet.
