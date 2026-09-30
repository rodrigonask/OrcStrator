// The permission fences and the app's rule matcher, as table tests.
//
//   npx tsx shared/test/permission-fences.test.ts
//
// Every command found getting through is a row here, together with the everyday
// commands that must keep working, because a fence that blocks normal work gets switched off.
// Matching uses the app's own ruleMatches (the same matcher the refusal cards use).

import { ruleMatches, ruleSubjects, survivesAutoMode } from '../src/permission-rules.js'
import * as bundles from '../src/permission-bundles.js'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}

type Tool = 'Bash' | 'PowerShell'
function hits(rules: string[], tool: Tool, command: string): string | undefined {
  const cands = ruleSubjects(tool, { command })
  return rules.find(r => ruleMatches(r, tool, cands))
}

const b = bundles as Record<string, unknown>
const destructiveFence = (b.destructiveFence as ((home?: string) => string[]) | undefined)
  ?? (() => bundles.DESTRUCTIVE_FENCE)
const fence = destructiveFence('C:\\Users\\me')

// ── The destructive fence ─────────────────────────────────────────────────────
const mustDeny: Array<[Tool, string]> = [
  ['Bash', 'rm -rf ~'],
  ['Bash', 'rm -rf $HOME'],
  ['Bash', 'rm -rf /c/Users/me'],
  ['Bash', 'rm -rf /c/Users/me/'],
  ['Bash', 'rm -fr /c/Windows'],
  ['Bash', 'rm -r -f /c/Windows'],
  ['Bash', 'rm -rf /c/windows/System32'],
  ['Bash', 'rm -rf "C:/Program Files"'],
  // Quoted, upper-case, full-ref, combined-flag and prefixed spellings.
  ['Bash', 'rm -rf "/c/Program Files"'],
  ['Bash', 'rm -rf /c/Program\\ Files'],
  ['Bash', 'rm -rf /c/WINDOWS'],
  ['Bash', 'rm -rf "/c/Windows"'],
  ['Bash', 'rm -rf /C/Windows'],
  ['Bash', 'git push -fu origin main'],
  ['Bash', 'git push -uf origin main'],
  ['Bash', 'git push origin :refs/heads/main'],
  ['Bash', 'git push origin --delete refs/heads/main'],
  ['Bash', '/bin/rm -rf ~'],
  ['Bash', 'command rm -rf $HOME'],
  ['PowerShell', 'remove-item -Recurse -Force C:\\Windows'],
  ['PowerShell', "Remove-Item -Recurse -Force 'C:\\Windows'"],
  ['PowerShell', 'Remove-Item -Path:C:\\Windows -Recurse'],
  ['PowerShell', 'Remove-Item -Recurse -Force "$env:USERPROFILE"'],
  ['PowerShell', 'git push -fu origin main'],
  // More spellings, including three regressions from an earlier trim.
  ['Bash', 'rm -rf c:/Windows'],
  ['PowerShell', 'Remove-Item -Recurse -Force c:\\windows'],
  ['PowerShell', 'erase -Recurse -Force C:\\Windows'],
  ['PowerShell', 'Del -Recurse C:\\Windows'],
  ['Bash', 'git -C ../app push -f origin main'],
  ['Bash', 'git -C /d/work/app push origin --delete main'],
  ['Bash', 'git -c push.default=current push -f'],
  ['PowerShell', 'git -C D:\\Work\\app push --force'],
  ['Bash', 'git push -fuv'],
  ['Bash', 'rm -rf ~/..'],
  ['Bash', 'rm -rf $HOME/..'],
  ['Bash', 'rm -rf "$HOME/"'],
  ['Bash', 'rm -rf "${HOME}"'],
  ['Bash', 'rm -rf $USERPROFILE'],
  ['Bash', 'rm -rf $WINDIR'],
  ['Bash', 'rm -rf c:/users/me'],
  ['Bash', "rm -rf 'C:\\Users\\me'"],
  ['PowerShell', 'Remove-Item -Recurse -Force "$HOME"'],
  ['PowerShell', 'Remove-Item -Recurse -Force $HOME/'],
  ['PowerShell', 'Remove-Item -Recurse -Force ${env:USERPROFILE}'],
  ['PowerShell', 'Remove-Item -Recurse -Force -Path:~'],
  ['PowerShell', 'Remove-Item -Recurse -Force $env:windir'],
  ['PowerShell', 'Remove-Item -Recurse -Force c:\\users\\me'],
  ['Bash', 'find ~ -type f -delete'],
  ['Bash', 'git push origin +main'],
  ['Bash', 'git push --mirror'],
  ['Bash', 'git push --force origin main'],
  ['PowerShell', 'Remove-Item -Recurse -Force C:/Windows'],
  ['PowerShell', 'Remove-Item -Recurse -Force C:\\Windows\\System32'],
  ['PowerShell', 'Remove-Item -Recurse -Force $HOME'],
  ['PowerShell', 'rd /s /q $env:USERPROFILE'],
  ['PowerShell', 'Remove-Item -Recurse C:\\Users\\me'],
  ['PowerShell', 'git push --force origin main'],
]
for (const [tool, cmd] of mustDeny) {
  const rule = hits(fence, tool, cmd)
  check(`denies ${tool}: ${cmd}`, !!rule, rule ?? 'NOT DENIED')
}
const mustAllow: Array<[Tool, string]> = [
  // Words ending in "rm" must not trip a deny that cannot be lifted.
  ['Bash', 'echo confirm C:/Windows'],
  ['Bash', 'terraform -chdir=C:/Windows plan'],
  ['PowerShell', 'Get-ChildItem C:\\Windows'],
  ['Bash', 'git push -u origin handoff --tags'],
  ['Bash', 'git push origin feature/x --follow-tags'],
  ['Bash', 'rm -rf ./build/windows-x64'],
  ['Bash', 'rm -rf ./node_modules'],
  ['Bash', 'rm -rf dist'],
  ['Bash', 'rm -rf ~/project/tmp'],
  ['Bash', 'rm -rf /c/Users/me/project/dist'],
  ['Bash', 'git push origin feature/x'],
  ['Bash', 'git push -u origin fix/audit-1'],
  ['Bash', 'git push origin --delete fix/merged-branch'],
  ['PowerShell', 'Remove-Item -Recurse -Force .\\dist'],
  ['PowerShell', 'Remove-Item -Recurse $HOME\\project\\tmp'],
]
for (const [tool, cmd] of mustAllow) {
  const rule = hits(fence, tool, cmd)
  check(`leaves ordinary work alone, ${tool}: ${cmd}`, !rule, rule ?? '')
}

