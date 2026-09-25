import { marked } from 'marked'

// Every markdown surface in the app — chat bubbles, plan blocks, task descriptions
// and comments — parses through the same global `marked` singleton, so its config
// lives here. Call parseMarkdown() rather than marked.parse(): a bare side-effect
// import is too easy to drop, and then a surface silently loses the rules below.

marked.setOptions({ breaks: true })

const renderer = new marked.Renderer()
renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
  const titleAttr = title ? ` title="${title}"` : ''
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
}

// Strikethrough takes TWO tildes here. marked follows the GFM spec, where ~one~ tilde
// strikes as well — but chat text is full of "~50 credits" and "(~0.37 each)", and
// those stray tildes pair off into <del> runs that swallow whole sentences and eat the
// tildes themselves ("(~3)" renders as "(3)"). Approximations are far more common in
// this app than strikethrough, so one tilde is now just a tilde.
const STRIKETHROUGH_RE = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/

marked.use({
  renderer,
  tokenizer: {
    del(src) {
      const match = STRIKETHROUGH_RE.exec(src)
      // undefined, NOT false: marked's use() reads a `false` return as "fall through to
      // the built-in tokenizer" — which is the single-tilde rule we are replacing.
      if (!match) return undefined
      return {
        type: 'del',
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      }
    },
  },
})

// Windows paths and markdown escapes fight each other. marked reads a backslash
// before ASCII punctuation as an escape, so "C:\Users\me\.claude\x.md" parses to
// "C:\Users\me.claude\x.md" and "notes\_drafts" to "notes_drafts".
// Both point nowhere, so such file links would open nothing at all while the
// identical path inside a code span (where escapes are inert) works fine.
// So lift every path out of the source before parsing and put it back afterwards.
const WIN_PATH_RE = /\b[A-Za-z]:[\\/](?:[^\\/:<>"|?*\s]+[\\/])*[^\\/:<>"|?*\s]+/g
// A bare path has to stop at the first space, since nothing says where it ends. Inside
// backticks or double quotes the delimiter does say, so "C:\My Docs\shot.png" survives
// whole. Runs holding a " -" are commands, not paths, and keep the bare-path treatment.
const DELIMITED_PATH_RE = /(`|")([A-Za-z]:[\\/][^`"<>|?*\r\n]*)\1/g
const TRAILING_JUNK_RE = /([\s.,;:!?)\]}'"`]+)$/

// Private-use code points: marked passes them through untouched (inside code spans and
// fenced blocks too) and no real message contains them.
const PH_OPEN = '\uE000'
const PH_CLOSE = '\uE001'
const PH_RE = /\uE000(\d+)\uE001/g

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function protectWinPaths(text: string): { text: string; paths: string[] } {
  const paths: string[] = []
  const stash = (raw: string): string => {
    const trail = raw.match(TRAILING_JUNK_RE)
    const core = trail ? raw.slice(0, raw.length - trail[0].length) : raw
    if (!/^[A-Za-z]:[\\/]./.test(core)) return raw
    return `${PH_OPEN}${paths.push(core) - 1}${PH_CLOSE}${trail ? trail[0] : ''}`
  }
  const out = text
    .replace(DELIMITED_PATH_RE, (m: string, delim: string, inner: string) =>
      inner.includes(' -') ? m : `${delim}${stash(inner)}${delim}`)
    .replace(WIN_PATH_RE, stash)
  return { text: out, paths }
}

// A delimited run can still have swallowed trailing arguments. data-path-alt is the
// bare-path reading of it, which the click handler retries when the full run misses.
function anchorOpenTag(p: string): string {
  const alt = p.includes(' ') ? ` data-path-alt="${escapeAttr(p.slice(0, p.indexOf(' ')))}"` : ''
  return `<a class="auto-path" data-path="${escapeAttr(p)}"${alt} href="#"` +
    ` title="Click to open in default app">`
}

// `[label](C:\some\folder)` — a path used as a markdown link destination. Left alone it
// renders as a normal anchor whose href is a bare Windows path, so clicking it navigates
// the tab to nothing. It looks exactly like a working link, which is the worst kind.
const LINK_TO_PATH_RE = /^<a\b[^>]*\shref="\uE000(\d+)\uE001"/

function restoreWinPaths(html: string, paths: string[], linkPaths: boolean): string {
  if (!paths.length) return html
  // Split into tag vs. text runs: a path used as a markdown link destination lands in an
  // href attribute, where an anchor would nest inside a tag and produce garbage.
  const parts = html.split(/(<[^>]+>)/g)
  return parts.map((part, i) => {
    if (i % 2 === 1 && linkPaths) {
      const m = part.match(LINK_TO_PATH_RE)
      const p = m ? paths[Number(m[1])] : undefined
      if (p !== undefined) return anchorOpenTag(p)
    }
    return part.replace(PH_RE, (m, idx: string) => {
      const p = paths[Number(idx)]
      if (p === undefined) return m
      if (i % 2 === 1) return escapeAttr(p)
      if (!linkPaths) return escapeText(p)
      return `${anchorOpenTag(p)}${escapeText(p)}</a>`
    })
  }).join('')
}

/**
 * `linkPaths` wraps Windows paths in the `a.auto-path` anchors the chat's click
 * handler opens. Surfaces without that handler leave it off and just get the path
 * rendered correctly.
 */
export function parseMarkdown(text: string, opts: { linkPaths?: boolean } = {}): string {
  const { text: src, paths } = protectWinPaths(text)
  const html = marked.parse(src) as string
  return restoreWinPaths(html, paths, opts.linkPaths === true)
}

// Collapsed ("View more") bubbles cut the source text before it is parsed, so a naive
// slice can land inside markdown syntax: mid-``` leaves the rest of the bubble stuck in
// a code block, and mid-**bold** leaves literal asterisks on screen. Cut on a line
// boundary when one is close enough, then repair whatever the cut left open.
const FENCE_RE = /^ {0,3}```/gm
const INLINE_MARKERS = ['~~', '**', '__', '`']

export function truncateMarkdown(text: string, limit: number): string {
  if (text.length <= limit) return text
  let cut = text.slice(0, limit)

  // A line boundary can't sit inside an inline span, so prefer one — but only if it
  // doesn't cost more than a third of the preview.
  const lastLine = cut.lastIndexOf('\n')
  if (lastLine >= limit * 0.66) cut = cut.slice(0, lastLine)
  cut = cut.replace(/\s+$/, '')

  // An unclosed fence swallows everything after it, so close it before anything else.
  if ((cut.match(FENCE_RE) || []).length % 2 === 1) return `${cut}\n\`\`\``

  // Close any inline span the cut left hanging, so the preview never shows raw ** or `.
  for (const marker of INLINE_MARKERS) {
    if ((cut.split(marker).length - 1) % 2 === 1) cut += marker
  }

  // A link cut mid-url ("[docs](https://ex") renders as literal text — drop the whole
  // opener. A bare "[bracketed]" phrase has no "](" and is left alone.
  const lastOpen = cut.lastIndexOf('[')
  const tail = lastOpen === -1 ? '' : cut.slice(lastOpen)
  if (tail.includes('](') && !tail.includes(')')) {
    cut = cut.slice(0, lastOpen).replace(/!$/, '').replace(/\s+$/, '')
  }
  return cut
}
