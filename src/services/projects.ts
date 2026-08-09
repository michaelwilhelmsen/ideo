/**
 * The project library — listing, opening, saving and deleting what is on disk.
 *
 * Two layers meet here on purpose. TanStack Query owns the *list* and the
 * on-disk facts about it (summaries, size), which is exactly the persistent
 * data it is for. Zustand owns the *open* project, because that is a live
 * document being edited many times a second and a query cache is the wrong
 * shape for it (`docs/developer/state-management.md`).
 *
 * `useProjectLibrary` is the seam between them: it loads on mount and saves
 * what the reducer produces, so no component ever has to remember to persist.
 */

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import i18n from '@/i18n/config'
import { logger } from '@/lib/logger'
import {
  DEFAULT_IMAGE_BATCH,
  DEFAULT_MODEL_IDS,
  DEFAULT_VIDEO_BATCH,
  readManifest,
  writeManifest,
  type AspectId,
  type Project,
  type ProjectSummary,
  type StageRecipe,
} from '@/lib/recipe'
import {
  commands,
  type JsonValue,
  type ProjectUsage,
} from '@/lib/tauri-bindings'
import { useEditorStore } from '@/store/editor-store'

/**
 * How long editing pauses before the manifest is written.
 *
 * Long enough that typing a prompt is one write rather than forty; short
 * enough that "I closed the lid" is not a lost recipe. Every write is atomic
 * (PRD §3.2), so the worst a badly timed quit costs is the last few hundred
 * milliseconds of typing.
 */
const AUTOSAVE_DELAY_MS = 600

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  usage: (id: string) => [...projectKeys.all, id, 'usage'] as const,
}

/** The project list, as the index holds it. */
export function useProjects() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: async (): Promise<readonly ProjectSummary[]> => {
      const result = await commands.listProjects()
      if (result.status === 'error') {
        logger.error('Could not list projects', { error: result.error })
        throw new Error(result.error)
      }
      return result.data
    },
  })
}

/** What one project costs on disk, and how much of that is unreferenced. */
export function useProjectUsage(projectId: string | null) {
  return useQuery({
    queryKey: projectKeys.usage(projectId ?? ''),
    enabled: projectId !== null,
    queryFn: async (): Promise<ProjectUsage> => {
      const result = await commands.projectUsage(projectId ?? '')
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
  })
}

/** Reads a manifest off disk and validates it into a project. */
export async function openProjectById(
  projectId: string
): Promise<{ project: Project; directory: string }> {
  const result = await commands.loadProject(projectId)
  if (result.status === 'error') {
    logger.error('Could not load project', {
      projectId,
      error: result.error,
    })
    throw new Error(result.error)
  }

  return {
    project: readManifest(result.data.manifest),
    directory: result.data.directory,
  }
}

/**
 * Writes a project to disk. Also the create path — see `save_project`.
 *
 * Returns the summary Rust just filed, which is where the project's folder
 * comes from: the manifest deliberately does not say where it lives.
 */
export async function saveProject(project: Project): Promise<ProjectSummary> {
  const result = await commands.saveProject(
    writeManifest(project, Date.now()) as unknown as JsonValue
  )

  if (result.status === 'error') {
    logger.error('Could not save project', {
      projectId: project.id,
      error: result.error,
    })
    throw new Error(result.error)
  }

  return result.data
}

export function useCreateProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (project: Project) => ({
      project,
      summary: await saveProject(project),
    }),
    onSuccess: async ({ project, summary }) => {
      await queryClient.invalidateQueries({ queryKey: projectKeys.list() })
      useEditorStore.getState().dispatch({
        type: 'openProject',
        project,
        directory: summary.directory,
      })
    },
    onError: error => report('editor.error.create', error),
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string) => {
      const result = await commands.deleteProject(projectId)
      if (result.status === 'error') throw new Error(result.error)
      return projectId
    },
    onSuccess: async projectId => {
      const { state, dispatch } = useEditorStore.getState()
      if (state.project?.id === projectId) dispatch({ type: 'closeProject' })
      await queryClient.invalidateQueries({ queryKey: projectKeys.list() })
    },
    onError: error => report('editor.error.delete', error),
  })
}

/** PRD §10.3 — the deliberate cleanup, never an automatic one. */
export function useCleanupAssets() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (projectId: string) => {
      // Cleanup asks the manifest on disk what is referenced, and the open
      // project's manifest may be up to one debounce behind. Flushing first
      // is what stops a file whose candidate is still in flight from looking
      // like an orphan — the one way this action could delete something paid
      // for.
      const open = useEditorStore.getState().state.project
      if (open?.id === projectId) await saveProject(open)

      const result = await commands.cleanupUnusedAssets(projectId)
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    onSuccess: async (outcome, projectId) => {
      await queryClient.invalidateQueries({
        queryKey: projectKeys.usage(projectId),
      })
      logger.info('Cleaned up unused assets', { projectId, outcome })
    },
    onError: error => report('editor.error.cleanUp', error),
  })
}

