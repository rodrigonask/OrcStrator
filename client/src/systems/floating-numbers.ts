// DOM floating text system ("+XP", "LEVEL UP!", "DONE!", etc.)
// Creates absolutely positioned elements with CSS animation, auto-removes

export interface FloatConfig {
  text: string
  x: number
  y: number
  color?: string
  size?: number
  duration?: number
}

export class FloatingNumbers {
  private container: HTMLDivElement | null = null

  mount(container: HTMLDivElement): void {
    this.container = container
  }

  unmount(): void {
    this.container = null
  }

  spawn(config: FloatConfig): void {
    if (!this.container) return
    const el = document.createElement('div')
    el.textContent = config.text
    el.style.cssText = `
      position: absolute;
      left: ${config.x}px;
      top: ${config.y}px;
      color: ${config.color || '#ffd700'};
      font-family: var(--font-pixel, monospace);
      font-size: ${config.size || 16}px;
      font-weight: 700;
      pointer-events: none;
      white-space: nowrap;
      text-shadow: 0 0 6px ${config.color || '#ffd700'}88;
      animation: vfx-float-up ${config.duration || 1200}ms ease-out forwards;
      z-index: 10;
    `
    this.container.appendChild(el)
    const dur = config.duration || 1200
    setTimeout(() => { el.remove() }, dur + 50)
  }
}
