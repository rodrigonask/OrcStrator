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
    wsClient.on('usage:plan-updated', cb),
  onPipelineUpdated: (cb: (payload: any) => void) =>
    wsClient.on('pipeline:updated', cb),
  onUsageAlert: (cb: (payload: any) => void) =>
    wsClient.on('usage:alert', cb),
  onConnection: (cb: (payload: { connected: boolean }) => void) =>
    wsClient.on('connection', cb),
  onMessageAdded: (cb: (payload: any) => void) =>
    wsClient.on('message:added', cb),
  onInstanceOverdrive: (cb: (payload: any) => void) =>
    wsClient.on('instance:overdrive', cb),
  onEvent: (event: string, cb: (payload: any) => void) =>
    wsClient.on(event, cb),

  // Connection management
  connect: () => wsClient.connect(),
  disconnect: () => wsClient.disconnect(),

  // Terminal opt-in streaming
  subscribeTerminal: (instanceId: string) => wsClient.subscribeTerminal(instanceId),
  unsubscribeTerminal: (instanceId: string) => wsClient.unsubscribeTerminal(instanceId),
}

export { rest } from './rest'
export { wsClient } from './ws'
