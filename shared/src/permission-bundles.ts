/**
 * Permission bundles: plain-English grants, each expanding to the CLI rule patterns that
 * actually enforce it.
 *
 * WHY THESE SEVEN. Not guessed. An audit of permission refusals in real sessions showed
 * Git, file reads and the browser dominate, followed by changing files, running scripts,
 * GitHub and the internet, with deploys, installs and processes making up the rest. Most
 * refusals came from the auto-mode classifier rather than any rule anyone wrote.
 *
 * `deploy` is the seventh and was added after the first six shipped, because "run programs and
 * scripts" has to include npm and npx to be worth anything, and `Bash(npx:*)` matches
 * `npx wrangler deploy`. A grant labelled "run scripts" therefore carried the power to push to
 * production. See DEPLOY_FENCE for how that hole is closed.
 *
 * The finding that shaped the set: the two most-refused git subcommands were `git fetch` and
 * `git log`, tied, with `git status` and `git diff` close behind, and a large further share of
 * refusals were `cat`, `ls`, `grep`, `head` and `tail`. Roughly a third of the friction was an
 * agent being stopped from LOOKING at things, which cannot damage anything. Hence `read` is a
 * bundle of its own and is the one to turn on first.
 *
 * OrcStrator is for people who do not write code, so the label and description are the
 * product and the patterns are the implementation detail. Nobody should have to know what
 * `Bash(git push:*)` means to let their agent save work.
 */

export type PermissionBundleId = 'read' | 'git' | 'files' | 'run' | 'web' | 'browser' | 'deploy'

export interface PermissionBundle {
  id: PermissionBundleId
  /** UI label. No jargon: bundles exist precisely so nobody reads a glob pattern. */
  label: string
  /** One line under the label, same register. Says what it can do, not how. */
  description: string
  /**
   * True when nothing in the bundle can change, delete, spend or leak anything. Only `read`
   * qualifies. Drives the UI's "safe to leave on" grouping, and it is an honest line: every
   * other bundle can do something you might not want.
   */
  readOnly: boolean
  /** Rules this expands to, in the CLI's own syntax. */
  allow: string[]
}

