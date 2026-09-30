/**
 * Permission bundles: plain-English grants, each expanding to the CLI rule patterns that
 * actually enforce it.
 *
 * WHY THESE SEVEN. Not guessed. A review of permission refusals in real sessions showed
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
  /**
   * ASK rules that ride with the bundle. A prefix allow like `Bash(git diff:*)` also
   * allows `git diff --output=package.json`, which overwrites a file, and the CLI has no way to
   * say "this prefix, minus that flag". An ask beats an allow, so these few spellings stop and
   * wait for a click instead of running, while the everyday forms stay silent.
   */
  ask?: string[]
  /** One line shown under the bundle when the chat runs in Auto mode, where it behaves differently. */
  autoModeNote?: string
}

export const PERMISSION_BUNDLES: PermissionBundle[] = [
  {
    id: 'read',
    label: 'Look at things',
    description: 'Read files, list folders, search text, and check what changed in Git. The few spellings of these that could write a file or run a program ask you first.',
    readOnly: true,
    allow: [
      'Read', 'Glob', 'Grep',
      'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(ls:*)', 'Bash(grep:*)', 'Bash(rg:*)',
      'Bash(find:*)', 'Bash(wc:*)', 'Bash(stat:*)', 'Bash(file:*)', 'Bash(tree:*)', 'Bash(du:*)',
      'Bash(diff:*)', 'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(cut:*)', 'Bash(tr:*)', 'Bash(echo:*)',
      'Bash(pwd)', 'Bash(which:*)', 'Bash(basename:*)', 'Bash(dirname:*)',
      // Read-only Git. `fetch` is here rather than in the Git bundle because it only updates
      // your copy of the remote's refs: it changes no file you are working on and nothing on
      // the remote, and it was the joint most-refused git subcommand in that review.
      'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
      'Bash(git fetch:*)', 'Bash(git remote:*)', 'Bash(git rev-parse:*)', 'Bash(git merge-base:*)',
      'Bash(git ls-files:*)', 'Bash(git blame:*)', 'Bash(git describe:*)', 'Bash(git branch)',
      'Bash(git worktree list)', 'Bash(git stash list)', 'Bash(git reflog:*)',
      'PowerShell(Get-Content:*)', 'PowerShell(Get-ChildItem:*)', 'PowerShell(Select-String:*)',
      'PowerShell(Test-Path:*)', 'PowerShell(Get-Item:*)',
    ],
    // Each of these is a reading command with a flag that writes or runs something.
    ask: [
      'Bash(rg*--pre*)', 'Bash(git diff*--output*)', 'Bash(sort* -o*)', 'Bash(sort*--output*)',
      'Bash(find* -delete*)', 'Bash(find* -exec*)', 'Bash(find* -ok*)', 'Bash(find* -fprint*)',
      'Bash(git remote* add *)', 'Bash(git remote* set-url*)', 'Bash(git remote* remove *)',
      'Bash(git remote* rm *)', 'Bash(git remote* rename *)', 'Bash(git remote* set-head*)',
      'Bash(git remote* set-branches*)', 'Bash(git remote* prune*)',
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
    // Saving work must not be able to throw work away, or change git for every repo on the machine.
    ask: [
      'Bash(git reset*--hard*)', 'Bash(git restore*)', 'Bash(git checkout* -- *)', 'Bash(git checkout* .)',
      'Bash(git stash* drop*)', 'Bash(git stash* clear*)', 'Bash(git branch* -D*)',
      'Bash(git config*--global*)', 'Bash(git config*--system*)', 'Bash(git config*alias.*)',
      'Bash(git clean*)',
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
    autoModeNote: 'In Auto mode (the recommended default) this switch only partly applies: npm and the other package managers run without asking, and they can run any script in the project, but direct Node, Python and shell commands still ask you each time.',
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
    // The full ref name reaches the same branch.
    `Bash(git push*--delete* refs/heads/${branch}*)`,
    `Bash(git push* -d* refs/heads/${branch}*)`,
    `Bash(git push* :refs/heads/${branch}*)`,
  ]
}

/**
 * `-f` combined with the other one-letter push flags: `-fu`, `-uf`, `-fuv` and so on. Listed, not
 * globbed: `* -*f*` would also catch `git push -u origin handoff --tags`.
 */
const FORCE_COMBOS = ['fu', 'uf', 'fv', 'vf', 'fq', 'qf', 'fuv', 'fvu', 'ufv', 'uvf', 'vfu', 'vuf']

/** The push rules, before the global-option twins are added. */
const PUSH_RULES: string[] = [
  'Bash(git push*--force*)',
  'Bash(git push*--force-with-lease*)',
  'Bash(git push* -f)',
  'Bash(git push* -f *)',
  ...FORCE_COMBOS.flatMap(c => [`Bash(git push* -${c})`, `Bash(git push* -${c} *)`]),
  ...PROTECTED_BRANCHES.flatMap(remoteDeletionRules),
]

/**
 * The git half of the fence: rewriting history that is already pushed, and deleting a trunk
 * branch. Exported so the "recommended git rules" preset in the UI can BE this list instead
 * of holding a copy of it. The copy is what drifted, and once the two disagreed nobody could
 * tell which one had bitten.
 *
 * Every rule also has a twin for a global option before `push` (`git -C ../app push -f`,
 * `git -c push.default=current push -f`), which agents in worktrees write all the time.
 */
export const GIT_HISTORY_FENCE: string[] = [
  ...PUSH_RULES,
  ...PUSH_RULES.map(r => r.replace(/^Bash\(git push/, 'Bash(git -* push')),
]

/**
 * Git history rules, in both shells. The `run` bundle grants bare `PowerShell`, so a Bash-only
 * deny is a deny with a door next to it.
 */
function bothShells(bashRules: string[]): string[] {
  return [...bashRules, ...bashRules.map(r => r.replace(/^Bash\(/, 'PowerShell('))]
}

/**
 * Ways to call rm, each anchored at the start of the command. Anchored on purpose: a leading `*`
 * also caught `echo confirm C:/Windows` and `terraform -chdir=C:/Windows plan`, and a deny cannot
 * be lifted for one chat.
 */
const BASH_RM = ['rm', '/bin/rm', '/usr/bin/rm', '\\rm', 'command rm']

/**
 * PowerShell delete. The CLI matches PowerShell rules case-insensitively and canonicalizes "common
 * aliases" before matching, but its docs only give `gci`/`ls`/`dir` as the example, so the delete
 * aliases are listed explicitly rather than trusted to that mapping. The app's
 * own matcher maps them either way, so these extra rules are harmless duplicates there.
 */
const POWERSHELL_DELETE = ['Remove-Item', 'rm', 'del', 'rd', 'rmdir', 'ri', 'erase']

/**
 * The system folders nobody's agent should ever delete. Bash spellings carry their casing
 * (Git Bash is case-preserving and the rule glob is case-sensitive there); PowerShell's are
 * lower-case because PowerShell matching ignores case.
 */
const SYSTEM_DIRS_BASH = ['Windows', 'windows', 'WINDOWS', 'Program Files', 'Program\\ Files']
const DRIVE_SPELLINGS_BASH = ['/c/', '/C/', 'C:/', 'c:/', 'C:\\', 'C:\\\\']
const SYSTEM_DIRS_POWERSHELL = ['c:\\windows', 'c:/windows', 'c:\\program files', 'c:/program files']
const SYSTEM_VARS_BASH = ['$WINDIR', '$SYSTEMROOT', '${WINDIR}', '$windir', '$SystemRoot']
const SYSTEM_VARS_POWERSHELL = ['$env:windir', '$env:systemroot', '$env:programfiles']

/** Generic ways to say "my home folder", or its parent. The literal path is added at spawn by homeFenceRules. */
const HOME_WORDS_BASH = ['~', '$HOME', '"$HOME"', '${HOME}', '"${HOME}"', '"$HOME/"', '$USERPROFILE', '"$USERPROFILE"', '~/..', '$HOME/..']
const HOME_WORDS_POWERSHELL = ['~', '"~"', '$home', '"$home"', '$env:userprofile', '"$env:userprofile"', '${env:userprofile}']

/**
 * Deny a delete of a folder ITSELF (not of something inside it). The target has to be the whole
 * word: `rm -rf ~` and `rm -rf ~/` are refused, `rm -rf ~/project/tmp` is not, because cleaning up
 * inside your home folder is ordinary work and wiping the folder is not.
 *
 * KNOWN LIMIT, said plainly in the UI too: a rule's `*` is always a wildcard, never a literal star
 * (the permission docs describe no escape for it), so `rm -rf ~/*` (everything INSIDE the home
 * folder) cannot be told apart from `rm -rf ~/project` and is not fenced. Same for `rm -rf /*`.
 */
function bashDeleteTargetRules(targets: string[]): string[] {
  return targets.flatMap(t => BASH_RM.flatMap(rm => ['', '/'].flatMap(tail => [`Bash(${rm} * ${t}${tail})`, `Bash(${rm} * ${t}${tail} *)`])))
}
function powershellDeleteTargetRules(targets: string[]): string[] {
  return targets.flatMap(t => POWERSHELL_DELETE.flatMap(cmd => cmd === 'Remove-Item'
    ? ['', '\\', '/'].flatMap(tail => [
        `PowerShell(${cmd}* ${t}${tail})`, `PowerShell(${cmd}* ${t}${tail} *)`,
        `PowerShell(${cmd}*:${t}${tail})`, `PowerShell(${cmd}*:${t}${tail} *)`,
      ])
    : [`PowerShell(${cmd} * ${t})`, `PowerShell(${cmd} * ${t} *)`]))
}

/**
 * Deny rules for "everything except destructive". Still a short list of catastrophes,
 * not a sweep, because a deny is a glob over a command string, not an understanding of it (the
 * CLI's own docs call argument patterns fragile). What it covers, and the UI says exactly this:
 *
 *   - rewriting or deleting git history that is already pushed, in the usual spellings
 *     (`--force`, `-f` alone or combined, `+branch`, `--mirror`, a global option before push),
 *     and deleting a trunk branch on the remote, including by its full ref name;
 *   - deleting the whole home folder or its parent (`~`, `$HOME`, `$env:USERPROFILE`, and at
 *     spawn the literal path, see homeFenceRules);
 *   - deleting anything in the folders Windows needs, in the usual slash styles and cases.
 *
 * Flag order does not matter: the patterns match on the command and the TARGET, so `rm -rf`,
 * `rm -fr` and `rm -r -f` are all the same rule.
 */
export const DESTRUCTIVE_FENCE: string[] = [
  ...bothShells([
    ...GIT_HISTORY_FENCE,
    'Bash(git push* +*)',
    'Bash(git push*--mirror*)',
    'Bash(git -* push* +*)',
    'Bash(git -* push*--mirror*)',
  ]),
  ...BASH_RM.flatMap(rm => [`Bash(${rm} * /)`, `Bash(${rm} * / *)`]),
  // No space before the folder, so a quoted path ("C:/Program Files"), a -Path: argument and a
  // plain one are all the same rule.
  ...SYSTEM_DIRS_BASH.flatMap(d => DRIVE_SPELLINGS_BASH.flatMap(drive => BASH_RM.map(rm => `Bash(${rm} *${drive}${d}*)`))),
  ...SYSTEM_VARS_BASH.flatMap(v => BASH_RM.map(rm => `Bash(${rm} *${v}*)`)),
  ...SYSTEM_DIRS_POWERSHELL.flatMap(d => POWERSHELL_DELETE.map(cmd => `PowerShell(${cmd}*${d}*)`)),
  ...SYSTEM_VARS_POWERSHELL.flatMap(v => POWERSHELL_DELETE.map(cmd => `PowerShell(${cmd}*${v}*)`)),
  ...bashDeleteTargetRules(HOME_WORDS_BASH),
  ...powershellDeleteTargetRules(HOME_WORDS_POWERSHELL),
  'Bash(find ~ *-delete*)', 'Bash(find $HOME *-delete*)',
].filter((r, i, all) => all.indexOf(r) === i)

/**
 * The literal home-folder spellings for one machine, added to the fence at spawn. `rm -rf ~` is
 * covered by DESTRUCTIVE_FENCE; `rm -rf /c/Users/<you>` can only be covered by someone who knows
 * the path, which is the server, not this shared list.
 */
export function homeFenceRules(home: string | null | undefined): string[] {
  if (!home || typeof home !== 'string') return []
  const trimmed = home.replace(/[\\/]+$/, '')
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(trimmed)
  if (!m) {
    const parent = trimmed.replace(/\/[^/]+$/, '')
    return bashDeleteTargetRules([trimmed, ...(parent && parent !== trimmed ? [parent] : [])])
  }
  const drive = m[1]
  const rest = m[2].replace(/\\/g, '/')
  const parentRest = rest.includes('/') ? rest.replace(/\/[^/]+$/, '') : ''
  const bash = new Set<string>()
  const ps = new Set<string>()
  // Git Bash writes /c/..., everything else C:/... ; PowerShell writes C:\... or C:/... . The
  // parent (C:\Users) is fenced too: deleting it takes everyone's home folder.
  for (const r of parentRest ? [rest, parentRest] : [rest]) {
    const lo = drive.toLowerCase()
    const up = drive.toUpperCase()
    bash.add(`/${lo}/${r}`)
    bash.add(`/${lo}/${r.toLowerCase()}`)
    bash.add(`${up}:/${r}`)
    bash.add(`${lo}:/${r.toLowerCase()}`)
    bash.add(`'${up}:\\${r.replace(/\//g, '\\')}'`)
    ps.add(`${drive.toLowerCase()}:\\${r.toLowerCase().replace(/\//g, '\\')}`)
    ps.add(`${drive.toLowerCase()}:/${r.toLowerCase()}`)
    ps.add(`"${drive.toLowerCase()}:\\${r.toLowerCase().replace(/\//g, '\\')}"`)
  }
  return [...bashDeleteTargetRules([...bash]), ...powershellDeleteTargetRules([...ps])]
}

/** The fence a spawn actually writes: the shared list plus this machine's home folder. */
export function destructiveFence(home?: string | null): string[] {
  return [...DESTRUCTIVE_FENCE, ...homeFenceRules(home)].filter((r, i, all) => all.indexOf(r) === i)
}

/**
 * ASK rules installed whenever `deploy` is NOT granted (this used to wait until some
 * other grant was on, so a fresh install gated nothing at all).
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
/**
 * "deploy" as the script name after a runner prefix, and only as the name: `yarn workspace web
 * deploy`, `... deploy --prod` and `... deploy:prod` ask; `yarn workspace api test deploy.spec.ts`
 * and `make deploy-check` do not (a loose `*deploy*` asked on those, and an ask
 * stops an unattended routine).
 */
function scriptNamed(prefix: string): string[] {
  // Not `deploy:*`: a rule ending in `:*` is the prefix form (the same as `deploy *`), so it can
  // never match `deploy:prod`. `deploy:p*` catches deploy:prod and deploy:production.
  // Production and staging names in every separator (`make deploy-prod` and `npm
  // -w web run deploy-production` stopped asking). Not a bare `deploy-*`: the `*` in a prefix such
  // as `yarn --cwd *` spans words, so it would ask about `yarn --cwd web add deploy-utils`.
  // Beta, dev, test and live too; `deploy:beta` is a real
  // convention here. A rule cannot say "deploy: then any word" (a closing `:*` is the prefix form).
  const names = ['deploy', 'deploy *']
  for (const sep of [':', '-', '_']) for (const env of 'psbdtl') names.push(`deploy${sep}${env}*`)
  return names.map(n => `Bash(*${prefix} ${n})`)
}

export const DEPLOY_FENCE: string[] = bothShells([
  // Cloudflare, including Pages and a pinned version (`npx wrangler@3 deploy`).
  'Bash(*wrangler*deploy*)',
  'Bash(*WRANGLER*deploy*)',
  'Bash(*wrangler*publish*)',
  'Bash(*wrangler*versions upload*)',
  // Vercel (`vc` is its short name): a bare `vercel` IS a deploy.
  'Bash(*vercel)',
  'Bash(*vercel .*)',
  'Bash(*vercel deploy*)',
  'Bash(*vercel --prod*)',
  'Bash(*vercel --yes*)',
  'Bash(*vercel -y*)',
  'Bash(*vercel --prebuilt*)',
  'Bash(*vercel promote*)',
  'Bash(*vercel redeploy*)',
  'Bash(*vc --prod*)',
  'Bash(*vc deploy*)',
  'Bash(*netlify deploy*)',
  'Bash(*netlify-cli deploy*)',
  'Bash(*ntl deploy*)',
  'Bash(*firebase deploy*)',
  'Bash(*firebase-tools deploy*)',
  'Bash(*firebase-tools@* deploy*)',
  'Bash(*supabase functions deploy*)',
  'Bash(*supabase db push*)',
  'Bash(*supabase db reset*)',
  'Bash(*flyctl deploy*)',
  'Bash(*fly deploy*)',
  'Bash(*railway up*)',
  'Bash(*railway deploy*)',
  'Bash(*railway/cli up*)',
  'Bash(*cdk deploy*)',
  'Bash(*serverless deploy*)',
  'Bash(*sls deploy*)',
  'Bash(*gcloud * deploy*)',
  ...scriptNamed('make'),
  'Bash(*gh workflow run deploy.yml*)',
  'Bash(*gh workflow run deploy.yaml*)',
  'Bash(*gh workflow run deploy)',
  'Bash(*gh workflow run deploy *)',
  'Bash(*gh workflow run deploy-p*)',
  'Bash(*gh workflow run deploy_p*)',
  'Bash(*gh workflow run deploy-s*)',
  'Bash(*gh workflow run deploy_s*)',
  // The project's own deploy script, through every package manager. Narrow on purpose: the
  // earlier `*npm*run*deploy*` also asked about `npm run test -- deploy.test.ts`.
  'Bash(*npm run deploy*)',
  'Bash(*npm run-script deploy*)',
  ...scriptNamed('npm run -*'),
  ...scriptNamed('npm --prefix * run'),
  ...scriptNamed('npm -w * run'),
  ...scriptNamed('npm --workspace* run'),
  'Bash(*npm run release*)',
  'Bash(*pnpm run deploy*)',
  'Bash(*pnpm deploy*)',
  ...scriptNamed('pnpm --filter *'),
  'Bash(*yarn deploy*)',
  'Bash(*yarn run deploy*)',
  ...scriptNamed('yarn workspace *'),
  ...scriptNamed('yarn --cwd *'),
  'Bash(*bun deploy*)',
  'Bash(*bun run deploy*)',
  ...scriptNamed('bun run --cwd *'),
])

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

/** The ask guards of a set of bundles, de-duplicated and order-stable. */
export function expandBundleAsks(ids: readonly string[] | undefined): string[] {
  if (!ids?.length) return []
  const out: string[] = []
  for (const bundle of PERMISSION_BUNDLES) {
    if (!ids.includes(bundle.id)) continue
    for (const rule of bundle.ask ?? []) if (!out.includes(rule)) out.push(rule)
  }
  return out
}

/** Bundle lookup by id, for labels in the UI. */
export function findBundle(id: string): PermissionBundle | undefined {
  return PERMISSION_BUNDLES.find(b => b.id === id)
}
