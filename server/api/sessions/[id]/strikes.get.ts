// The session's strike log, { kernel, grid, strikes }: the same shape as a study run's.
export default defineEventHandler((event) => {
  const text = withSessions(store => store.strikeLogText(getRouterParam(event, 'id') ?? ''))
  setResponseHeader(event, 'content-type', 'application/json')
  return text
})
