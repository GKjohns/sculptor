// The saved reference sheet as a PNG, or 404 if the session has none.
export default defineEventHandler((event) => {
  const png = withSessions(store => store.referencePng(getRouterParam(event, 'id') ?? ''))
  if (!png) throw createError({ statusCode: 404, message: 'this session has no reference sheet' })
  setResponseHeader(event, 'content-type', 'image/png')
  return png
})
