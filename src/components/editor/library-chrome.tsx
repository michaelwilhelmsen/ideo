/**
 * The two pieces of chrome every forkable library needs, and none of them owns.
 *
 * There are four libraries now — source, style and motion presets (#28, #29,
 * #47) and palettes (#49) — and each keeps its own service, its own schema and
 * its own picker, deliberately: what they share is a *storage* shape, and the
 * services say at length why folding them into one parameterised hook would be
 * a trade the wrong way round.
 *
 * These two are the exception, and the reason is that neither is about a
 * library at all. "Confirm before deleting a file the user made" and "say so
 * when a file could not be read" are the same question asked about the same
 * kind of thing, and the argument for keeping the services apart — that the
 * four have different reasons to change — does not apply: a confirmation
 * dialog changes when confirmations change.
 *
 * What differs between callers is the wording and which mutation runs, so both
 * are passed in: the keys rather than the strings, so the vocabulary stays with
 * the caller that owns it and the `t()` stays here.
 */

import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { FieldError } from '@/components/ui/field'

/**
 * What deleting needs to know: which file, and what to call it.
 *
 * Structural rather than a union of the four saved shapes, because the
 * confirmation genuinely does not care which library it is emptying — widening
 * it would be claiming a difference the dialog does not have.
 */
export interface DeletableEntry {
  readonly id: string
  readonly name: string
}

/**
 * Confirming a delete.
 *
 * `null` renders nothing at all rather than a hidden dialog: "which entry is
 * doomed" and "is the dialog open" are one fact, and keeping them as one is
 * what stops a confirmation from firing at something that is no longer
 * selected.
 */
export function ConfirmDeleteDialog({
  entry,
  titleKey,
  descriptionKey,
  confirmKey,
  onClose,
  onDelete,
}: {
  entry: DeletableEntry | null
  /** Interpolated with `name`. */
  titleKey: string
  descriptionKey: string
  confirmKey: string
  onClose: () => void
  onDelete: (entry: DeletableEntry) => void
}) {
  const { t } = useTranslation()

  return (
    <AlertDialog
      open={entry !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {/* A name is user data (PRD §6); the sentence around it is ours. */}
            {t(titleKey, { name: entry?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t(descriptionKey)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('editor.action.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (entry === null) return
              onDelete(entry)
            }}
          >
            {t(confirmKey)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Files in a library folder that could not be read back.
 *
 * Said rather than swallowed: a picker showing fewer entries than the user
 * saved looks like data loss, and one line saying some files could not be read
 * is the difference between a bug report and a hand-edit somebody can go and
 * fix.
 */
export function UnreadableNotice({
  count,
  messageKey,
}: {
  count: number
  messageKey: string
}) {
  const { t } = useTranslation()

  // `FieldError` renders nothing for empty children, so the count could be left
  // to it — but a zero here is not an error with no text, it is the normal case,
  // and saying so is clearer than relying on that.
  if (count === 0) return null

  return <FieldError>{t(messageKey)}</FieldError>
}