// ── The deploy fence catches the common spellings ───────────────────────────────
const deploys = [
  'npx wrangler deploy', 'npx wrangler pages deploy dist', 'npx wrangler@latest deploy',
  'npx firebase deploy', 'pnpm run deploy', 'yarn deploy', 'netlify deploy --prod', 'npx vercel',
  'npx supabase db reset --linked', 'npm run deploy:beta',
  'npm run-script deploy', 'npm run -w web deploy', 'npm --prefix web run deploy', 'npx vercel -y',
  'npx vercel --prebuilt --prod', 'npx netlify-cli deploy --prod', 'npx ntl deploy --prod',
  'npx firebase-tools deploy', 'npx cdk deploy', 'npx serverless deploy', 'npx @railway/cli up',
  'npx WRANGLER deploy', 'bash -c "gcloud run deploy svc"',
  'vc --prod', 'vc deploy --prod', 'vercel promote https://x.vercel.app', 'yarn workspace web deploy',
  'yarn --cwd web deploy', 'bun deploy', 'pnpm --filter web deploy:prod', 'railway deploy',
  'npx firebase-tools@latest deploy', 'make deploy', 'gh workflow run deploy.yml',
  // These stopped asking once the names were narrowed.
  'make deploy-prod', 'make deploy_production', 'yarn workspace web deploy-prod',
  'npm -w web run deploy-production', 'npm run --silent deploy:staging',
  'gh workflow run deploy-prod.yml', 'gh workflow run deploy_production.yml',
  'pnpm --filter web deploy-staging', 'yarn --cwd web deploy_prod',
  // The beta/dev/test names through the same runners.
  'yarn workspace web deploy:beta', 'yarn workspace web deploy:dev', 'yarn workspace web run deploy:beta',
  'pnpm --filter web deploy:beta', 'npm -w web run deploy:beta', 'npm --workspace web run deploy:beta',
  'npm --prefix web run deploy:beta', 'npm run -w web deploy:beta', 'bun run --cwd web deploy:beta',
  'yarn --cwd web deploy:beta', 'make deploy-beta', 'npm run -w web deploy:test',
]
for (const cmd of deploys) {
  for (const tool of ['Bash', 'PowerShell'] as Tool[]) {
    const rule = hits(bundles.DEPLOY_FENCE, tool, cmd)
    check(`deploy fence asks, ${tool}: ${cmd}`, !!rule, rule ?? 'NOT GATED')
  }
}
for (const cmd of ['npm run build', 'npx vite build', 'npm test', 'npx tsc --noEmit',
  // Ordinary commands that mention "deploy".
  'npm run test -- deploy.test.ts', 'npm run lint -- src/deploy', 'vercel --version', 'gcloud config list --format=deployment',
  // (`pnpm --filter api test -- deploy`, a test literally named deploy, still asks: a glob
  // cannot tell a filter value from a test argument. Accepted as is.)
  'yarn workspace api test deploy.spec.ts', 'pnpm --filter api test -- deploy.spec.ts', 'make deploy-check',
  'gh workflow run deploy-docs-preview.yml', 'yarn --cwd web add deploy-utils']) {
  check(`deploy fence leaves "${cmd}" alone`, !hits(bundles.DEPLOY_FENCE, 'Bash', cmd))
}

