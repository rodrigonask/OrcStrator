// Unit check: stream-parser turns a real can_use_tool control_request (shape captured
// from the real CLI's permission protocol) into a permission-request ClaudeStreamEvent.
import { createStreamParser } from '../server/src/services/stream-parser.ts'

const parse = createStreamParser('inst-abc12345')
const line = JSON.stringify({
  type: 'control_request',
  request_id: 'req-test-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'mkdir x', description: 'd' },
    description: 'd',
    tool_use_id: 'toolu_x',
    permission_suggestions: [],
    blocked_path: 'C:\\x',
  },
})

const out: any = parse(line)
console.log('PARSER OUTPUT:\n', JSON.stringify(out, null, 2))

const ok =
  out && out.type === 'permission-request' &&
  out.requestId === 'req-test-1' &&
  out.toolName === 'Bash' &&
  out.displayName === 'Bash' &&
  out.toolUseId === 'toolu_x' &&
  out.input && out.input.command === 'mkdir x'

// Also confirm a non-permission control_request is ignored (returns null), not surfaced as cli-prompt.
const other: any = parse(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'initialize' } }))
const otherOk = other === null

console.log(`\npermission mapping: ${ok ? 'PASS' : 'FAIL'}`)
console.log(`non-permission ignored: ${otherOk ? 'PASS' : 'FAIL'}`)
process.exit(ok && otherOk ? 0 : 1)
