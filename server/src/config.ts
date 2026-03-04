import path from 'path'
import os from 'os'

export const DATA_DIR = path.join(os.homedir(), '.nasklaude')
export const DB_PATH = path.join(DATA_DIR, 'nasklaude.db')
export const DEFAULT_PORT = 3333
