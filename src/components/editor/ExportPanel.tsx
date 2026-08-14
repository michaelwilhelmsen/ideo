/**
 * Export, in the right sidebar under the stage's parameters (#31, PRD §8).
 *
 * A panel rather than a dialog, and always on screen: export is available from
 * *every* stage — "a styled still is a legitimate final deliverable" — so it
 * follows the selection rather than being summoned. What it acts on is whatever
 * the active stage has selected, which means switching tabs switches what would
 * be exported, and the panel says which candidate that is rather than leaving it
 * to be inferred.
 *
 * The three checkboxes are the whole encoding UI. Bitrates, CRF and the width
 * cap are decisions this app has already made (`export::plan`) — a landing-page
 * hero has one right answer for each, and exposing them would be asking the
 * user to re-derive it every time.
 *
 * A missing ffmpeg is a state this renders, not an error it reports: the button
 * is disabled, the install line is shown, and the re-check button means a `brew
 * install` in another window costs a click rather than a relaunch (PRD §8).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { open } from '@tauri-apps/plugin-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  anyRequested,
  availableFormats,
  DELIVERABLES,
  exportBaseName,
  mediumOf,
  requestedFormats,
  rewindIsRedundant,
  rewindWanted,
  type Deliverable,
  type Formats,
} from '@/lib/export'
import { selectedGeneration, type Project, type StageKind } from '@/lib/recipe'
import {
  useExportGeneration,
  useFfmpegStatus,
  useRecheckFfmpeg,
} from '@/services/export'
import { usePreferences } from '@/services/preferences'
import { useGenerationName } from './naming'

/** What Homebrew calls it, shown verbatim so it can be copied and pasted. */
const INSTALL_COMMAND = 'brew install ffmpeg'

