/**
 * The editor's session state.
 *
 * Zustand holds it because three panels that are siblings in the layout all
 * need it (PRD §10), but the transitions themselves live in the pure reducer
 * in `lib/recipe` — the store is a subscription mechanism, not a place for
 * logic. When #23 makes projects persistent, TanStack Query takes over loading
 * and this shrinks to the unsaved edit in front of you.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import {
  createEditorReducer,
  FIXTURE_REGISTRY,
  initialEditorState,
  type EditorAction,
  type EditorState,
} from '@/lib/recipe'

const reduce = createEditorReducer(FIXTURE_REGISTRY)

interface EditorStore {
  /**
   * One object rather than spread fields, so a selector for it is
   * referentially stable and components can derive freely without memoising.
   */
  state: EditorState
  dispatch: (action: EditorAction) => void
  reset: () => void
}

export const useEditorStore = create<EditorStore>()(
  devtools(
    set => ({
      state: initialEditorState(),

      dispatch: action =>
        set(
          store => ({ state: reduce(store.state, action) }),
          undefined,
          action.type
        ),

      reset: () => set({ state: initialEditorState() }, undefined, 'reset'),
    }),
    { name: 'editor-store' }
  )
)
