// Hiding a project, the client half: no code path from the "Hide Project" button reaches the
// delete route. The server half (hide keeps every row) is folders-hide-delete.test.ts.
//
//   npx tsx server/test/hide-never-deletes.test.ts
//
// A source-level check, on purpose: the button, its handler, the api method and the
// route are four files, and the original bug was a handler in one of them quietly calling the
// wrong method in another. This reads each link of that chain and fails the moment any
// of them points at delete again.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, done } from './helpers/scratch-app.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

const folderGroup = read('client/src/components/FolderGroup.tsx')
const rest = read('client/src/api/rest.ts')
const routes = read('server/src/routes/folders.ts')

/** Every handler bound to a button whose visible text is "Hide Project". */
function hideButtonHandlers(src: string): string[] {
  const out: string[] = []
  const re = /<button\b[^>]*onClick=\{([^}]+)\}[^>]*>\s*Hide Project\s*<\/button>/g
  for (const m of src.matchAll(re)) out.push(m[1].trim())
  return out
}

/** The body of `const <name> = useCallback(` up to its dependency list. */
function handlerBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`)
  if (start < 0) return ''
  const end = src.indexOf('}, [', start)
  return src.slice(start, end < 0 ? undefined : end)
}

const handlers = hideButtonHandlers(folderGroup)
check('both Hide Project buttons are found (nested row and root row)', handlers.length === 2, JSON.stringify(handlers))
for (const h of new Set(handlers)) {
  const body = handlerBody(folderGroup, h)
  check(`Hide Project handler "${h}" exists`, body.length > 0)
  check(`Hide Project handler "${h}" calls hideFolder`, /\bhideFolder\(/.test(body))
  check(`Hide Project handler "${h}" never calls deleteFolder`, !/deleteFolder/.test(body))
  check(`Hide Project handler "${h}" never removes the folder from state`, !/REMOVE_FOLDER/.test(body))
}

const hideApi = /hideFolder:\s*\([^)]*\)\s*=>\s*([^\n]+)/.exec(rest)?.[1] ?? ''
check('api.hideFolder is a POST to /hide', /\bpost</.test(hideApi) && /\/hide`/.test(hideApi), hideApi)
check('api.hideFolder is not a DELETE', !/\bdel</.test(hideApi))

const delApi = /deleteFolder:\s*\(([^)]*)\)\s*=>\s*\n?\s*([^\n]+)/.exec(rest)
check('api.deleteFolder demands a confirmation argument', !!delApi && /confirm/i.test(delApi[1]) && /\?confirm=/.test(delApi[2]), delApi?.[0])

const hideRouteStart = routes.indexOf('const setHidden')
const hideRouteEnd = routes.indexOf("app.post('/folders/:id/unhide'")
const hideRoute = hideRouteStart >= 0 && hideRouteEnd > hideRouteStart ? routes.slice(hideRouteStart, hideRouteEnd) : ''
check('the hide route exists', hideRoute.length > 0)
check('the hide route runs no DELETE statement', hideRoute.length > 0 && !/DELETE/i.test(hideRoute))

done()
