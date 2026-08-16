# UI Patterns

## Overview

This app uses a modern CSS stack optimized for Tauri desktop applications:

- **Tailwind CSS v4** with CSS-based configuration
- **shadcn/ui v4** component library
- **OKLCH color space** for perceptually uniform colors
- **Desktop-specific defaults** for native app feel

## Tailwind v4 Configuration

Tailwind v4 uses CSS-based configuration instead of `tailwind.config.js`.

### File Structure

```
src/
├── App.css              # Main window styles + Tailwind imports
├── quick-pane.css       # Quick pane window styles
└── theme-variables.css  # Shared theme variables (colors, radii)
```

**Multi-window theming**: `theme-variables.css` is imported by both `App.css` and `quick-pane.css` so all windows share the same theme tokens. When adding new color variables, add them to `theme-variables.css`.

### Structure

```css
@import 'tailwindcss'; /* Core Tailwind */
@import 'tw-animate-css'; /* Animation utilities */

@custom-variant dark (&:is(.dark *)); /* Dark mode variant */

@theme inline {
  /* Map CSS variables to Tailwind tokens */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* ... */
}

:root {
  /* Light mode values */
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
}

.dark {
  /* Dark mode overrides */
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
}

@layer base {
  /* Global base styles */
}
```

### Key Concepts

| Directive              | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `@theme inline`        | Maps CSS variables to Tailwind's design token system |
| `@custom-variant dark` | Enables `dark:` prefix based on `.dark` class        |
| `@layer base`          | Base styles that apply globally                      |

### Adding Custom Colors

To add a new semantic color:

```css
@theme inline {
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
}

:root {
  --success: oklch(0.7 0.15 145);
  --success-foreground: oklch(1 0 0);
}

.dark {
  --success: oklch(0.6 0.15 145);
  --success-foreground: oklch(1 0 0);
}
```

Then use with Tailwind: `bg-success text-success-foreground`

## Dark Mode

### How It Works

1. **ThemeProvider** (`src/components/ThemeProvider.tsx`) manages theme state
2. Adds `.dark` class to `<html>` element when dark mode is active
3. CSS variables in `.dark` override `:root` values
4. Tailwind's `dark:` variant applies styles conditionally

### Theme Options

- `light` - Force light mode
- `dark` - Force dark mode
- `system` - Follow OS preference (default)

### Using in Components

```tsx
// Access theme in components
import { useTheme } from '@/hooks/use-theme'

function MyComponent() {
  const { theme, setTheme } = useTheme()

  return <button onClick={() => setTheme('dark')}>Current: {theme}</button>
}
```

### Why `.dark` Class (Not `light-dark()`)

This app uses the `.dark` class approach rather than CSS `light-dark()` because:

- Standard pattern for shadcn/ui ecosystem
- JavaScript control over theme switching
- Supports "system" preference detection
- Compatible with all shadcn components

## OKLCH Colors

All colors use the OKLCH color space for perceptual uniformity.

### Format

```css
oklch(lightness chroma hue)
oklch(0.7 0.15 250)  /* L: 0-1, C: 0-0.4, H: 0-360 */
```

### Why OKLCH

- **Perceptually uniform** - Equal steps in values = equal perceived change
- **Wide gamut** - Access to P3 display colors
- **Intuitive** - Lightness is predictable (unlike HSL)

### Color Palette Structure

| Token                                    | Purpose                   |
| ---------------------------------------- | ------------------------- |
| `--background` / `--foreground`          | Page background and text  |
| `--card` / `--card-foreground`           | Card surfaces             |
| `--primary` / `--primary-foreground`     | Primary actions           |
| `--secondary` / `--secondary-foreground` | Secondary actions         |
| `--muted` / `--muted-foreground`         | Subdued elements          |
| `--accent` / `--accent-foreground`       | Highlights                |
| `--destructive`                          | Destructive actions (red) |
| `--border` / `--input` / `--ring`        | Borders and focus rings   |

## Desktop-Specific Styles

The `@layer base` section includes styles that make the app feel native on desktop.

### Text Selection

```css
body {
  user-select: none; /* Disable by default */
}

input,
textarea,
[contenteditable='true'] {
  user-select: text !important; /* Enable in editable areas */
}
```

**Why:** Desktop apps typically don't allow selecting UI text, only content.

### Cursor

```css
* {
  cursor: default; /* Arrow cursor everywhere */
}

input,
textarea {
  cursor: text !important;
}

.cursor-pointer {
  cursor: pointer !important;
}
```

**Why:** Native apps use arrow cursor, not text cursor on labels.

### Scroll Behavior

```css
body {
  overscroll-behavior: none; /* Prevent bounce/refresh */
  overflow: hidden; /* Prevent body scroll */
}
```

**Why:** Prevents pull-to-refresh and elastic scrolling that feels wrong in desktop apps.

### Drag Regions

```css
*[data-tauri-drag-region] {
  -webkit-app-region: drag;
  app-region: drag;
}
```

Apply `data-tauri-drag-region` to elements that should drag the window (like title bars).

## Component Organization

