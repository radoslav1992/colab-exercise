/**
 * The server for the end-to-end tests: the build folder served the way Cloudflare serves it (the
 * rules of public/_headers, so the tests run under the real Content-Security-Policy; /course is
 * course.html; 404.html for everything else) and, unless `api` is false, the real API on SQLite in
 * memory. The pieces are the project's own: server/static.ts and server/server.ts.
 */
export { parseHeaders } from '../../server/static.ts'

export async function startServer({ root, headersFile, port = 0, extraFiles = {}, api = true, ...config }) {
  const site = { root, headersFile, extraFiles }
  if (api) {
    const { startServer: start } = await import('../../server/server.ts')
    return start({ port, databasePath: ':memory:', site, ...config })
  }
  // A static site without an API, like `vite preview` or any plain file host.
  const { createServer } = await import('node:http')
  const { createStatic } = await import('../../server/static.ts')
  const files = createStatic(site)
  const server = createServer((request, response) => {
    const answer = files(new URL(request.url, 'http://localhost').pathname)
    response.writeHead(answer.status, answer.headers)
    response.end(answer.body)
  })
  await new Promise((done) => server.listen(port, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }
}
