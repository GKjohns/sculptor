// One run's strike log: { kernel, grid, strikes }. A megabyte or two, sent as written.
export default defineEventHandler((event) => {
  const text = studyStrikeLogText(studyRunDir(getRouterParam(event, 'id')))
  setResponseHeader(event, 'content-type', 'application/json')
  return text
})
