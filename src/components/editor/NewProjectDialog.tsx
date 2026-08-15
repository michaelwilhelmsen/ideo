/**
 * Creating a project — a name and a ratio, and the ratio is the decision.
 *
 * PRD §4.4: the aspect ratio is locked here and inherited by every stage,
 * chosen from a curated list, with each entry marked for whether animation is
 * possible at it. The mark is on screen at the moment of choosing rather than
 * discovered at the animate stage, because by then the source and style have
 * been paid for at a ratio no video model will take.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ASPECTS, DEFAULT_ASPECT, type AspectId } from '@/lib/recipe'
import { newProject, useCreateProject } from '@/services/projects'

export function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const create = useCreateProject()

  const [name, setName] = useState('')
  const [aspect, setAspect] = useState<AspectId>(DEFAULT_ASPECT)

  const trimmed = name.trim()

  const submit = () => {
    if (trimmed === '') return

    create.mutate(newProject(trimmed, aspect), {
      onSuccess: () => {
        setName('')
        setAspect(DEFAULT_ASPECT)
        onOpenChange(false)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editor.newProject.title')}</DialogTitle>
          <DialogDescription>
            {t('editor.newProject.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="new-project-name">
              {t('editor.newProject.name')}
            </FieldLabel>
            <Input
              id="new-project-name"
              autoFocus
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submit()
              }}
              placeholder={t('editor.newProject.namePlaceholder')}
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">
              {t('editor.newProject.aspect')}
            </FieldLegend>
            <FieldDescription>
              {t('editor.newProject.aspectLocked')}
            </FieldDescription>

            <div className="grid grid-cols-2 gap-2">
              {ASPECTS.map(candidate => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={candidate.id === aspect}
                  onClick={() => setAspect(candidate.id)}
                  className={cn(
                    'flex cursor-pointer flex-col gap-2 rounded-md border p-3 text-start transition-colors hover:bg-accent',
                    candidate.id === aspect
                      ? 'border-primary bg-accent/50'
                      : 'border-border'
                  )}
                >
                  <span className="flex items-center gap-2">
                    {/* Sized off the long edge rather than off the height, so
                        the portrait entries read as portrait: at a fixed
                        height, 9:16 would be a 9px sliver next to a 37px
                        21:9 and the two would look like the same decision. */}
                    <span
                      aria-hidden
                      className="shrink-0 rounded-xs border border-current opacity-60"
                      style={{
                        width: `${Math.min(1, candidate.ratio) * 24}px`,
                        height: `${Math.min(1, 1 / candidate.ratio) * 24}px`,
                      }}
                    />
                    <span className="text-sm font-medium">{candidate.id}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(candidate.noteKey)}
                  </span>
                </button>
              ))}
            </div>
          </FieldSet>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('editor.action.cancel')}
          </Button>
          <Button
            onClick={submit}
            disabled={trimmed === '' || create.isPending}
          >
            {t('editor.action.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
