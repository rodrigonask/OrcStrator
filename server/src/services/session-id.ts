// A Claude session id is a UUID, and it ends up in file paths (<id>.jsonl) that the sanitizer
// and the secret scrubber REWRITE. So an id is checked where it is stored and again where a
// path is built from it: "..\..\Users\Public\victim" must never become a path.

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}