export function ExportPanel({
  project,
  stage,
}: {
  project: Project
  stage: StageKind
}) {
  const { t } = useTranslation()
  const nameOf = useGenerationName()

  const selected = selectedGeneration(project, stage)
  const medium = mediumOf(selected)
  const possible = availableFormats(medium)

  const ffmpeg = useFfmpegStatus()
  const recheck = useRecheckFfmpeg()
  const preferences = usePreferences()
  const exporter = useExportGeneration()

  // Ticked boxes are session state and nothing more: they are a question about
  // this click, and persisting them would mean a project remembering that
  // somebody once wanted only a WebM.
  const [wanted, setWanted] = useState<Formats>({
    mp4: true,
    webm: true,
    poster: true,
  })
  const [destination, setDestination] = useState<string | null>(null)

  /**
   * An override that names the candidate it was made about.
   *
   * A bare boolean would outlive its clip: this panel is not remounted when the
   * stage tab or the project changes, so "rewind this one" set on an animate
   * candidate would still be on over the next one, whose recipe says otherwise.
   * Naming the candidate makes the override expire by construction, with no
   * effect to keep in step.
   */
  const [override, setOverride] = useState<{
    generationId: string
    rewind: boolean
  } | null>(null)

  // The folder is the remembered one until this session picks another (PRD
  // §11). Read this way round rather than seeded into state, because
  // preferences arrive a tick after the first render and a seeded `useState`
  // would keep the empty answer it was born with. Deliberately *not* reset when
  // the selection moves: the folder is app-wide, and a candidate is not.
  const folder = destination ?? preferences.data?.export_directory ?? null

  // The recipe's answer until the user says otherwise about this candidate.
  // Rewind is a post-process, so changing one's mind costs an encode rather
  // than a generation — which is why the switch stays live on an existing clip.
  const rewind =
    override !== null && override.generationId === selected?.id
      ? override.rewind
      : rewindWanted(selected)

  const formats = requestedFormats(wanted, medium)
  const available = ffmpeg.data?.available === true

  const blocked =
    medium === 'nothing'
      ? 'export.reason.nothingSelected'
      : !available
        ? 'export.reason.noFfmpeg'
        : folder === null
          ? 'export.reason.noFolder'
          : !anyRequested(formats)
            ? 'export.reason.noFormats'
            : null

  const pickFolder = async (): Promise<void> => {
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: folder ?? undefined,
    })

    // A cancelled dialog is not a failure and gets no message.
    if (typeof picked !== 'string') return
    setDestination(picked)
  }

  const runExport = (): void => {
    if (selected === null || folder === null) return

    exporter.mutate({
      projectId: project.id,
      generationId: selected.id,
      destination: folder,
      baseName: exportBaseName(project.name, selected),
      // Spread rather than named one by one: the three booleans are the same
      // three on the wire, and a hand-written copy is three chances to put one
      // under the wrong name.
      ...formats,
      rewind,
    })
  }

  return (
    <section className="flex flex-col gap-4 border-t border-border p-4">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">{t('export.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {selected === null
            ? t('export.nothingSelected')
            : t('export.exporting', { name: nameOf(selected) })}
        </p>
      </header>

      {/* Where it lands, remembered between runs so the second export goes
          where the first one did without being asked again. */}
      <Field>
        <FieldLabel>{t('export.destination')}</FieldLabel>
        <FieldDescription className="truncate font-mono">
          {folder ?? t('export.noFolder')}
        </FieldDescription>
        <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
          {t('export.chooseFolder')}
        </Button>
      </Field>

      <FieldSet>
        <FieldLegend variant="label">{t('export.formats')}</FieldLegend>
        {DELIVERABLES.map(deliverable => (
          <FormatBox
            key={deliverable}
            deliverable={deliverable}
            checked={formats[deliverable]}
            disabled={!possible[deliverable]}
            onChange={next =>
              setWanted(current => ({ ...current, [deliverable]: next }))
            }
          />
        ))}
        {medium === 'still' && (
          <FieldDescription>{t('export.stillIsAPoster')}</FieldDescription>
        )}
      </FieldSet>

      {/* PRD §4.5's second looping mechanism. Offered on any clip, because it
          is ffmpeg rather than the model — no registry column gates it. */}
      {medium === 'clip' && (
        <Field>
          <FieldLabel>{t('editor.field.rewind')}</FieldLabel>
          <div className="flex items-center gap-2">
            <Switch
              id="export-rewind"
              checked={rewind}
              onCheckedChange={next => {
                if (selected === null) return
                setOverride({ generationId: selected.id, rewind: next })
              }}
            />
            <Label htmlFor="export-rewind">{t('editor.rewind.pingPong')}</Label>
          </div>
          <FieldDescription>
            {rewindIsRedundant(selected, rewind)
              ? t('export.rewind.alreadyLoops')
              : t('export.rewind.hint')}
          </FieldDescription>
        </Field>
      )}

      {!available && <InstallPrompt />}

      <div className="space-y-2">
        <Button
          className="w-full"
          disabled={blocked !== null || exporter.isPending}
          onClick={runExport}
        >
          {exporter.isPending ? t('export.working') : t('export.action')}
        </Button>

        {blocked !== null && <FieldDescription>{t(blocked)}</FieldDescription>}

        {!available && (
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            disabled={recheck.isPending}
            onClick={() => recheck.mutate()}
          >
            {t('export.checkAgain')}
          </Button>
        )}
      </div>
    </section>
  )
}

/**
 * One deliverable, disabled when this candidate cannot produce it.
 *
 * Disabled with the box still on screen rather than hidden, for PRD §10.1's
 * reason: a panel that dropped "MP4" on a still would look like a tool that
 * cannot make one at all.
 */
function FormatBox({
  deliverable,
  checked,
  disabled,
  onChange,
}: {
  deliverable: Deliverable
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  const { t } = useTranslation()
  const id = `export-format-${deliverable}`

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={next => {
          onChange(next === true)
        }}
      />
      <Label htmlFor={id} className={disabled ? 'opacity-60' : undefined}>
        {t(`export.format.${deliverable}`)}
      </Label>
    </div>
  )
}

/**
 * What to type, when there is no ffmpeg.
 *
 * The command in full rather than a link to a page about it: every user of this
 * app has a terminal open (PRD §8 — "an internal tool whose users are all
 * developers on Macs"), and one line they can paste is the shortest path from
 * here to a working export.
 */
function InstallPrompt() {
  const { t } = useTranslation()

  return (
    // The one genuine `Alert` in the app: a missing binary is a condition the
    // user has to act on, not help text under a control, and `Alert` renders the
    // `role="alert"` that says so.
    <Alert>
      <AlertDescription className="space-y-2">
        <p>{t('export.needsFfmpeg')}</p>
        {/* Left a step down: monospace at the same nominal size reads larger
            than the sentence above it, and the command has to fit one line. */}
        <code className="block font-mono text-xs select-all">
          {INSTALL_COMMAND}
        </code>
      </AlertDescription>
    </Alert>
  )
}