export const PERMISSION_BUNDLES: PermissionBundle[] = [
  {
    id: 'read',
    label: 'Look at things',
    description: 'Read files, list folders, search text, and check what changed in Git. Cannot alter anything.',
    readOnly: true,
    allow: [
      'Read', 'Glob', 'Grep',
      'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(ls:*)', 'Bash(grep:*)', 'Bash(rg:*)',
      'Bash(find:*)', 'Bash(wc:*)', 'Bash(stat:*)', 'Bash(file:*)', 'Bash(tree:*)', 'Bash(du:*)',
      'Bash(diff:*)', 'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(cut:*)', 'Bash(tr:*)', 'Bash(echo:*)',
      'Bash(pwd)', 'Bash(which:*)', 'Bash(basename:*)', 'Bash(dirname:*)',
      // Read-only Git. `fetch` is here rather than in the Git bundle because it only updates
      // your copy of the remote's refs: it changes no file you are working on and nothing on
      // the remote, and it was the joint most-refused git subcommand in the audit.
      'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
      'Bash(git fetch:*)', 'Bash(git remote:*)', 'Bash(git rev-parse:*)', 'Bash(git merge-base:*)',
      'Bash(git ls-files:*)', 'Bash(git blame:*)', 'Bash(git describe:*)', 'Bash(git branch)',
      'Bash(git worktree list)', 'Bash(git stash list)', 'Bash(git reflog:*)',
      'PowerShell(Get-Content:*)', 'PowerShell(Get-ChildItem:*)', 'PowerShell(Select-String:*)',
      'PowerShell(Test-Path:*)', 'PowerShell(Get-Item:*)',
    ],
  },
  {
    id: 'git',
    label: 'Save and share work with Git',
    description: 'Commit, switch branches, push and pull, and open or merge pull requests on GitHub.',
    readOnly: false,
    allow: [
      'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git pull:*)',
      'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git branch:*)', 'Bash(git merge:*)',
      'Bash(git rebase:*)', 'Bash(git stash:*)', 'Bash(git restore:*)', 'Bash(git reset:*)',
      'Bash(git tag:*)', 'Bash(git worktree:*)', 'Bash(git clone:*)', 'Bash(git init:*)',
      'Bash(git rm:*)', 'Bash(git mv:*)', 'Bash(git cherry-pick:*)', 'Bash(git revert:*)',
      'Bash(git config:*)', 'Bash(git apply:*)',
      // gh is scoped to pull requests, issues and CI runs on purpose. `gh api` and
      // `gh repo delete` can do anything to any repo on the account, so they stay out of the
      // standard bundle and remain reachable by hand under Advanced.
      'Bash(gh pr:*)', 'Bash(gh issue:*)', 'Bash(gh run:*)', 'Bash(gh browse:*)',
      'Bash(gh repo view:*)', 'Bash(gh repo clone:*)', 'Bash(gh release view:*)',
      'Bash(gh auth status)',
    ],
  },
  {
    id: 'files',
    label: 'Create and change files',
    description: 'Write new files, edit existing ones, and rename, move or delete them.',
    readOnly: false,
    allow: [
      'Edit', 'Write', 'NotebookEdit',
      'Bash(mkdir:*)', 'Bash(touch:*)', 'Bash(mv:*)', 'Bash(cp:*)', 'Bash(rm:*)',
      'Bash(sed:*)', 'Bash(tee:*)', 'Bash(ln:*)', 'Bash(chmod:*)',
      'PowerShell(New-Item:*)', 'PowerShell(Set-Content:*)', 'PowerShell(Add-Content:*)',
      'PowerShell(Out-File:*)', 'PowerShell(Copy-Item:*)', 'PowerShell(Move-Item:*)',
      'PowerShell(Remove-Item:*)', 'PowerShell(Rename-Item:*)',
    ],
  },
  {
    id: 'run',
    label: 'Run programs and scripts',
    description: 'Run Node, Python, npm and the project\u2019s own build and test commands. Broad by nature: a script can do anything you could do yourself at a terminal.',
    readOnly: false,
    allow: [
      'Bash(node:*)', 'Bash(python:*)', 'Bash(python3:*)', 'Bash(npm:*)', 'Bash(npx:*)',
      'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(tsx:*)', 'Bash(bash:*)', 'Bash(sh:*)',
      'Bash(make:*)', 'Bash(pip:*)', 'Bash(cargo:*)', 'Bash(go:*)', 'Bash(dotnet:*)',
      'Bash(ffmpeg:*)', 'Bash(ffprobe:*)',
      // The bare tool name allows every PowerShell command. That is the honest shape of this
      // bundle: it is already arbitrary code execution via node and python, and pretending
      // otherwise by listing cmdlets would be theatre.
      'PowerShell',
    ],
  },
  {
    id: 'web',
    label: 'Use the internet',
    description: 'Fetch web pages, call APIs, and search the web.',
    readOnly: false,
    allow: [
      'WebFetch', 'WebSearch',
      'Bash(curl:*)', 'Bash(wget:*)',
      'PowerShell(Invoke-WebRequest:*)', 'PowerShell(Invoke-RestMethod:*)',
    ],
  },
  {
    id: 'browser',
    label: 'Control the browser',
    description: 'Open pages, click, type and read the screen in your own Chrome, through Playwriter.',
    readOnly: false,
    allow: ['mcp__playwriter__execute', 'mcp__playwriter__reset'],
  },
  {
    id: 'deploy',
    label: 'Deploy to live sites and servers',
    description: 'Push changes to Cloudflare, Vercel, Supabase and the like, where real people see them immediately. Off unless you turn it on.',
    readOnly: false,
    allow: [
      'Bash(wrangler:*)', 'Bash(npx wrangler:*)',
      'Bash(vercel:*)', 'Bash(npx vercel:*)',
      'Bash(supabase:*)', 'Bash(npx supabase:*)',
      'Bash(netlify:*)', 'Bash(flyctl:*)', 'Bash(fly:*)',
      'Bash(aws:*)', 'Bash(gcloud:*)', 'Bash(az:*)',
      'Bash(docker:*)',
      'Bash(npm run deploy:*)', 'Bash(npm run release:*)',
    ],
  },
]

/**
 * Branch names that are somebody's trunk.
 *
 * Deleting one of these on the remote is the failure the fence exists to stop. Deleting a
 * MERGED FEATURE BRANCH is not: every commit is already in the trunk, the ref is the only
 * thing that goes, and it is the most common piece of cleanup there is. The fence used to
 * deny every `--delete` and could not tell the two apart, so a chat that had been granted
 * everything still could not tidy up after itself, and each extra grant made it look more
 * broken rather than less.
 *
 * `dev` is deliberately absent: it is a trunk in some repos and the prefix of an ordinary
 * feature branch in many more, and blocking `dev-whatever` is the exact mistake this list
 * exists to undo. `develop` is unambiguous enough to keep.
 */
export const PROTECTED_BRANCHES: string[] = ['main', 'master', 'beta', 'staging', 'production', 'prod', 'develop']

/**
 * Every spelling of "delete this branch on the remote", for one branch name.
 *
 * The space before the name is load-bearing twice over. It keeps the rule off a branch called
 * `fix-main-thing`, and it matches both argument orders, `--delete` before the remote and
 * after it. The colon form keeps its space for the original reason: `git push origin :main`
 * deletes main, and `git push origin HEAD:main` does not.
 */
function remoteDeletionRules(branch: string): string[] {
  return [
    `Bash(git push*--delete* ${branch}*)`,
    `Bash(git push* -d* ${branch}*)`,
    `Bash(git push* :${branch}*)`,
  ]
}

/**
 * The git half of the fence: rewriting history that is already pushed, and deleting a trunk
 * branch. Exported so the "recommended git rules" preset in the UI can BE this list instead
 * of holding a copy of it. The copy is what drifted, and once the two disagreed nobody could
 * tell which one had bitten.
 */
export const GIT_HISTORY_FENCE: string[] = [
  'Bash(git push*--force*)',
  'Bash(git push*--force-with-lease*)',
  'Bash(git push* -f)',
  'Bash(git push* -f *)',
  ...PROTECTED_BRANCHES.flatMap(remoteDeletionRules),
]

