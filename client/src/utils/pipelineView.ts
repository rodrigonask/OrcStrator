// Sentinel project id for the all-projects board.
//
// activePipelineId is `string | null`, and null already means "nothing chosen yet, fall
// back to the first folder". So the global board needs its own value rather than reusing
// null. It round-trips through the ?pipeline= URL param like any other id, which makes the
// global board bookmarkable.
export const ALL_PROJECTS_ID = '__all__'

export function isAllProjects(id: string | null | undefined): boolean {
  return id === ALL_PROJECTS_ID
}
