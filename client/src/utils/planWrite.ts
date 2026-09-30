// Is this Write call the agent saving a plan file (a path under `.claude/plans/`)?
//
// Asked on every render of every tool group and every live turn, and a Write's input carries
// the whole file it writes, often hundreds of KB. The check used to JSON.parse that payload
// each time just to read one field. A regex over the raw JSON text answers the same
// question without building the object: it finds the file_path value and looks inside it. It
// accepts the escaped slash form (`\/`) JSON allows, and a still-streaming input that has not
// reached file_path yet reads as "not a plan", as the parse failure did before.
const FILE_PATH_VALUE = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/

export function isPlanFileWrite(toolName: string, input: string | undefined): boolean {
  if (toolName !== 'Write' || !input) return false
  const m = FILE_PATH_VALUE.exec(input)
  if (!m) return false
  return m[1].replace(/\\\//g, '/').includes('.claude/plans/')
}
