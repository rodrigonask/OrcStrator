// One card, fetched once, for everyone who asked.
//
// A board event is heard by two listeners at once: the open project's board (PipelineContext)
// and the app-wide task list behind the sidebar badges and the all-projects board
// (useAllPipelineTasks). Each used to refetch its WHOLE list on every created/updated event, so
// one edit cost two full board downloads. Now each listener asks for the one card the event
// names, and concurrent asks for the same card share one request.

import { rest } from './rest'
import { shareInFlight } from '../utils/taskUpsert'

export { upsertTask } from '../utils/taskUpsert'

export const fetchTaskShared = shareInFlight((projectId, taskId) => rest.getTask(projectId, taskId))
