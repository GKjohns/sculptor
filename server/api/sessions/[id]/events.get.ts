// Whatever the studio logged for itself as the commission ran, in order, as one JSON array.
export default defineEventHandler((event) => {
  const text = withSessions(store => store.eventsText(getRouterParam(event, 'id') ?? ''))
  setResponseHeader(event, 'content-type', 'application/json')
  return text
})
