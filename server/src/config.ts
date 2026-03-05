import path from 'path'
import os from 'os'

export const DATA_DIR = path.join(os.homedir(), '.nasklaude')
export const DB_PATH = path.join(DATA_DIR, 'nasklaude.db')
export const DEFAULT_PORT = 3333
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://localhost:3333').split(',')
