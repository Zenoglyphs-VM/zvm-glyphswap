/// <reference types="vite/client" />

declare module '*.vue' {
  import type {DefineComponent} from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface Window {
  /** EIP-1193, injected by MetaMask, Rabby, Phantom and the rest. */
  ethereum?: any
  /** The Syrius extension, for the bridge's deposit form. See src/core/syrius.ts. */
  zenon?: import('./src/core/syrius').ZenonProvider
}