// ── Bundles do not grant more than their labels ─────────────────────────────────
const expandBundleAsks = (b.expandBundleAsks as ((ids: string[]) => string[]) | undefined) ?? (() => [])
const readAsk = expandBundleAsks(['read'])
const gitAsk = expandBundleAsks(['git'])
for (const cmd of ['rg --pre ./evil.sh foo', 'git diff --output=package.json', 'git remote set-url origin https://x', 'sort -o src/index.ts a.txt', 'find . -delete', 'find . -exec rm {} ;']) {
  const rule = hits(readAsk, 'Bash', cmd)
  check(`"Look at things" asks before: ${cmd}`, !!rule, rule ?? 'RUNS SILENTLY')
}
for (const cmd of ['rg foo src', 'git diff HEAD~1', 'git remote -v', 'sort names.txt', 'find . -name "*.ts"']) {
  check(`"Look at things" still runs silently: ${cmd}`, !hits(readAsk, 'Bash', cmd))
}
for (const cmd of ['git config --global alias.x "!rm -rf ~"', 'git reset --hard HEAD~5', 'git restore .', 'git checkout -- .', 'git stash drop', 'git branch -D feature']) {
  const rule = hits(gitAsk, 'Bash', cmd)
  check(`"Save and share work" asks before: ${cmd}`, !!rule, rule ?? 'RUNS SILENTLY')
}
for (const cmd of ['git commit -m "x"', 'git push origin feature', 'git reset HEAD file.ts', 'git config user.name']) {
  check(`"Save and share work" still runs silently: ${cmd}`, !hits(gitAsk, 'Bash', cmd))
}
const read = bundles.PERMISSION_BUNDLES.find(x => x.id === 'read')!
check('the read bundle no longer claims it "cannot alter anything"', !/cannot alter anything/i.test(read.description), read.description)
const run = bundles.PERMISSION_BUNDLES.find(x => x.id === 'run') as unknown as { autoModeNote?: string }
check('the run bundle carries an Auto mode caveat', typeof run.autoModeNote === 'string' && /npm/.test(run.autoModeNote))

// ── A PowerShell rule written with an alias matches its own command ───────────
for (const [rule, cmd] of [['PowerShell(ls:*)', 'ls -la'], ['PowerShell(rm:*)', 'rm .\\dist'], ['PowerShell(gci:*)', 'gci'], ['PowerShell(Get-Content:*)', 'cat notes.txt'], ['PowerShell(Copy-Item:*)', 'cp a b']] as const) {
  check(`PowerShell alias rule ${rule} matches "${cmd}"`, ruleMatches(rule, 'PowerShell', [cmd]))
}
check('PowerShell rules still do not cross cmdlets (Get-Content vs rm)', !ruleMatches('PowerShell(Get-Content:*)', 'PowerShell', ['rm x']))

// ── Word boundary on :* ─────────────────────────────────────────────────────
check('Bash(tr:*) does NOT match "tree -o notes.md"', !ruleMatches('Bash(tr:*)', 'Bash', ['tree -o notes.md']))
check('Bash(tr:*) matches "tr a b"', ruleMatches('Bash(tr:*)', 'Bash', ['tr a b']))
check('Bash(tr:*) matches bare "tr"', ruleMatches('Bash(tr:*)', 'Bash', ['tr']))
check('Bash(git push:*) does NOT match "git pushx"', !ruleMatches('Bash(git push:*)', 'Bash', ['git pushx']))
check('Bash(git push:*) matches "git push origin main"', ruleMatches('Bash(git push:*)', 'Bash', ['git push origin main']))

// ── Whole-shell grants are recognised on Windows spellings ──────────────────────
for (const rule of ['Bash(cmd:*)', 'Bash(powershell:*)', 'Bash(pwsh:*)', 'Bash(python.exe:*)', 'Bash(node.exe:*)', 'Bash(cmd.exe:*)', 'Bash(powershell.exe *)', 'Bash(wsl:*)',
  // The Windows switch style and a full path.
  'Bash(cmd /c:*)', 'Bash(cmd.exe /c:*)', 'Bash(cmd /c *)', 'Bash(C:/Windows/System32/cmd.exe:*)', 'Bash(/usr/bin/python3:*)']) {
  check(`"Allow always" refuses whole-shell grant ${rule}`, !survivesAutoMode(rule))
}
for (const rule of ['Bash(git status:*)', 'Bash(npm test:*)', 'Bash(cmdtool:*)', 'Bash(python -m http.server:*)', 'Bash(./build.sh:*)', 'Bash(C:/tools/mytool.exe:*)',
  // Script and tool paths are ordinary grants, not whole shells.
  'Bash(node /c/proj/scripts/build.js *)', 'Bash(python /home/me/tool.py *)', 'Bash(C:/tools/*)', 'Bash(/c/tools/*)']) {
  check(`an ordinary grant is still accepted: ${rule}`, survivesAutoMode(rule))
}

console.log(`\n${failed === 0 ? 'all passed' : `${failed} failed`}`)
if (failed > 0) process.exitCode = 1
