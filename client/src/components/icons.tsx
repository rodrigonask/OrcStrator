import type { ReactNode, SVGProps } from 'react'

/**
 * Monochrome line icons (lucide geometry, MIT — https://lucide.dev), inlined as
 * components rather than pulled in as a runtime dependency. Every icon strokes in
 * `currentColor`, so the topbar nav stays uniform: muted ink at rest, violet when
 * active — matching the Aurora Glass mockup. Sized via the `size` prop (px).
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Glyph({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconGrid = (p: IconProps) => (
  <Glyph {...p}>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </Glyph>
)

export const IconChat = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
  </Glyph>
)

export const IconPipeline = (p: IconProps) => (
  <Glyph {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="M15 3v18" />
  </Glyph>
)

export const IconRoutines = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </Glyph>
)

export const IconSessions = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M15 12h-5" />
    <path d="M15 8h-5" />
    <path d="M19 17V5a2 2 0 0 0-2-2H4" />
    <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
  </Glyph>
)

/** A book with a bookmark: the skills are documents on disk, and they read like manuals. */
export const IconSkills = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M12 2v8l2.5-1.8L17 10V2" />
  </Glyph>
)

/** Task Activity: a clock with a pulse, every scheduled fire in one list. */
export const IconActivity = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Glyph>
)

export const IconUsage = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </Glyph>
)

export const IconSettings = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
    <circle cx="12" cy="12" r="3" />
  </Glyph>
)

export const IconPower = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
  </Glyph>
)

// Keep-warm toggle (lucide "flame"). Muted at rest, warm orange when the session is
// being kept warm — see .keepwarm-btn / .keepwarm-btn.on in instance-extras.css.
export const IconFlame = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  </Glyph>
)

// Compact context (lucide "chevrons-down-up" — collapse toward the center).
export const IconCompact = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m7 20 5-5 5 5" />
    <path d="m7 4 5 5 5-5" />
  </Glyph>
)

// Enter Ultra Compact (lucide "shrink" — four arrows pulling inward).
export const IconShrink = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m15 15 6 6m-6-6v4.8m0-4.8h4.8" />
    <path d="M9 19.8V15m0 0H4.2M9 15l-6 6" />
    <path d="M15 4.2V9m0 0h4.8M15 9l6-6" />
    <path d="M9 4.2V9m0 0H4.2M9 9 3 3" />
  </Glyph>
)

// Leave Ultra Compact (lucide "expand" — the same four arrows pushing back out).
export const IconExpand = (p: IconProps) => (
  <Glyph {...p}>
    <path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8" />
    <path d="M3 16.2V21m0 0h4.8M3 21l6-6" />
    <path d="M21 7.8V3m0 0h-4.8M21 3l-6 6" />
    <path d="M3 7.8V3m0 0h4.8M3 3l6 6" />
  </Glyph>
)

/** Sidebar folder tools (lucide `folder` and `message-square-plus`). */
export const IconFolder = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Glyph>
)

export const IconChatPlus = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
    <path d="M9 11h6" />
    <path d="M12 8v6" />
  </Glyph>
)
