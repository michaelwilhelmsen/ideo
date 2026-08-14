# Post-effects — measured

**Measured 2026-08-14** on Apple M1 Max, 10 cores (8 performance + 2 efficiency), macOS
26.x, rustc 1.95.0, `opt-level = 3` with LTO.

This is the #52 spike. It replaces the extrapolated figures in
[`post-effects.md`](post-effects.md) §3 and the reasoned inference in §1a with numbers and
pictures produced here. **Where the two documents disagree, this one is measurement and
that one is inference.** §1a and §3 of the older document now carry pointers to this one.

Code: [`spikes/post-effects/`](../../spikes/post-effects/) — a standalone crate, not
depended on by the app. Reproduce with:

```bash
cd spikes/post-effects && cargo run --release --bin duotone-ab -- --out ~/ideo-spike-52 && cargo run --release --bin bench -- --out ~/ideo-spike-52
```

Output — 60 contact sheets, `stats.md` and `latency.md` — is written **outside the
repository** (default `~/ideo-spike-52`, 403 MB). It is derived from the local project
store's generated images and is deliberately not committed.

## Sources

Three of the app's own generated outputs, read in place from
`~/Library/Application Support/com.ideo.app/projects/`, covering the three categories #52
asks for:

| slug           | size      | what it is                                                                                                 |
| -------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `photographic` | 2048×1440 | continuous tone, one very large smooth gradient (a lit wall), a hard shadow edge                           |
| `highkey`      | 2560×1440 | blown-out pastel — the `*-highkey` recipes' own territory, and the raw model output size for the benchmark |
| `flatgraphic`  | 2048×1440 | large even areas, hard edges, saturated non-neutral hues                                                   |

Everything below is in **linear light**, converted with the exact sRGB transfer function
(not a gamma-2.0 approximation) so that no conversion error is shared between the arms of
the A/B. The round trip is exhaustively tested over all 256 byte values.

---

## Q1 — Does duotone quantise first, or colourise last?

### Handed back undecided

#52 says the verdict is made by eye elsewhere, so this section describes and does not
choose. The pictures are in `~/ideo-spike-52/duotone-ab/`, with a `README.md` that repeats
the panel order.

### The arms

| arm                                         | what it does                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — quantise then dither**                | What `rs-duotone-dither` and `gn-duotone-landscape` say on screen today. Nearest palette entry **in linear RGB**; the per-channel colour error is what gets diffused.                                             |
| **B — dither then colourise**               | What [`post-effects.md`](post-effects.md) §1a reasons toward, implemented exactly as its own code sketch has it: threshold source luminance against an even `0..1` scale, map the resulting index to an ink last. |
| **C — dither then colourise, luma-matched** | **Not one of the two orders #52 named.** See below.                                                                                                                                                               |