/**
 * Deny rules for "everything except destructive". Deliberately short and precise rather than
 * a broad sweep, because a deny is a glob over a command string, not an understanding of what
 * the command does: a long list of half-right patterns reads as safety while blocking ordinary
 * work and still missing the exotic spelling.
 *
 * What it covers, and the UI says exactly this: rewriting or deleting history that is already
 * pushed, and deleting the folders an operating system needs. Nothing else.
 */
export const DESTRUCTIVE_FENCE: string[] = [
  ...GIT_HISTORY_FENCE,
  'Bash(rm -rf /)',
  'Bash(rm*-rf*/c/Windows*)',
  'Bash(rm*-rf*/c/Program Files*)',
  'PowerShell(Remove-Item*C:\\Windows*)',
  'PowerShell(Remove-Item*C:\\Program Files*)',
]

/**
 * ASK rules installed when some grants are on but `deploy` is NOT one of them.
 *
 * Without this the deploy toggle would be decorative. "Run programs and scripts" has to
 * include `npm` and `npx` to be useful at all, and `Bash(npx:*)` matches `npx wrangler deploy`
 * and `Bash(npm:*)` matches `npm run deploy`. So a toggle labelled "run scripts" would quietly
 * carry the power to push to production, which is exactly the kind of "the button does more
 * than it says" that this whole screen exists to stop.
 *
 * ASK RATHER THAN DENY. These were once deny rules, and a deny was the wrong
 * instrument: the CLI handed the agent "Permission to use Bash ... has been denied", the agent
 * narrated a workaround and carried on, and the operator's grant then landed as a NEW turn on
 * a deploy that had already been attempted another way or abandoned. An ask stops the turn
 * dead, raises the Allow/Deny banner, and on Allow runs the original command unchanged.
 * Production is gated by hand anyway, so "by hand" now means one click at the moment it
 * matters instead of a refusal that gets routed around.
 *
 * An ask beats an allow, so listing the deploy spellings here plugs that hole precisely while
 * leaving the rest of npm and npx alone. Turning the deploy grant on removes these, which is
 * what makes "Allow everything" mean everything.
 *
 * A deny for the same command would BEAT this (measured, CLI 2.1.263), so these patterns must
 * never also appear in a deny list or the gate silently reverts to the old refusal.
 *
 * Every entry has a PowerShell twin, because the `run` bundle grants bare `PowerShell` and a
 * fence with only Bash spellings is a fence with a gate in it. A chat refused
 * `npm run deploy:beta` in Bash simply re-ran it through PowerShell three seconds later and it
 * went straight through. The refusal did not stop the
 * deploy, it picked the shell.
 */
export const DEPLOY_FENCE: string[] = [
  'Bash(*wrangler deploy*)',
  'Bash(*wrangler publish*)',
  'Bash(*vercel deploy*)',
  'Bash(*vercel --prod*)',
  'Bash(*supabase functions deploy*)',
  'Bash(*supabase db push*)',
  'Bash(*netlify deploy*)',
  'Bash(npm run deploy*)',
  'Bash(npm run release*)',
  'Bash(*flyctl deploy*)',
  'PowerShell(*wrangler deploy*)',
  'PowerShell(*wrangler publish*)',
  'PowerShell(*vercel deploy*)',
  'PowerShell(*vercel --prod*)',
  'PowerShell(*supabase functions deploy*)',
  'PowerShell(*supabase db push*)',
  'PowerShell(*netlify deploy*)',
  'PowerShell(npm run deploy*)',
  'PowerShell(npm run release*)',
  'PowerShell(*flyctl deploy*)',
]

/** Every bundle id. Used by "Allow everything", which includes deploying. */
export const ALL_BUNDLE_IDS: PermissionBundleId[] = PERMISSION_BUNDLES.map(b => b.id)

/**
 * Everything except deploying. Used by "Allow everything except destructive".
 *
 * Deploying is left out because a bad deploy is the one action on this list that other people
 * see immediately and that no local undo reaches. Production is already gated by hand,
 * so putting it in the safe button would have contradicted how production is actually run.
 */
export const SAFE_BUNDLE_IDS: PermissionBundleId[] = PERMISSION_BUNDLES
  .filter(b => b.id !== 'deploy')
  .map(b => b.id)

/**
 * Expand a set of bundle ids to allow rules, de-duplicated and order-stable.
 * Unknown ids are ignored rather than throwing: a bundle removed in a later version must
 * not stop a chat from spawning.
 */
export function expandBundles(ids: readonly string[] | undefined): string[] {
  if (!ids?.length) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const bundle of PERMISSION_BUNDLES) {
    if (!ids.includes(bundle.id)) continue
    for (const rule of bundle.allow) {
      if (seen.has(rule)) continue
      seen.add(rule)
      out.push(rule)
    }
  }
  return out
}

/** Bundle lookup by id, for labels in the UI. */
export function findBundle(id: string): PermissionBundle | undefined {
  return PERMISSION_BUNDLES.find(b => b.id === id)
}
