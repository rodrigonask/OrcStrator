// Auto-linkify URLs (http/https) in rendered HTML. Runs after marked so it sees the actual
// rendered output (including inside <code>); skips content already inside <a> tags so
// markdown links are not double-wrapped. File paths are linkified earlier, by
// parseMarkdown({ linkPaths: true }): they have to be lifted out before parsing, or
// markdown's escape rules eat the backslashes.
//
// TEXT RUNS ONLY. It used to rewrite every URL outside an anchor, attributes
// included, so `![x](https://host/a.png)` became `<img src="<a href=...>">`: a broken image
// followed by a stray link. Each run between anchors is split again into tags and text, and
// only the text is touched.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g
const TRAILING_PUNCT_RE = /([.,;:!?)\]}'"`]+)$/

export function autoLinkify(html: string): string {
  const parts = html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/g)
  return parts.map((part, i) => {
    if (i % 2 === 1) return part
    return part.split(/(<[^>]+>)/g).map((run, j) => {
      if (j % 2 === 1) return run
      return run.replace(URL_RE, (m) => {
        const trail = m.match(TRAILING_PUNCT_RE)
        const core = trail ? m.slice(0, m.length - trail[0].length) : m
        const trailing = trail ? trail[0] : ''
        const safe = core.replace(/"/g, '&quot;')
        return `<a class="auto-url" href="${safe}" target="_blank" rel="noopener noreferrer">${core}</a>${trailing}`
      })
    }).join('')
  }).join('')
}
