// A stand-in for the claude binary, for tests that need a real process tree but must never
// reach a real agent or spend anything. It ignores its arguments, prints one stream-json
// init line, optionally starts a grandchild through a shell (the shape of an agent that ran a
// dev server in the background), and then sleeps.
//
//   FAKE_CLAUDE_GRANDCHILD  a command line run through cmd /c (Windows) or sh -c (elsewhere)
//   FAKE_CLAUDE_SLEEP_MS    how long to stay alive (default 60000)
//   FAKE_CLAUDE_ENVDUMP     write the environment it was started with to this file
//   FAKE_CLAUDE_STDOUT_FILE copy this file's bytes to stdout in small chunks
//   FAKE_CLAUDE_STDOUT_DELAY_MS  wait this long before copying it
//   FAKE_CLAUDE_STDOUT_LINE_DELAY_MS  copy it one line at a time, pausing this long between lines
//
// Windows: compiled once per test run with the C# compiler every Windows machine ships
// (.NET Framework's csc.exe), because Node refuses to spawn a .cmd without a shell and node.exe
// itself rejects the CLI's flags. Elsewhere: a shell script with a shebang.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const CS = `
using System;
using System.Diagnostics;
using System.Threading;
class FakeClaude {
  static void Main(string[] args) {
    Console.Out.WriteLine("{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"" + Guid.NewGuid().ToString() + "\\"}");
    Console.Out.Flush();
    string dump = Environment.GetEnvironmentVariable("FAKE_CLAUDE_ENVDUMP");
    if (!String.IsNullOrEmpty(dump)) {
      System.Text.StringBuilder sb = new System.Text.StringBuilder();
      foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) sb.Append(e.Key).Append("=").Append(e.Value).Append("\\n");
      System.IO.File.WriteAllText(dump, sb.ToString());
    }
    string raw = Environment.GetEnvironmentVariable("FAKE_CLAUDE_STDOUT_FILE");
    if (!String.IsNullOrEmpty(raw)) {
      string wait = Environment.GetEnvironmentVariable("FAKE_CLAUDE_STDOUT_DELAY_MS");
      if (!String.IsNullOrEmpty(wait)) Thread.Sleep(Int32.Parse(wait));
      byte[] bytes = System.IO.File.ReadAllBytes(raw);
      System.IO.Stream o = Console.OpenStandardOutput();
      string lineWait = Environment.GetEnvironmentVariable("FAKE_CLAUDE_STDOUT_LINE_DELAY_MS");
      if (!String.IsNullOrEmpty(lineWait)) {
        // One line at a time with a pause between: a paced burst, like a model streaming.
        int pause = Int32.Parse(lineWait); int start = 0;
        for (int i = 0; i < bytes.Length; i++) {
          if (bytes[i] != 10) continue;
          o.Write(bytes, start, i + 1 - start); o.Flush(); start = i + 1; Thread.Sleep(pause);
        }
        if (start < bytes.Length) { o.Write(bytes, start, bytes.Length - start); o.Flush(); }
      } else {
        // Small writes, so the reader sees many chunks and their edges fall inside characters.
        for (int i = 0; i < bytes.Length; i += 4093) { o.Write(bytes, i, Math.Min(4093, bytes.Length - i)); o.Flush(); Thread.Sleep(2); }
      }
    }
    string gc = Environment.GetEnvironmentVariable("FAKE_CLAUDE_GRANDCHILD");
    if (!String.IsNullOrEmpty(gc)) {
      ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c " + gc);
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      Process.Start(psi);
    }
    string ms = Environment.GetEnvironmentVariable("FAKE_CLAUDE_SLEEP_MS");
    Thread.Sleep(String.IsNullOrEmpty(ms) ? 60000 : Int32.Parse(ms));
  }
}
`

const SH = `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"fake-session"}'
if [ -n "$FAKE_CLAUDE_ENVDUMP" ]; then env > "$FAKE_CLAUDE_ENVDUMP"; fi
if [ -n "$FAKE_CLAUDE_STDOUT_FILE" ]; then
  if [ -n "$FAKE_CLAUDE_STDOUT_DELAY_MS" ]; then w=$FAKE_CLAUDE_STDOUT_DELAY_MS; sleep $((w / 1000)).$((w % 1000 / 100)); fi
  if [ -n "$FAKE_CLAUDE_STDOUT_LINE_DELAY_MS" ]; then
    p=$FAKE_CLAUDE_STDOUT_LINE_DELAY_MS
    while IFS= read -r l; do printf '%s\\n' "$l"; sleep $((p / 1000)).$(printf '%03d' $((p % 1000))); done < "$FAKE_CLAUDE_STDOUT_FILE"
  else
  size=$(wc -c < "$FAKE_CLAUDE_STDOUT_FILE"); off=0
  while [ "$off" -lt "$size" ]; do dd if="$FAKE_CLAUDE_STDOUT_FILE" bs=1 skip=$off count=4093 2>/dev/null; off=$((off + 4093)); sleep 0.002; done
  fi