/**
 * Says what went wrong, and keeps the technical part out of it.
 *
 * `docs/developer/error-handling.md` — the log gets the path and the serde
 * message, the user gets a sentence. Non-React context, so `i18n.t` directly
 * rather than the hook (`docs/developer/i18n-patterns.md`).
 */
function report(messageKey: string, error: unknown): void {
  logger.error(messageKey, { error })
  toast.error(i18n.t(messageKey))
}

/**
 * Keeps the editor and the disk in agreement.
 *
 * Mount it once, high up. It pushes the project list into the store, opens
 * something when nothing is open, and writes the open project back after every
 * pause in editing.
 */
export function useProjectLibrary(): void {
  const queryClient = useQueryClient()
  const { data: summaries } = useProjects()
  const project = useEditorStore(store => store.state.project)
  const dispatch = useEditorStore(store => store.dispatch)

  /**
   * The last version that agrees with disk. Compared by reference, which is
   * exactly right for an immutable reducer: a project that came *from* disk is
   * the same object until something edits it, and an edit always makes a new
   * one.
   */
  const persisted = useRef<Project | null>(null)

  // The list, and an opening move when there is nothing open.
  useEffect(() => {
    if (summaries === undefined) return
    dispatch({ type: 'setSummaries', summaries })

    const { state } = useEditorStore.getState()
    if (state.project !== null) return

    const first = summaries.at(0)
    if (first === undefined) return

    openProjectById(first.id)
      .then(({ project: loaded, directory }) => {
        persisted.current = loaded
        dispatch({ type: 'openProject', project: loaded, directory })
      })
      .catch((error: unknown) => {
        logger.warn('Could not open the most recent project', { error })
      })
  }, [summaries, dispatch])

  // Autosave. Debounced, because a keystroke is not a save point.
  useEffect(() => {
    if (project === null) return
    if (project === persisted.current) return

    const timer = setTimeout(() => {
      const current = useEditorStore.getState().state.project
      if (current === null) return

      persisted.current = current
      saveProject(current)
        .then(async () => {
          // A save is the only thing that changes what the project costs —
          // a new candidate brought a file with it. Without this the footer
          // keeps reporting the size it had when the project was opened.
          await queryClient.invalidateQueries({
            queryKey: projectKeys.usage(current.id),
          })
        })
        .catch((error: unknown) => {
          // Persisted has already moved on, so a failure here would go
          // unnoticed until the next edit — say so instead, and let the next
          // edit try again.
          persisted.current = null
          report('editor.error.save', error)
        })
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [project, queryClient])
}

/** Opens a project by id, replacing whatever is open. */
export function useOpenProject() {
  const dispatch = useEditorStore(store => store.dispatch)

  return (projectId: string) => {
    openProjectById(projectId)
      .then(({ project, directory }) => {
        dispatch({ type: 'openProject', project, directory })
      })
      .catch((error: unknown) => report('editor.error.open', error))
  }
}

/**
 * A project with nothing in it yet, ready to be saved.
 *
 * The starting drafts are *copied* in rather than referenced, per PRD §11:
 * changing a default later must not reach back into projects that already
 * exist.
 */
export function newProject(name: string, aspect: AspectId): Project {
  const blank = (modelId: string): StageRecipe => ({
    modelId,
    prompt: '',
    presetId: null,
    seed: { mode: 'roll' },
    params: {},
    options: {},
    inputGenerationId: null,
  })

  return {
    id: crypto.randomUUID(),
    name,
    aspect,
    createdAt: Date.now(),
    // Copied, not referenced (PRD §11): raising the default later must not
    // make an existing project's next click cost four times as much.
    imageBatchSize: DEFAULT_IMAGE_BATCH,
    videoBatchSize: DEFAULT_VIDEO_BATCH,
    drafts: {
      // From the registry (#25), not written out here: a draft naming a model
      // with no capability entry is a recipe nothing can build a request for,
      // and `modelById` would refuse it on the next render.
      source: blank(DEFAULT_MODEL_IDS.source),
      style: blank(DEFAULT_MODEL_IDS.style),
      animate: blank(DEFAULT_MODEL_IDS.animate),
    },
    generations: [],
    selection: { source: null, style: null, animate: null },
  }
}
