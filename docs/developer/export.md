# Export

Turning a candidate into files a landing page can serve — MP4, WebM and a poster JPEG
(PRD §8, #31). Lives in `src-tauri/src/export/` (the encoding), `src-tauri/src/commands/export.rs`
(the bridge), `src/lib/export/` (what is offerable), `src/services/export.ts` (the calls)
and `src/components/editor/ExportPanel.tsx` (the panel).

## The seam: plan, then run

Two Rust modules, and the split is the whole design.

| Module           | Knows                                                     | Testable without ffmpeg |
| ---------------- | --------------------------------------------------------- | ----------------------- |
| `export::plan`   | codecs, CRF, the width cap, the ping-pong filter graph    | yes — it returns args   |
| `export::ffmpeg` | where the binary is, how to run it, what its failure says | no                      |

Every judgement lives in `plan`, as a pure function returning argument vectors. Nothing
outside `export::ffmpeg` ever spawns a process. That is PRD §8's "abstraction that does not
care which ffmpeg it talks to": **bundling a static binary later replaces `discover()` and
touches nothing else**, because a bundled ffmpeg takes the same arguments.

## Finding the system ffmpeg

`PATH` first, then `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/usr/bin`.

The hardcoded list is not belt-and-braces. **A macOS app launched from Finder inherits
`launchd`'s `PATH`, not the shell's**, so `/opt/homebrew/bin` is missing from exactly the
machines where `brew install ffmpeg` has just succeeded. Without the fallbacks, "I installed
it and the app still says no" is the normal experience.

A candidate is accepted only if `-version` prints a banner starting `ffmpeg version `.
Something else on the `PATH` that exits zero is not an encoder, and adopting it would move
the failure to mid-export, where it arrives as an unreadable error instead of "not
installed".

The answer is probed once at startup (`export::ffmpeg::detect_at_startup`, called from
`lib.rs`) and cached in a `static Mutex<Option<Ffmpeg>>`. Detection is **never fatal** — an
app that would not launch without ffmpeg is an app you also cannot generate anything with.
`recheck_ffmpeg` re-probes, so a `brew install` in another window costs a click.

## What gets encoded

| Deliverable | Codec      | Quality                 | Notes                                     |
| ----------- | ---------- | ----------------------- | ----------------------------------------- |
| MP4         | libx264    | CRF 23, `-preset slow`  | `+faststart`, `yuv420p`, no audio track   |
| WebM        | libvpx-vp9 | CRF 33 **and `-b:v 0`** | without `-b:v 0` the CRF is read as a cap |
| Poster      | mjpeg      | `-q:v 3`                | first frame, `-frames:v 1`                |

All three are capped at `MAX_WEB_WIDTH` (1920) by `scale=w='min(1920,iw)':h=-2,setsar=1`.
The cap only ever scales down. `h=-2` rather than `-1`: 4:2:0 chroma cannot express an odd
number of rows, and an odd height is a hard encoder failure.

There is no encoder UI. A landing-page hero has one right answer for each of these, and
exposing them would ask the user to re-derive it on every export.

## Size (#58)

The one delivery decision that is _not_ fixed, because a treatment changes what more
pixels are worth. `ExportSize` is three choices, and the `w=` expression follows from it:

| Size     | `w=`             | Offered when                           |
| -------- | ---------------- | -------------------------------------- |
| `web`    | `min(1920,iw)`   | always — the default, and today's file |
| `native` | `iw`             | always — the pixels the model returned |
| `double` | `min(1920,iw)*2` | only while a treatment is being baked  |

Each is wrapped in `trunc(…/2)*2`. 4:2:0 chroma cannot express an odd number of columns
any more than an odd number of rows, and libx264 refuses the encode outright — the cap hid
this while `min(1920,iw)` was the only expression, since 1920 is even. It also keeps the
untreated width equal to `bake::shipped_size`'s `& !1`, so turning a treatment on cannot
move an odd-width deliverable by a pixel.

A pattern is generated at the output grid, so its edges stay exactly one output pixel
hard however soft the picture under it is; the upscaled photo only supplies tone, which a
quantiser mostly discards anyway. With no pattern there is nothing to keep sharp, so
`ExportSize::untreated` degrades `double` to `native` — the panel does not offer the
combination and this is the half that cannot be routed around.

**Every size is the same look.** `ExportSize::pattern_scale` gives the shader `uScale`, and the
shader measures its pattern in _look pixels_ — output pixels divided by that number. So
2× is the picture the preview showed with harder edges, not a finer screen. Two things
fall out: the effects preview stays honest at one size instead of having to follow this
choice around the app, and the MP4 gets _better_ rather than merely bigger, since a cell
several output pixels across survives the 4:2:0 chroma that ruins a one-pixel one.

`native` is the one scale that can be fractional — a 2560-wide source gives 1.333, and a
grid-based pattern then lands on look pixels one and two output pixels wide in turn. That
is what a nearest-neighbour magnification by 1.333 _is_, and it is kept rather than
rounded: rounding the scale to 1 would ship a pattern a third finer than the preview
showed, and rounding the width to a whole multiple of the cap would deliver `web` under
`native`'s name. It only arises for a treated still from an oversized style candidate —
every clip is under the cap, since the animate models emit 720p.

A 2× bake is four times the pixels to render, PNG-encode and store.

### How each path meets the size

A treated export does **not** meet the width in the filter graph: `Input::TreatedFrames`
and `Input::TreatedStill` take `geometry_filter(false)`, which squares the pixels and
evens the height and scales nothing, because a pattern rendered at one size and scaled to
another is a different pattern rather than a smaller one. Every path that produces a
treated frame therefore arrives at the chosen size on its own.

| Path                     | Arrives at the size by                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| Shader look, clip        | ffmpeg decodes the source frames to `width_expression()` in `bake::begin` |
| Shader look, still       | the webview renders at the `BakeSession`'s width, height and scale        |
| Floyd–Steinberg/Atkinson | `render_treated_still` diffuses at the look's grid and magnifies onto it  |

The third row was `native`-only until it was not, and the bug underneath it was quiet: the
kernels ran at whatever resolution the model had returned and nothing downstream rescaled
them, so a 2560-wide candidate exported a 2560-wide poster under Atkinson and a 1920-wide
one under Bayer, from the same picture, with nothing on screen saying which. They now take
an `ExportSize` like every other look — `commands::effects` turns it into the two grids
with this module's own `shipped_size` — so `availableSizes` has no reason to know which
renderer draws a treatment, and does not.

## Rewind (ping-pong), PRD §4.5's second loop

```
[0:v]scale=…,split[a][b];
[b]trim=start_frame=1,setpts=PTS-STARTPTS,reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];
[a][r]concat=n=2:v=1[out]
```

The two `trim`s are the seam. A naive `[a][reverse]concat` shows the last frame twice at
the turn and the first frame twice at the wrap — precisely the stutter rewind exists to
avoid. Dropping frame 0 before reversing and frame 0 again after it leaves the reversed
half as frames `N-2 … 1`, so the loop reads `0 … N-1, N-2 … 1` and back to `0`: every frame
once, in both directions. (Verified: a 10-frame clip comes out at 18.)

`reverse` buffers the decoded stream in memory, which is fine for a hero clip of a few
seconds and would not be for anything longer.

Rewind and native end-frame looping **combine rather than conflict**. A natively seamless
clip played forward-then-backwards is still seamless, just twice as long for a loop it
already had — so the panel says so (`export.rewind.alreadyLoops`) rather than refusing.

The switch on the animate stage records the intent into the recipe like any other option;
`controlAvailability(model, 'rewind')` is unconditionally `available`, because rewind is
ffmpeg rather than the model. It deliberately does **not** consult whether ffmpeg is
installed — an intent outlives the machine it was recorded on, and a project must not read
differently when opened somewhere without ffmpeg. The missing binary is surfaced where it
bites, in the export panel.

The export panel seeds its switch from the recipe and leaves it live: ping-pong is a
post-process, so changing one's mind costs an encode rather than a generation.

That override is **per candidate, and says so** — it is stored as
`{generationId, rewind}`, not as a bare boolean. The panel is never remounted when the
stage tab or the project changes, so a bare boolean would follow the user onto the next
clip and export it rewound against what its own recipe says. Naming the candidate makes the
override expire by construction, with no effect to keep in step. The destination
deliberately does **not** expire the same way: a folder is app-wide (PRD §11), a candidate
is not.

Note the split this leaves: the animate-stage switch records the _intent_ into the recipe,
and the export-panel switch decides what _this_ encode does. Only the first is persisted.

## Stills export too

A still exports its **poster** and nothing else — "a styled still is a legitimate final
deliverable" (#31). The video checkboxes stay on screen, disabled (PRD §10.1), so the panel
never looks like a tool that cannot make an MP4. `plan()` refuses `NotAClip` if one is asked
for anyway.

## Where the files go

The destination is chosen through the system picker and remembered in
`AppPreferences.export_directory` — app-wide rather than per project (PRD §11), because a
folder is a place on this machine. It is written back **on success**, so a failed export
does not leave an unwritable folder as the one offered next time.

File names are `<project>-<stage>-<ordinal>` plus `-poster` for the JPEG, built by
`exportBaseName` from the project's own name — the export lands in somebody's `public/`
folder, where `atlas-hero-animate-2.mp4` is a name and a UUID is a barcode. The stage word
is the domain term rather than a translated one: a file name that moved with the app's
language would break every link on the page that used it.

Rust filters the name again (`safe_base_name`) before it becomes a file. That is not
politeness — the steps run with the destination as their **working directory**, so a name
carrying a separator would otherwise write outside the folder the user chose.

`-y` on every step: re-exporting the same candidate is how you change one setting, and the
name is derived from the generation, so an overwrite can only ever replace an earlier
export of the same thing.

## Why export is a mutation and not a job

Jobs (`jobs/`) exist because fal charges money, takes minutes, and lives across a process
boundary that may not survive a quit — hence a store, a resume path and a cancel. ffmpeg is
local, free and finishes in seconds. A queue would be machinery for a problem export does
not have.

The encode does run on a blocking thread (`spawn_blocking`): a WebM of a ten-second hero is
tens of seconds of CPU, and tens of seconds on an async runtime thread is the whole UI.
