import { rest } from './rest'
import { wsClient } from './ws'

export const api = {
  ...rest,

  // WebSocket event subscriptions
  onClaudeOutputBatch: (cb: (payload: any) => void) =>
    wsClient.on('claude:output-batch', cb),
  onClaudeProcessExit: (cb: (payload: any) => void) =>
    wsClient.on('claude:process-exit', cb),
  onUsageUpdated: (cb: (payload: any) => void) =>
    wsClient.on('usage:updated', cb),
  onPipelineUpdated: (cb: (payload: any) => void) =>
    wsClient.on('pipeline:updated', cb),
  onUsageAlert: (cb: (payload: any) => void) =>
    wsClient.on('usage:alert', cb),
  onConnection: (cb: (payload: { connected: boolean }) => void) =>
    wsClient.on('connection', cb),

  // Connection management
  connect: () => wsClient.connect(),
  disconnect: () => wsClient.disconnect(),
}

export { rest } from './rest'
export { wsClient } from './ws'
