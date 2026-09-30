// Where the Claude CLI keeps its files, and how it names a project's transcript folder.
//
// This used to be worked out in three places, three different ways. The worktree
// orphan check only turned colons, slashes and dots into dashes, while the CLI turns EVERY
// character that is not a letter or a digit into one. Any path with a +, _ or space (every
// harness worktree, "fix+audit-4") named a folder that does not exist, so the fast direct
// lookup missed and the close fell back to scanning every project folder. One encoder and one
// folder now, used everywhere.

import os from 'os'
import path from 'path'

/**
 * The CLI's own rule, verified against it: EVERY character that is not a letter or a digit
 * becomes a dash, with no collapsing of runs and no trimming. So D:\Work\orcstrator-v2 is
 * "D--Work-orcstrator-v2". Any "tidier" slug names a folder that does not exist.
 */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Claude's home folder: CLAUDE_CONFIG_DIR (the CLI's own override) or ~/.claude. Read on every call. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
}

/** The folder holding one sub-folder of transcripts per project. Read on every call. */
export function claudeProjectsDir(): string {
  return path.join(claudeDir(), 'projects')
}

/**
 * The same folder, fixed when the server starts. The process never changes its own home
 * folder or the CLI override while it runs, so modules that only need the value once can
 * use this instead of calling the function.
 */
export const CLAUDE_PROJECTS_DIR = claudeProjectsDir()
