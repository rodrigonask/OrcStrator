import type { FolderConfig } from '@shared/types'

// Deterministic, vivid identity color per folder. Explicit folder.color
// (Edit Project) always wins; otherwise hash the id onto a curated wheel so
// every folder is colorful out of the box — same folder, same color, forever.
const WHEEL = [
  '#7c3aed', // violet
  '#2563eb', // blue
  '#0d9488', // teal
  '#16a34a', // green
  '#d97706', // amber
  '#ea580c', // orange
  '#dc2626', // red
  '#db2777', // pink
  '#9333ea', // purple
  '#0891b2', // cyan
]

function djb2(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h
}

export function folderColor(folder: Pick<FolderConfig, 'id' | 'color' | 'stealthMode'>): string {
  if (folder.stealthMode) return '#6b7280'
  if (folder.color) return folder.color
  return WHEEL[djb2(folder.id) % WHEEL.length]
}
