// One cross-project task fetch for the whole app.
//
// Two consumers need every project's tasks at once: the all-projects board and the
// sidebar pending badges. Calling useAllPipelineTasks() in both would mean two fetches of
// the same endpoint and two WebSocket subscriptions kept permanently in sync with each
// other, which is exactly the kind of background syncing this app avoids. The
// provider mounts the hook once, above both.

import { createContext, useContext } from 'react'
import { useAllPipelineTasks } from '../hooks/useAllPipelineTasks'
import type { AllPipelineData } from '../hooks/useAllPipelineTasks'

const EMPTY: AllPipelineData = {
  byProject: {},
  allTasks: [],
  pendingByProject: {},
  loading: true,
  error: null,
  moveTask: async () => {},
  refetch: () => {},
}

const AllTasksContext = createContext<AllPipelineData>(EMPTY)

export function AllTasksProvider({ children }: { children: React.ReactNode }) {
  const value = useAllPipelineTasks()
  return <AllTasksContext.Provider value={value}>{children}</AllTasksContext.Provider>
}

export function useAllTasks(): AllPipelineData {
  return useContext(AllTasksContext)
}
