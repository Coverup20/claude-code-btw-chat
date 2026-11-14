export type BtwMessage = {
  id: string
  q: string
  answer?: string
  pending: boolean
}

export type BtwComposerAck = {
  clientId: string
  revision: number
  submitted: number
}

declare module 'claude-code' {
  interface PluginState {
    'btw-chat': {
      msgs: Shaped<BtwMessage[]>
      draft: Shaped<string>
      scrollBack: Shaped<number>
      tick: Shaped<number>
      composerAck: Shaped<BtwComposerAck>
    }
  }
}