```
src/components/
├── layout/           # App structure
│   ├── MainWindow.tsx
│   ├── RightSideBar.tsx
│   └── MainWindowContent.tsx
├── overview/         # The front door — project cards (#55)
├── editor/           # The stage editor for the open project
├── titlebar/         # Window chrome
│   ├── TitleBar.tsx
│   ├── MacOSWindowControls.tsx
│   └── WindowsWindowControls.tsx
├── ui/               # shadcn primitives
│   ├── button.tsx
│   ├── dialog.tsx
│   └── ...
├── command-palette/  # Command palette feature
├── preferences/      # Preferences dialog
├── ThemeProvider.tsx
└── ErrorBoundary.tsx
```

### Conventions

- **layout/** - Structural components that define app regions
- **titlebar/** - Platform-specific window controls
- **ui/** - shadcn/ui primitives (don't modify directly)
- **Feature folders** - Group related components together

## Onboarding Steps

Onboarding is a declarative list, split so the dependency points from `components/` into
`lib/` — `lib/` is pure logic and never imports a component.

| Location                           | Holds                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/onboarding/steps.ts`      | `OnboardingStep`, `onboardingVersion`, `stepsSince`, `needsOnboarding` |
| `src/components/onboarding/steps/` | The step components, and `index.ts` with `ONBOARDING_STEPS`            |

**Completion is a version integer, not a boolean.** Each step carries the onboarding
version that introduced it; the stored `onboarding_version` in preferences says how far a
user has been walked. `stepsSince(steps, stored)` returns only what is newer, so a step
added later re-prompts existing users with _that step alone_ while a first-time user
(stored `0`) gets the lot. A boolean could express neither.

`ONBOARDING_VERSION` is derived from the list (`onboardingVersion(ONBOARDING_STEPS)`),
never declared beside it — a hand-kept constant would eventually disagree, and the
disagreement would be invisible.

**Adding a step**: write the component in `src/components/onboarding/steps/`, add one
entry to `ONBOARDING_STEPS` in that folder's `index.ts` with `version` one above the
current `ONBOARDING_VERSION`. Nothing else changes — `OnboardingDialog` walks whatever
list it is handed, which is also how its tests hand it a longer one.

## Runs of Candidates

One click produces several candidates (PRD §4.2 — four images, one video), and the
choice between them is the point. Three pieces make that work, and they are easy to
break independently.

**The run id.** Every candidate carries `runId` in the manifest, minted by
`mintRunId()` in `lib/recipe/runs.ts` — the only place a run id is ever made, used by
the click (`planRun`) and by the sweep that adopts work a previous launch left behind, so
neither can group candidates differently from the other. One `runId` covers a whole
**fan-out**: three models at two candidates each is six jobs and one question (ADR 0005). `null` is a normal value: a candidate from before the field existed, or one
whose job settled before anything saw it. The strip groups on it (`runGroups`) and
shows nothing for a `null` group rather than inventing one.

**The grid.** While a run is unanswered, `Canvas` shows `RunGrid` over the graph: every
candidate at the same size, placeholders where the rest will land. It is
driven by the `RunRecord` in editor state, **never** by the job list — `active_jobs`
returns only what is _running_, so a job-driven grid would empty out exactly when the
four-up was finally complete. The record also survives a job stalling, failing, or
being cancelled: those ids move to `abandonedIds` and the grid stops waiting for them
rather than showing a placeholder forever.

**The pick hold.** Two flags on the run record say what has been decided about
it: `claimed` (one of its candidates has taken the node's `pick`) and `answered`
(the user picked, dismissed, or chose something else on that node). An arrival may
take the pick only if its own run is neither. That one rule gives all of: the
first arrival claims an undecided node (so anything downstream always has an input), the
second and third do not (or a four-up would end on whichever job finished last), and
none of them do after the user has clicked — until the next `beginRun`, because asking
for new candidates is asking to be shown one. Keeping this on the runs rather than in a
field of its own is what makes the hold survive closing and reopening a project whose
jobs are still running.

A run a previous launch left behind is adopted into a `RunRecord` by `useAdoptedRuns`
in `services/jobs.ts`, so resuming looks like running: same grid, same grouping.

## Stage Inputs

The stages are independent (PRD §4.1), and that independence now runs in both
directions: a stage may consume any **earlier** candidate, not only the one
immediately before it. A source that came out right is animated directly, without
paying for a pass-through style pass. There is no "skip" control anywhere, because a
skipped stage is not a mode — it is an input that came from further back.

**The pointer lives on the draft.** `StageRecipe.inputGenerationId` has always
existed and drafts are `StageRecipe`s, so the input is a normal draft field: persisted
in `project.json`, restored by `restoreRecipe`, frozen onto each candidate by
`freezeRecipe`. It is deliberately **not** a selection — `project.selection[stage]`
means "the candidate this stage produced that I have settled on", and pointing animate
at a source is not a claim about the style stage at all. Writing one into the other is
the bug `restoreRecipe`'s `followable` check exists to prevent.

**Three answers, in falling order of deliberateness.** `resolvedInputId` returns what
the draft names, then the upstream selection (which is what this was unconditionally
before), then the newest candidate of the nearest upstream stage with any. Answer 2 is
why nothing changes for anyone who ignores the feature; answer 3 is why skipping costs
no extra clicks. Answer 3 walks the stages **one at a time, nearest first** — flattening
them into one list and taking the last entry ranks by arrival, which silently prefers
the furthest stage and would animate a raw source over a styled still.

**One predicate, one home.** `isEligibleInput` is the only place that decides whether a
candidate may serve as a stage's input — membership of an earlier stage, which is what
makes a cycle unrepresentable. It is asked on both sides of the reducer boundary
(`resolvedInputId` for a stored pointer, `pointableInput` for an incoming one), and two
copies of it had already started to drift.

**Two components, two panes.** `InputRow` (main pane) is the thumbnail carousel that
_changes_ the input, head of the row preselected. `InputSummary` (right sidebar) is one
line naming the same answer above the run button. Both read `resolvedInputId`, so they
cannot disagree about what a run would take. Do not put `InputRow` in the sidebar — it
renders thumbnails into a column of form controls.

`blockedReasonKey` therefore refuses on "no picture anywhere behind this stage"
(`editor.reason.needsInput`) rather than on "the previous stage has not been run".

## shadcn/ui Usage

### Adding Components

```bash
npx shadcn@latest add button
npx shadcn@latest add dialog
```

Components are copied to `src/components/ui/` and can be customized.

### Customizing Components

shadcn components are yours to modify. Common customizations:

```tsx
// src/components/ui/button.tsx
const buttonVariants = cva('...', {
  variants: {
    variant: {
      default: 'bg-primary text-primary-foreground',
      // Add custom variant
      success: 'bg-success text-success-foreground',
    },
  },
})
```

### Available Components

This app includes commonly needed components. Run `npx shadcn@latest add [component]` to add more from [ui.shadcn.com](https://ui.shadcn.com/docs/components).

### Components from other registries

The official registry is the default and the first place to look. It does not cover
everything — there is no colour picker in it, for instance — and the CLI takes a registry
URL as well as a name:

```bash
npx shadcn@latest add https://www.kibo-ui.com/r/color-picker.json
```

A namespaced component lands in **its own directory** (`src/components/kibo-ui/`) rather
than in `ui/`, which is why `eslint.config.js` exempts that path alongside `ui/`. Decline
the overwrite prompts for `button.tsx`, `input.tsx` and `select.tsx` — a registry lists
those as dependencies and will happily replace this project's copies with its own.

Treat a non-official component as **code you now own**, not a dependency. Read it before
using it and expect to fix things: the colour picker arrived with four defects, all of them
documented in the patch note at the top of
`src/components/kibo-ui/color-picker/index.tsx`. Re-running `add` silently reverts every
one, so read the diff before accepting an update.

Prefer the official registry, then a vendored component you have read, then writing it
yourself. Adding a whole second component library (HeroUI, MUI) for one control is the
option to argue for explicitly — it means a second design system, provider and theme in an
app that already has one.

## The `cn()` Utility

All components use the `cn()` utility for conditional classes:

```tsx
import { cn } from '@/lib/utils'

function MyComponent({ className, disabled }) {
  return (
    <div
      className={cn(
        'base-styles here',
        disabled && 'opacity-50',
        className // Allow overrides
      )}
    >
      ...
    </div>
  )
}
```

**Pattern:** Always accept `className` prop and merge with `cn()` for flexibility.

## Component Patterns

### Layout Components

Layout components should:

- Accept `children` and `className` props
- Use flexbox with `overflow-hidden` to prevent content bleed
- Not set external margins (let parent control spacing)

```tsx
interface SideBarProps {
  children?: React.ReactNode
  className?: string
}

export function RightSideBar({ children, className }: SideBarProps) {
  return (
    <div className={cn('flex flex-col h-full overflow-hidden', className)}>
      {children}
    </div>
  )
}
```

### Visibility with CSS

For **panels that toggle** within a view, prefer CSS over conditional rendering.
This does not apply to swapping one whole view for another — the overview and
the editor are mutually exclusive (#55), and keeping the hidden one mounted
would leave it polling and collecting behind the one on screen:

```tsx
// Good: Preserves component state
;<ResizablePanel className={cn(!visible && 'hidden')}>
  <SideBar />
</ResizablePanel>

// Avoid: Loses component state on hide/show
{
  visible && <SideBar />
}
```

This preserves scroll position, form state, and resize dimensions.

```tsx
// Also good: a whole-view swap, where there is no state worth preserving and
// the hidden view would keep doing work.
{
  view === 'overview' ? <Overview /> : <Editor />
}
```

## Best Practices

### Do

- Use semantic color tokens (`bg-background`, `text-foreground`)
- Accept `className` prop on components
- Use `cn()` for conditional classes
- Keep desktop UX conventions (cursor, selection, scroll)
- Follow existing patterns in codebase

### Don't

- Use raw color values (`bg-white`, `text-gray-900`)
- Hardcode light/dark specific values
- Override shadcn components in place (copy and modify instead)
- Add `cursor-pointer` everywhere (only for actual clickable elements)
- Use viewport-based responsive design (this is a fixed-size desktop app)
