import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Read Claude Code session JSONL files from ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * Returns the last assistant message content from the session.
 */
export function getLastAssistantMessage(cwd: string, sessionId: string): string | null {
  // Claude Code encodes the cwd as the directory name under ~/.claude/projects/
  // The encoding replaces path separators with hyphens and removes drive letters on Windows
  const encodedCwd = encodeCwd(cwd)
  const claudeDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd)
  const sessionFile = path.join(claudeDir, `${sessionId}.jsonl`)

  if (!fs.existsSync(sessionFile)) {
    return null
  }

  try {
    const content = fs.readFileSync(sessionFile, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)

    // Find last line with role=assistant
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>
        if (entry.role === 'assistant') {
          // Content can be string or array of content blocks
          const msgContent = entry.content
          if (typeof msgContent === 'string') {
            return msgContent
          }
          if (Array.isArray(msgContent)) {
            // Extract text from content blocks
            const textParts: string[] = []
            for (const block of msgContent) {
              if (typeof block === 'string') {
                textParts.push(block)
              } else if (block && typeof block === 'object' && 'text' in block) {
                textParts.push((block as { text: string }).text)
              }
            }
            return textParts.join('\n') || null
          }
          return null
        }
      } catch {
        continue
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Encode a cwd path the same way Claude Code does for its project directories.
 * Converts path to a safe directory name.
 */
function encodeCwd(cwd: string): string {
  // Claude Code uses a URL-safe encoding of the absolute path
  // On Windows: C:\Users\foo\project -> C-Users-foo-project
  // On Unix: /home/foo/project -> -home-foo-project
  let encoded = cwd
    .replace(/[:\\\/]/g, '-')  // Replace path separators and colons with dashes
    .replace(/^-+/, '')         // Remove leading dashes
    .replace(/-+/g, '-')        // Collapse multiple dashes

  return encoded
}
