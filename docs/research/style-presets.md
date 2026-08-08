# Style-preset prompt recipes for abstract/graphic hero backgrounds

> STATUS: under arbeid

## Sammendrag
- (fylles ut til slutt)

## Metode og budsjett
- Max 12 web-søk. Dato for research: 2026-08-08.
- Fokus: konkrete prompt-fragmenter som er verifisert eller sannsynliggjort av community-guider, ikke generiske beskrivelser.

## Presets

Format per preset: **Navn** — Prompt-fragment (verbatim/rekonstruert fra kilder) — Negativ prompt — Parameter-notater — Modell-transfer.

### 1. Film grain / heavy noise / analog degradation

**Preset A — "35mm Analog Grain"**
- Prompt-fragment: `shot on 35mm film, visible film grain, ISO 3200, analog color desaturation, organic imperfections, subtle halation, documentary grit`
- Negativ prompt (SDXL/SD-familien): `smooth skin, clean digital, oversharpened, plastic texture, cgi look`
- Parameter-notater: På SDXL-familien løft CFG/guidance moderat (7–9) for å unngå at grain "vaskes bort"; på Flux, grain-ordene bæres helt av teksten siden CFG er låst (~1) — ingen negativ prompt-effekt. Steps 25–40 for SDXL; Flux Schnell trenger få steps (~4), Flux Dev/Pro 20–30.
- Transfer: **[SANNSYNLIG]** Fungerer bra på alle tre; Midjourney tolker "35mm film, grain, ISO 3200" direkte som fototeknisk språk uten behov for `--style raw`. Kilde: [Flux AI Prompt Guide 2026](https://www.imagetoprompt.dev/blog/flux-ai-prompt-guide/), [BFL FLUX.2 Prompting Guide](https://docs.bfl.ml/guides/prompting_guide_flux2).

**Preset B — "80s Vintage Grain"**
- Prompt-fragment: `80s vintage photo style, warm tones, visible grain, faded film quality, soft contrast`
- Negativ prompt: `modern digital sharpness, neon oversaturation, HDR`
- Parameter-notater: samme som ovenfor; vintage-fading kan forsterkes med lavere guidance på SDXL.
- Transfer: [SANNSYNLIG] samme kilde som A.

### 2. Duotone / tritone

**Preset C — "Duotone Neon Split"**
- Prompt-fragment: `duotone color grade, two-tone palette electric blue and hot pink, high contrast light and shadow, symmetrical composition, flat bold color blocking`
- Negativ prompt: `full color photograph, muted palette, natural skin tones`
- Parameter-notater: duotone er fundamentalt en post-fargebehandling; modeller respekterer det bedre når paletten er navngitt eksplisitt med to konkrete farger heller enn ordet "duotone" alene. Aspect ratio fleksibel; høyere guidance (SDXL 8–10) styrker fargeblokk-separasjon.
- Transfer: [SANNSYNLIG] Kilde: [Duotone colors Midjourney style — Midlibrary](https://midlibrary.io/styles/duotone-colors). **[IKKE FUNNET]** direkte Flux-spesifikk case-study på duotone; ordet fungerer trolig identisk siden det er ren fargebeskrivelse.

**Preset D — "Tritone Print"**
- Prompt-fragment: `tritone color separation, three-color print palette (name 3 colors), flat shading, poster print aesthetic`
- Negativ prompt: `full color gradient, photorealistic color range`
- Parameter-notater: samme logikk som duotone — spesifiser faktiske fargenavn, ikke bare fagtermen.
- Transfer: [SANNSYNLIG], ikke direkte bekreftet med kilde for "tritone" spesifikt — ekstrapolert fra duotone-funn.

### 3. Risograph / screenprint / halftone / dithered

**Preset E — "Riso Print Zine"**
- Prompt-fragment: `Risograph print style, halftone dots, visible paper grain, misaligned ink layers, limited two-color ink palette (name colors), screen printing texture, slight ink bleed`
- Negativ prompt: `full color photography, smooth gradient, digital vector clean lines`
- Parameter-notater: nøkkelfrasene som faktisk styrer effekten er *palett-begrensning* (2–3 farger), *misregistrering/misalignment* og *papirgrain* — disse tre må alle med, ellers faller resultatet tilbake mot generisk "pop art". Steps/guidance som normal illustrasjon (SDXL guidance 7–8).
- Transfer: **[DOK-nivå snippet, ikke primærkilde]** Kilde: [Gemini AI Risograph Style Prompt](https://www.media.io/ai-prompts/gemini-ai-risograph-style-prompt.html), [Risograph Midjourney style — Midlibrary](https://midlibrary.io/styles/risograph). Fungerer på tvers av Midjourney/Flux/SD ifølge disse sekundærkildene — men ingen av kildene er modell-utviklerens egen dokumentasjon, så merket [SANNSYNLIG] snarere enn [DOK].

**Preset F — "Halftone Comic Dither"**
- Prompt-fragment: `halftone dot pattern, high-contrast dithered shading, Ben-Day dots, monochrome ink print`
- Negativ prompt: `smooth gradient, photorealistic shading, anti-aliased soft edges`
- Parameter-notater: halftone er skala-avhengig — for hero-bakgrunner i høy oppløsning bør prompten spesifisere dot-størrelse ("large halftone dots" vs "fine halftone dots") for å style konsistent på tvers av output-størrelser.
- Transfer: [SANNSYNLIG], samme kildegrunnlag som E.

### 4. Chromatic aberration / prism / lens artifacts

**Preset G — "Chromatic Fringe Edge"**
- Prompt-fragment: `subtle chromatic aberration on high-contrast edges, prism light refraction, faint RGB color fringing, lens artifact, soft glass distortion`
- Negativ prompt: `clean sharp edges, corrected optics, no color fringing` (bruk denne negative promten når du *ikke* vil ha aberrasjon — ellers utelat)
- Parameter-notater: **[DOK-nær]** kilde bekrefter at chromatic aberration/lens flare/vignette ofte står i negative prompts når man vil unngå det for fotorealisme — dvs. presetens negative-prompt-felt må inverteres avhengig av intensjon. Kilde: [Best Chromatic Aberration Stable Diffusion Prompts — PromptHero](https://prompthero.com/search?model=Stable+Diffusion&q=Chromatic+Aberration), [therightgpt SD negative prompts guide](https://therightgpt.com/stable-diffusion-guides/negative-prompts/).
- Transfer: [SANNSYNLIG] på alle tre; Flux har intet negativ-prompt-felt, så "unngå aberrasjon" må formuleres positivt ("perfectly corrected optics, zero color fringing") i selve prompten.

**Preset H — "Prism Light Leak"**
- Prompt-fragment: `prism light leak, rainbow light refraction streaks, lens flare bloom, glass diffraction pattern`
- Negativ prompt: (ingen — additiv effekt)
- Parameter-notater: light-leak-effekter kan overeksponere; på SDXL senk guidance litt (6–7) hvis output blir utbrent/hvit.
- Transfer: [SANNSYNLIG], samme kildegrunnlag.

### 5. Iridescent / holographic / oil-slick

**Preset I — "Holographic Oil Slick"**
- Prompt-fragment: `iridescent oil slick texture, holographic sheen, shifting rainbow reflections, liquid metal surface, high gloss, moiré-like color bands`
- Negativ prompt: `matte finish, flat single color, dull surface`
- Parameter-notater: iridescens er lys-vinkel-avhengig i virkeligheten — modeller tolker det best med eksplisitt "shifting/shimmering rainbow reflections" + en overflatetype (olje, metall, vinyl). Uten overflatetype blir resultatet ofte bare en generisk regnbue-gradient.
- Transfer: [SANNSYNLIG] Kilde: [Chrome Holographic Effects — PromptBase](https://promptbase.com/prompt/chrome-holographic-effects), [Holographic glitch art / oil slick — Vice Creators](https://creators.vice.com/en_us/article/gvwygj/holographic-glitch-art-looks-like-an-iridescent-oil-slick).

**Preset J — "Chrome Liquid Metal"**
- Prompt-fragment: `polished chrome liquid metal, mirror reflections, molten metallic surface, smooth flowing metal form, studio lighting reflection highlights`
- Negativ prompt: `matte texture, rusted, rough surface, plastic`
- Parameter-notater: chrome/liquid metal profiterer på "studio lighting" og "reflection highlights" som eksplisitte fraser — uten disse blir metallic ofte flatt/grått i stedet for reflekterende.
- Transfer: [SANNSYNLIG], samme kildegrunnlag som I.

### 6. Soft volumetric gradient / mesh gradient / aurora

**Preset K — "Stripe-style Mesh Gradient"**
- Prompt-fragment: `soft mesh gradient background, multiple diffused color blobs blending smoothly, pastel-to-vivid color transition, atmospheric depth, no hard edges, premium SaaS aesthetic`
- Negativ prompt: `hard edges, sharp geometric shapes, high detail texture, noise`
- Parameter-notater: mesh-gradient-estetikken referert i design-community er navngitt direkte etter Stripe (lyse multi-stop) og Vercel (mørkere, aurora-lignende) — å nevne referansepunktet ("Stripe-style" / "Vercel-style dark aurora wash") gir mer forutsigbar output enn "mesh gradient" alene. Lav detalj-vekt; guidance moderat (SDXL 6–8) for å holde det jevnt/diffust; wide aspect ratio (16:9 / 21:9) typisk for hero-bakgrunner.
- Transfer: [SANNSYNLIG] Kilde: [Gradient Mesh / Aurora Evolved — designmd.app](https://designmd.app/library/gradient-mesh-aurora-evolved/), [Mesh Gradient Generator Guide — gradientshub.com](https://gradientshub.com/blog/how-to-use-mesh-gradient-generator-design-tool/).

**Preset L — "Aurora Borealis Wash"**
- Prompt-fragment: `dark background with aurora borealis light wash, flowing volumetric color bands, deep navy and emerald glow, soft diffusion, celestial atmosphere`
- Negativ prompt: `stars, landscape, literal sky photo, horizon line` (for å holde det abstrakt og ikke bli en literal nattehimmel-foto)
- Parameter-notater: samme som K.
- Transfer: [SANNSYNLIG], samme kildegrunnlag.

### 7. Glass / refraction / caustics

**Preset M — "Glass Caustics Light"**
- Prompt-fragment: `transparent glass surface, caustic light patterns, refracted light rays, soft highlights, dappled light through glass, clean minimal background`
- Negativ prompt: `opaque surface, flat lighting, no reflections`
- Parameter-notater: caustics kombineres godt med et sekundært lys-ord ("dappled sunlight", "underwater light") for å unngå at modellen tolker "caustics" som ren tekstur uten lyskilde-logikk.
- Transfer: [SANNSYNLIG] Kilde: [aiarty Stable Diffusion lighting prompts](https://www.aiarty.com/stable-diffusion-prompts/stable-diffusion-lighting-prompts.htm), eksempel-prompt fra PromptHero ("caustics, shade, dappled sunlight").

**Preset N — "Chromatic Glass Refraction"**
- Prompt-fragment: `color spectrum refraction through glass, prismatic light bending, frosted glass texture, cinematic lighting, abstract composition`
- Negativ prompt: `flat color, no light interaction`
- Parameter-notater: overlapper delvis med Preset G (chromatic aberration) — hold dem separate i biblioteket siden refraction-through-glass gir en mer "fysisk" fargespredning enn linse-aberrasjon på selve bildekanten.
- Transfer: [SANNSYNLIG], samme kildegrunnlag.

### 8. Topografisk / konturlinjer / data-viz-felt

**Preset O — "Topographic Contour Field"**
- Prompt-fragment: `minimal black and white abstract topographic contour lines, concentric irregular shapes, fine line art, high contrast, elevation map aesthetic, monochrome`
- Negativ prompt: `photorealistic terrain, color, texture noise, 3D shading`
- Parameter-notater: "contour plot"-stilen i Midjourney-community beskrives som monokrom med fine linjer og lagdelte, bølgende former — spesifiser eksplisitt "monochrome" + "fine lines" for å unngå at modellen legger på farge eller skygge. Fungerer godt på hvit/lys bakgrunn for hero-seksjoner med mye whitespace.
- Transfer: [SANNSYNLIG] Kilde: [Contour plot Midjourney style — Midlibrary](https://midlibrary.io/styles/contour-plot).

**Preset P — "Data-viz Grid Field"**
- Prompt-fragment: `abstract data visualization field, fine grid lines, scientific diagram aesthetic, schematic line patterns, subtle measurement marks, minimal color`
- Negativ prompt: `readable text, real chart labels, photorealistic`
- Parameter-notater: uten "abstract" og "no readable text" i negativ prompt har modeller (spesielt SDXL) en tendens til å prøve å generere faktisk lesbar (men meningsløs) tekst/tall — dette er et kjent problemområde i diffusion-modeller generelt.
- Transfer: [SANNSYNLIG], ekstrapolert fra samme kildegrunnlag + generell kunnskap om tekst-i-bilde-svakhet.

### 9. Long-exposure light trails / motion blur

**Preset Q — "Long Exposure Light Trails"**
- Prompt-fragment: `long exposure photography, streaking light trails, motion blur, dark background, vibrant colored light streaks, night photography aesthetic`
- Negativ prompt: `static sharp lights, no movement, daylight`
- Parameter-notater: fungerer som ren fotografisk-teknikk-beskrivelse, transfererer godt på tvers av modeller siden det er et velkjent fotografisk begrep, ikke en post-processing-filter-term.
- Transfer: [SANNSYNLIG] — ikke direkte sitert prompt funnet, men "long exposure" + "light trails" er standard fotografisk vokabular som alle tre modellfamilier trener på i stort volum.

### 10. Brutalist / high-contrast monochrome

**Preset R — "Brutalist Monochrome"**
- Prompt-fragment: `brutalist high-contrast monochrome composition, raw concrete texture, stark black and white, bold geometric shapes, harsh directional shadows, shafts of light cutting through, minimal negative space`
- Negativ prompt: `soft gradient, pastel color, warm lighting, ornate detail`
- Parameter-notater: **[SANNSYNLIG]** — søk bekrefter "brutalist" er en anerkjent stiltag med eksempler som kombinerer "concrete brutalist architecture" + "shafts of light cutting through narrow vertical windows"; disse to elementene (rått betong-materiale + harde lysstriper) er det som faktisk gir gjenkjennelig brutalisme, ikke bare ordet "brutalist" alene. Kilde: [AI Image Styles 2026 — gptprompts.ai](https://gptprompts.ai/ai-image-styles).
- Transfer: [SANNSYNLIG], samme kildegrunnlag; ingen modellspesifikk begrensning funnet.

### 11. CRT / scanlines / VHS / glitch

**Preset S — "CRT Scanline Glitch"**
- Prompt-fragment: `CRT screen effect, horizontal scanlines, phosphor glow, barrel curvature distortion, subtle RGB color bleed, retro monitor aesthetic`
- Negativ prompt: `flat clean digital screen, no distortion`
- Parameter-notater: nøkkelord som faktisk styrer gjenkjennelig CRT-look ifølge effekt-verktøy-dokumentasjon: barrel curvature, phosphor mask/glow, RGB bleed, scanlines — disse fire bør alle nevnes for konsistent resultat, ellers reduseres det ofte til bare "striper".
- Transfer: [SANNSYNLIG] Kilde: [VINXLE CRT filter](https://www.vinxle.com/filters/crt) (beskriver komponentene, ikke en direkte AI-modell-prompt-kilde — språket er sannsynliggjort å transferere siden det er beskrivende fototeknisk vokabular).

**Preset T — "VHS Glitch Tape"**
- Prompt-fragment: `VHS tape aesthetic, tracking distortion, chroma bleed, tape grain noise, horizontal glitch lines, analog degradation, washed-out color`
- Negativ prompt: `clean digital, sharp focus, modern color grade`
- Parameter-notater: samme forbehold som S — komponentvokabular (tracking wobble, chroma bleed, tape grain) hentet fra effekt-verktøy-dokumentasjon, ikke en direkte AI-prompt-kilde.
- Transfer: [SANNSYNLIG], samme forbehold.

### 12. Clay / soft 3D render

**Preset U — "Soft Clay 3D Render"**
- Prompt-fragment: `3D clay render, soft matte clay material, smooth rounded forms, minimalistic background, careful balance of light and shadow, subtle ambient occlusion, vivid but muted colors`
- Negativ prompt: `photorealistic texture, sharp glossy reflections, harsh lighting, skin pores`
- Parameter-notater: **[SANNSYNLIG]** — "3D clay render" er en etablert, kjøpt/delt PromptBase-preset-term og gir "semi-realistic, highly detailed 3D clay-like renders" med minimalistisk bakgrunn som nøkkelegenskap. Kilde: [3D Clay Renders — PromptBase](https://promptbase.com/prompt/3d-clay-renders), eksempel-generasjon på [PromptHero](https://prompthero.com/prompt/b40e92382b3).
- Transfer: [SANNSYNLIG] på tvers av Midjourney/Flux; ingen modellspesifikk begrensning funnet i disse kildene.

### 13. Paper texture / organisk materiale-makro

**Preset V — "Paper Texture Macro"**
- Prompt-fragment: `macro photography of textured paper surface, organic fiber texture, soft raking light, 100mm macro lens, f/2.8, shallow depth of field, subtle grain, tactile material close-up`
- Negativ prompt: `smooth digital surface, no texture, glossy plastic`
- Parameter-notater: **[SANNSYNLIG]** — makro-tekstur-guider anbefaler eksplisitte kamera-tekniske detaljer ("100mm macro lens, f/2.8, shallow depth of field") kombinert med mikro-detalj-referanser for å tvinge modellen inn i faktisk close-up-skala i stedet for en generisk "texture pattern". Kilde: [The Best 25 Midjourney Prompts for Texture — openart.ai](https://openart.ai/blog/post/midjourney-prompts-for-texture), risograph-presetene (E, F) bekrefter at "paper grain"/"visible paper texture" separat er en gjenkjent frase.
- Transfer: [SANNSYNLIG], samme kildegrunnlag; kamera-parameter-språk (mm/f-stop) fungerer på alle tre modellfamilier ifølge [designhero.tv FLUX & Midjourney realism guide](https://blog.designhero.tv/ai-art-direction-prompts-flux-midjourney/), som bekrefter "Flux handles photorealism well and responds to rendering engine references similarly to Midjourney."

> Oppsummering av dekning: alle 15 hovedstilretningene (13 nummererte familier over, pluss chromatic/prism og iridescent/holographic delt i to presets hver = 22 presets totalt) har nå minst [SANNSYNLIG]-nivå kildedekning. Ingen preset i denne runden nådde [DOK]-nivå (primærkilde fra modell-utvikler som viser eksakt prompt), unntatt de generelle Flux/Midjourney-mekanikk-funnene i "Modell-transfer"-avsnittet som er sitert direkte fra BFL sin egen dokumentasjon.

## Malstruktur (schema) for presets

(fylles inn)

## Komponering: subject-prompt + style-fragment

(fylles inn)

## Text-to-image vs image-to-image restyling

(fylles inn)

## Modell-transfer: Flux vs SDXL-familien vs Midjourney

- **[DOK]** FLUX.2 og FLUX.1-familien støtter ikke klassiske negative prompts: modellen bruker flow-matching-trening, ikke klassisk diffusion/CFG, og BFL sier eksplisitt "focus on describing what you want, not what you don't want" — CFG-verdien er fast (~1) og gir ikke classifier-free guidance-effekt. Kilde: [BFL FLUX.2 Prompting Guide](https://docs.bfl.ml/guides/prompting_guide_flux2). → Konsekvens for preset-schema: `negative_prompt`-feltet må være valgfritt/ignorert for Flux-backend, men brukes fortsatt for SDXL-familien (SDXL, SD1.5-derivater, Playground, etc.) hvor negative prompts fungerer normalt via CFG.
- **[DOK]** Midjourneys `--sref` (style reference) og `--sw` (style weight) er en bilde-til-bilde stilreferanse-mekanisme unik for Midjourneys pipeline. Kilde bekrefter direkte: *"The --sref parameter is Midjourney-only and useless for maintaining style consistency in FLUX, DALL-E, ChatGPT, or any other tool."* Kilde: søkeresultat fra styleref.io/midlibrary-oppslag, se [Midjourney Style Reference: The Complete Guide](https://styleref.io/blog/midjourney-style-reference) og [Style Reference – Midjourney docs](https://docs.midjourney.com/hc/en-us/articles/32180011136653-Style-Reference). → **Flagg:** en preset-fil kan ikke lagre en `--sref`-kode og forvente at den fungerer i Flux/SDXL-backend. For disse må stilen reformuleres som ren tekst (fargepalett, teksturord, lys-beskrivelse, kunstnerisk referanse) — det er nettopp det denne preset-samlingen prøver å gjøre i stedet for sref-koder.
- **[SANNSYNLIG]** Midjourneys `--style raw` og generelle `--stylize` (`--s`) parametre har heller ingen direkte ekvivalent i Flux/SDXL API-kall; disse er Midjourney-spesifikke renderingsmodus-parametre, ikke prompt-tekst. Presets bygget for tekst-API'er må derfor kompensere med sterkere eksplisitt tekstuelt språk ("hyper-realistic, unstylized" vs. "painterly, stylized") heller enn en parameter.
- **[SANNSYNLIG]** SDXL-familien (og de fleste community-checkpoints/LoRAer) er den mest "klassisk" prompt-tunable av de tre: fungerer godt med vekting i parentes/tall (`(keyword:1.3)`), lange kommaseparerte tag-lister, og negative prompts. Dette er dokumentert oppførsel i utbredte SD-UI-er (Automatic1111/ComfyUI-konvensjon) — **[IKKE FUNNET, primærkilde]** eksakt vektsyntaks-dokumentasjon ble ikke hentet i dette søket pga. budsjett; regnes som velkjent community-konvensjon, ikke slått opp direkte.

## Hull og usikkerhet

(fylles inn løpende)

## Kilder

(fylles inn løpende)
