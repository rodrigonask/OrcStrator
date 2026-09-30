import { rest } from './rest'
import { wsClient } from './ws'
import type { WsEventMap, WsEventName, WsClientEventMap } from '@shared/ws-events'

type Handler<K extends WsEventName> = (payload: WsEventMap[K]) => void

export const api = {
  ...rest,

  // WebSocket event subscriptions. Event names and payloads come from the shared map the server
  // broadcasts through (shared/src/ws-events.ts), so a renamed event is a type error.
  onClaudeOutputBatch: (cb: Handler<'claude:output-batch'>) =>
    wsClient.on('claude:output-batch', cb),
  onClaudeProcessExit: (cb: Handler<'claude:process-exit'>) =>
    wsClient.on('claude:process-exit', cb),
  onUsageUpdated: (cb: Handler<'usage:plan-updated'>) =>
    wsClient.on('usage:plan-updated', cb),
  onPipelineUpdated: (cb: Handler<'pipeline:updated'>) =>
    wsClient.on('pipeline:updated', cb),
  onUsageAlert: (cb: Handler<'usage:alert'>) =>
    wsClient.on('usage:alert', cb),
  onConnection: (cb: (payload: WsClientEventMap['connection']) => void) =>
    wsClient.on('connection', cb),
  onMessageAdded: (cb: Handler<'message:added'>) =>
    wsClient.on('message:added', cb),
  onInstanceOverdrive: (cb: Handler<'instance:overdrive'>) =>
    wsClient.on('instance:overdrive', cb),
  onEvent: <K extends WsEventName>(event: K, cb: Handler<K>) =>
    wsClient.on(event, cb as (payload: unknown) => void),

  // Connection management
  connect: () => wsClient.connect(),
  disconnect: () => wsClient.disconnect(),

  // Terminal opt-in streaming
  subscribeTerminal: (instanceId: string) => wsClient.subscribeTerminal(instanceId),
  unsubscribeTerminal: (instanceId: string) => wsClient.unsubscribeTerminal(instanceId),
}

export { rest } from './rest'
export { wsClient } from './ws'