fi
# "; true" keeps the shell alive as the program's parent (dash would exec a lone command),
# so the tree is claude -> sh -> node, the same depth as cmd /c on Windows.
if [ -n "$FAKE_CLAUDE_GRANDCHILD" ]; then sh -c "$FAKE_CLAUDE_GRANDCHILD; true" & fi
ms=\${FAKE_CLAUDE_SLEEP_MS:-60000}
sleep $((ms / 1000)).$((ms % 1000 / 100))
`

/** Build the fake into a temp dir and return its path (named claude / claude.exe). */
export function buildFakeClaude(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-fake-claude-'))
  if (process.platform === 'win32') {
    const src = path.join(dir, 'fake.cs')
    const exe = path.join(dir, 'claude.exe')
    fs.writeFileSync(src, CS)
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    execFileSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, src], { stdio: 'pipe' })
    return exe
  }
  const file = path.join(dir, 'claude')
  fs.writeFileSync(file, SH, { mode: 0o755 })
  return file
}

/** The command line for a grandchild that just stays alive: a node process ticking forever. */
export function longLivedNodeCommand(): string {
  const node = process.execPath
  // cmd /c strips the first and last quote of its command line, so the whole thing is wrapped
  // in one more pair.
  return process.platform === 'win32'
    ? `""${node}" -e "setInterval(function(){},1000)""`
    : `'${node}' -e 'setInterval(function(){},1000)'`
}

/** Process table (pid, ppid, name) straight from the OS, independent of the code under test. */
export function listProcesses(): Array<{ pid: number; ppid: number; name: string; createdAt: number }> {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId,$_.ParentProcessId,([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(),$_.Name }"], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter(Boolean).map(l => { const [a, b, t, ...c] = l.split('|'); return { pid: +a, ppid: +b, createdAt: +t || 0, name: c.join('|').toLowerCase() } })
  }
  const now = Date.now()
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,comm='], { encoding: 'utf8' })
  return out.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(m => ({ pid: +m![1], ppid: +m![2], createdAt: now - +m![3] * 1000, name: m![4].toLowerCase() }))
}

/** Every descendant of `root` in a process list. */
export function treeOf(root: number, list: Array<{ pid: number; ppid: number; createdAt?: number }> = listProcesses()): number[] {
  // A process "older" than its parent only inherited a reused parent number: not a descendant.
  // (Under load, other programs' short-lived processes recycle PIDs fast enough to matter.)
  const born = new Map(list.map(p => [p.pid, p.createdAt ?? 0]))
  const out: number[] = []
  const q = [root]
  while (q.length) {
    const p = q.shift()!
    for (const c of list) {
      if (c.ppid !== p || out.includes(c.pid) || c.pid === root) continue
      if ((born.get(p) ?? 0) && (c.createdAt ?? 0) && (c.createdAt ?? 0) + 2000 < (born.get(p) ?? 0)) continue
      out.push(c.pid); q.push(c.pid)
    }
  }
  return out
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