Rendered across 3 sources × 5 palettes (`ramp2/3/4` between Studio's `ink` and `primary`;
`brand3/4` using Studio's actual roles) × 2 kernels (Atkinson, Floyd–Steinberg), at hero
width (1920px) and at 1:1.

### Why there is a third arm

Arm B as written loses a large share of the frame's light — on `brand4` it lands at mean
linear luminance 0.06–0.22 against sources of 0.19–0.54. The cause is not the ordering. It
is that B's mask assumes the inks are evenly spaced in lightness, and Studio's are not.
Measured linear luminances: `ink` 0.006, `secondary` 0.071, `primary` 0.244, `paper` 0.867.
Normalised, the palette's own levels sit at 0, 0.076, 0.277, 1.0 — so an even four-step
scale puts **both** of its interior levels (0.333 and 0.667) inside the one gap the palette
has no ink for.

Handed back without a control, the sheets would show B looking crushed and a reader would
attribute that to _colourising last_ when it is caused by _level placement_. Arm C is
identical to B except that its levels are spaced like the palette's own luminances
(normalised to `0..1`). It still colourises last; colour still never enters the threshold.

Two consequences worth knowing while reading the sheets:

- **At N = 2 there is no interior level to place, so C is the same picture as B.** C only
  says anything at N ≥ 3.
- **On any `rampN` palette, C is the same picture as B at every N.** A ramp is a straight
  line in linear RGB and luminance is a linear function of RGB, so a ramp's luminances are
  already evenly spaced. C differs from B only on the `brand` palettes — which is exactly
  where it was meant to.

### What the pictures show

**Neither claimed failure mode appeared.** Both shipped presets and the research warn the
other order produces "mud". Across all 60 sheets, neither arm produced a muddy,
low-contrast, incoherent result. Both produce clean, readable reductions. That framing
should be dropped from the argument.

**The real difference is what the reduction stays faithful to.**

- **A is faithful to hue.** A blue sky gets the bluest ink available; poppies get the
  orange. On `flatgraphic`/`brand4` the result reads like the original's colour logic
  reduced to four inks.
- **B and C are faithful to lightness only.** Colour is assigned by position on a tone
  ramp, so a blue sky and an orange wall of the same lightness receive the _same_ ink. On
  the same sheet, B renders the sky orange and the flowers blue — a coherent picture, but
  one whose colour relationships are inverted relative to the source.

**A holds the frame's mean luminance; B does not; C mostly recovers it.** Averaged over the
sheets, `|arm − source|` mean linear luminance:

| palette | A↔B pixels differing | \|A − source\| | \|B − source\| | \|C − source\| |
| ------- | -------------------- | -------------- | -------------- | -------------- |
| brand3  | 49.2%                | 0.018          | 0.138          | 0.048          |
| brand4  | 60.5%                | 0.018          | 0.220          | 0.047          |
| ramp2   | 37.5%                | 0.219          | 0.286          | 0.286          |
| ramp3   | 55.7%                | 0.218          | 0.285          | 0.285          |
| ramp4   | 64.0%                | 0.217          | 0.285          | 0.285          |

The large `ramp*` figures are a property of the palette, not of any arm: Studio's `primary`
is Y=0.244 and the sources average 0.19–0.54, so on a two-ink orange-on-black palette _no_
arm can reach the source's brightness. Read the `brand*` rows for the arms' behaviour and
the `ramp*` rows for the palette's ceiling.

**On high-key sources the ranking reverses.** `highkey`/`ramp2`/Atkinson at hero size is
the clearest case: arm A nearly loses the subject into the field, while B and C hold it.
This matters because the `*-highkey` recipes are precisely the ones authored for this
treatment.

**Texture is comparable; the difference is not in the grain.** At 1:1 the dither texture of
the two orders is of similar quality on the same kernel. The disagreement is in colour
assignment and macro tone, not in how good the dither looks.

**The predicted per-channel noise is real but is not "mud".** On `flatgraphic`, arm A
renders a large flat saturated area as a two-ink dither rather than a solid — the research's
predicted per-channel behaviour. It reads as deliberate texture, not as a defect. Whether it
is _wanted_ on a flat-graphic source is a judgement, which is the judgement being handed
back.

**#36's convergence guess does not hold.** The ticket expected that "for a two-entry palette
these may converge mathematically". Measured on the real sources, arms A and B differ on
23–49% of pixels at N=2 (mean 37.5%), rising to 64% at N=4. There is no palette size at
which the choice is a formality.

### The `note` copy edit is still pending

`Preset.note` is displayed to the user ([`presets.ts:218`](../../src/lib/recipe/presets.ts)),
so if arm A loses, `rs-duotone-dither` in `presets.json` and `gn-duotone-landscape` in
`source-presets.json` are wrong on screen. That edit belongs to #36's "write the answer
down" bullet and cannot be made until the verdict is in. One thing the spike _can_ settle
in advance: the word **"mud" should not appear in either revision**, in either direction —
it describes a failure neither order produced.

---

## Q2 — What is preview latency, actually?

Median of 5–9 runs after a warm-up. Kernel only, in linear light, including its own buffer
allocation — a production implementation reusing buffers across frames would be faster, so
these are pessimistic in the right direction. Full table in `~/ideo-spike-52/latency.md`.

### The working-space tax, which every effect pays

| size      | decode sRGB→linear | encode, exact `powf` | encode, 4096-entry table |
| --------- | ------------------ | -------------------- | ------------------------ |
| 1024×576  | 1.1 ms             | 7.2 ms               | 1.5 ms                   |
| 1920×1080 | 4.4 ms             | 25.3 ms              | 5.3 ms                   |
| 2560×1440 | 7.6 ms             | 44.9 ms              | 9.4 ms                   |

**Finding worth acting on: the exact encode is the single most expensive mandatory step in
the whole set, and a table removes 4/5 of it.** Decode is already cheap because there are
only 256 possible inputs. Encode takes an `f32`, so it needs a real table — indexed by
`sqrt(v)`, since a linearly-indexed table spends its resolution on the highlights where
sRGB is nearly straight and starves the shadows where it bends. 4096 entries so indexed
land within one byte of exact across the whole domain (tested exhaustively at 100k
samples). #36 should build this once and not price linear light off the `powf` number.

### The asymmetry #52 asked for

| size      | slowest ordered dither | slowest error diffusion, serial | slowest error diffusion, pipelined ∥ |
| --------- | ---------------------- | ------------------------------- | ------------------------------------ |
| 1024×576  | 1.8 ms                 | 13.0 ms                         | 74.3 ms                              |
| 1920×1080 | 6.1 ms                 | 45.9 ms                         | 242.2 ms                             |
| 2560×1440 | 10.9 ms                | 81.4 ms                         | 465.4 ms                             |

**Ordered dither is 6–8× cheaper than error diffusion at every size**, and that gap is the
whole basis of the preview decision.

**The parallel error diffusion is 5× _slower_ than serial, and that is the surprise.** The
scheme measured is pipelined rows — row `y` starts once row `y-1` is two columns ahead,
which is the furthest right any downward tap reaches. It is a genuine parallelisation and
not a different algorithm: its output is byte-identical to the serial run, which is
asserted as an equality in the crate's tests. It is simply not worth it. With a lead of two
columns, threads spend most of their time spinning, every error accumulation goes through
an atomic that defeats vectorisation, and adjacent rows on different cores fight over the
same cache lines.

Be precise about what that does and does not show. It shows that **the obvious exact
parallelisation of error diffusion is a pessimisation on this hardware**, so #36 should not
budget for one. It does not show that error diffusion cannot be parallelised — the
block-interlaced and pinwheel schemes in the literature would likely help, but they change
the output, which is a different tradeoff and out of scope here.

### The rest of the set

At 2560×1440, serial → parallel (rayon):

| kernel                        | serial  | ∥      | speedup |
| ----------------------------- | ------- | ------ | ------- |
| palette quantise, 2 entries   | 7.3 ms  | 1.5 ms | ×4.8    |
| palette quantise, 16 entries  | 39.6 ms | 7.6 ms | ×5.2    |
| posterise, 6 levels           | 1.5 ms  | 0.9 ms | ×1.8    |
| pixelate, 8px cells           | 17.4 ms | 4.9 ms | ×3.5    |
| film grain                    | 5.4 ms  | 1.4 ms | ×3.7    |
| ASCII cell mapping, 8px cells | 3.3 ms  | 0.6 ms | ×5.7    |

Nothing outside error diffusion is anywhere near the budget once parallelised. Palette
quantisation is the only one that scales badly with parameters — a linear scan over
entries, ×5.4 from 2 to 16 — and a k-d tree or a coarse RGB lookup grid would flatten that
if #36 ever wants large palettes.

### Recommended preview shape

**Option 2 of the three #52 lists: exact at full resolution for the ordered and pointwise
families, reduced-resolution approximation for error diffusion, and the UI says which it is
showing.**

The numbers behind that:

- **Ordered dither and everything pointwise: exact at full resolution, comfortably.** At
  2560×1440 the worst ordered kernel is 10.9 ms; decode plus a table encode adds 17 ms.
  About 28 ms end to end, well inside the budget, with the parallel path unused as reserve.
- **Error diffusion at full resolution fits on this machine, but only just.** 81 ms of
  kernel at 2560×1440, 98 ms once decode and encode are added. That is the whole 100 ms
  budget for one frame, on a 10-core M1 Max, with nothing left for the UI. Option 1 is
  affordable here and will not be on a slower machine.
- **Error diffusion at preview resolution is cheap.** 13 ms at 1024×576, about 16 ms end to
  end. That is a sixth of the budget and leaves room to spare.
- **Parallelising the gap away is not available**, per the finding above.

So the honest UI is the one #36 already anticipated: the ordered families previewed exactly,
error diffusion previewed at reduced resolution and labelled as approximate, both baked at
full resolution on export.

**The label is not a formality.** Error-diffusion texture is defined at pixel scale, so a
1024-wide preview shows a visibly coarser grain than the 1920- or 2560-wide bake — the
preview is not the export shrunk, it is a different picture. That is the thing the UI has to
admit to.

### Video, which the table also settles

At 2560×1440, error diffusion costs 57–81 ms per frame serially. A 5-second 24 fps clip is
120 frames: roughly 7–10 seconds of dithering alone, plus decode and encode per frame.
Fine for an export job, impossible for a live preview. Ordered dither over the same clip is
about 1.3 seconds. This is a second, independent reason for [`post-effects.md`](post-effects.md)
§4's recommendation to prefer Bayer over error diffusion on video, alongside the
frame-stability argument it already makes.

---

## What this spike does not answer

- **No GPU path was measured.** Whether `wgpu` beats the parallel CPU path for the ordered
  and pointwise families is untested; the CPU numbers say it is not needed at these sizes.
- **No block-interlaced or pinwheel error diffusion was implemented.** Those change the
  output, so they are a design decision for #36 rather than a measurement.
- **Halftone screening with CMYK rosette angles was not benchmarked.** Only the
  clustered-dot 8×8 screen stands in for that family, and it costs the same as Bayer.
- **Only one machine.** Every number is Apple silicon. The recommendation above is
  deliberately the one that survives slower hardware.
- **Encode/decode are `image`-crate PNG/JPEG paths in the A/B only.** The benchmark's
  decode and encode rows measure the sRGB↔linear conversion, not file I/O or codec work.
