export type BtwMessage = {
  id: string
  q: string
  answer?: string
  pending: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'btw-chat': {
      msgs: Shaped<BtwMessage[]>
      draft: Shaped<string>
    }
  }
}
