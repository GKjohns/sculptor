// Finished study runs, newest first, for the replay picker.
import type { ReplayRun } from '#shared/agent/replay'

export default defineEventHandler((): ReplayRun[] => {
  return studyRunIds()
    .map(studyRun)
    .filter(run => run !== null)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
})
