import type { CanvasDag } from '@renderer/utils/cocoSessionCanvas'
import { emptyCanvasDag } from '@renderer/utils/cocoSessionCanvas'
import { useCallback, useMemo, useReducer } from 'react'

const HISTORY_LIMIT = 50

interface HistoryState {
  past: CanvasDag[]
  present: CanvasDag
  future: CanvasDag[]
}

export type CanvasGraphUpdate = CanvasDag | ((current: CanvasDag) => CanvasDag)

type HistoryAction =
  | { type: 'commit'; update: CanvasGraphUpdate }
  | { type: 'redo' }
  | { type: 'reset'; graph: CanvasDag }
  | { type: 'undo' }

function applyUpdate(current: CanvasDag, update: CanvasGraphUpdate): CanvasDag {
  return typeof update === 'function' ? update(current) : update
}

function reducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'reset':
      return { future: [], past: [], present: action.graph }
    case 'commit': {
      const next = applyUpdate(state.present, action.update)
      if (next === state.present || JSON.stringify(next) === JSON.stringify(state.present)) return state
      return {
        future: [],
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next
      }
    }
    case 'undo': {
      const previous = state.past.at(-1)
      if (!previous) return state
      return {
        future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
        past: state.past.slice(0, -1),
        present: previous
      }
    }
    case 'redo': {
      const [next, ...rest] = state.future
      if (!next) return state
      return {
        future: rest,
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next
      }
    }
  }
}

export interface CanvasHistory {
  canRedo: boolean
  canUndo: boolean
  /** Records a new revision; an identical graph is ignored. */
  commit: (update: CanvasGraphUpdate) => void
  graph: CanvasDag
  redo: () => void
  /** Replaces the graph and clears history, for loads and session switches. */
  reset: (graph: CanvasDag) => void
  undo: () => void
}

export function useCanvasHistory(): CanvasHistory {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    future: [],
    past: [],
    present: emptyCanvasDag()
  }))

  const commit = useCallback((update: CanvasGraphUpdate) => dispatch({ type: 'commit', update }), [])
  const reset = useCallback((graph: CanvasDag) => dispatch({ graph, type: 'reset' }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])

  return useMemo(
    () => ({
      canRedo: state.future.length > 0,
      canUndo: state.past.length > 0,
      commit,
      graph: state.present,
      redo,
      reset,
      undo
    }),
    [commit, redo, reset, state.future.length, state.past.length, state.present, undo]
  )
}
