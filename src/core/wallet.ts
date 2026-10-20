// Who is connected, in one place, so no page re-attaches provider listeners.
//
// One wallet kind only: anything that speaks EIP-1193 and announces itself
// through EIP-6963. Syrius is one of them — its EVM account, from the same
// recovery phrase as its Zenon account (core/syriusZvm.ts). Its Zenon key is
// used only by the bridge page's deposit form (core/syrius.ts).

import {computed, reactive, watch} from 'vue'
import type {Address} from 'viem'
import * as evm from './evm'
import {endpoint} from './endpoint'
import {accountRefusal, refusal, walletIcon} from './syriusZvm'

interface State {
  name: string | null
  icon: string | null
  address: Address | null
  chainId: number | null
  provider: any | null
  error: string | null
}

export const wallet = reactive<State>({
  name: null,
  icon: null,
  address: null,
  chainId: null,
  provider: null,
  error: null,
})

export const connected = computed(() => !!wallet.address)

/**
 * A request from somewhere else in the app to open the wallet list.
 *
 * Every form has a "Connect wallet" state on its own primary action, and a
 * button that names an action has to perform it. Rather than each form growing
 * its own copy of the wallet list, they raise this and the header's connect
 * control, which already owns that list, opens it.
 */
export const walletPicker = reactive({open: false})

export function askToConnect() {
  walletPicker.open = true
}

/** True when the wallet is pointed at a different chain than the node serves. */
export const wrongChain = computed(
  () => !!wallet.address && endpoint.chainId !== null && wallet.chainId !== endpoint.chainId,
)

const LAST = 'glyphswap.wallet'

export async function connectWallet(w: evm.Discovered) {
  wallet.error = null
  const chainId = endpoint.chainId
  if (chainId === null) throw new Error('No node connected. Choose a node first.')
  try {
    // A Syrius this page cannot rely on is refused before it is asked
    // anything, and any wallet's Zenon-account address after (syriusZvm.ts).
    const refused = refusal(w)
    if (refused) throw new Error(refused)
    const address = await evm.connect(w.provider, chainId)
    const badAccount = accountRefusal(address)
    if (badAccount) throw new Error(badAccount)
    wallet.name = w.name
    wallet.icon = walletIcon(w) || null
    wallet.address = address
    wallet.chainId = chainId
    wallet.provider = w.provider
    remember(w.name)
    w.provider.on?.('accountsChanged', followAccounts)
    w.provider.on?.('chainChanged', (id: string) => {
      wallet.chainId = Number(id)
    })
  } catch (err: any) {
    wallet.error = readable(err)
    throw err
  }
}

// The wallet moved to another account. One this page cannot use ends the
// connection with the reason on screen, rather than leaving the old address
// shown for an account the wallet no longer signs as.
function followAccounts(accounts: Address[]) {
  if (!accounts?.length) return disconnectWallet()
  const badAccount = accountRefusal(accounts[0])
  if (badAccount) {
    disconnectWallet()
    wallet.error = badAccount
    return
  }
  wallet.address = accounts[0]
}

export function disconnectWallet() {
  wallet.name = null
  wallet.icon = null
  wallet.address = null
  wallet.chainId = null
  wallet.provider = null
  remember(null)
}

/** Switches the connected wallet back to the chain this node serves. */
export async function switchToChain() {
  const chainId = endpoint.chainId
  if (chainId === null || !wallet.provider) return
  try {
    await evm.ensureChain(wallet.provider, chainId)
    wallet.chainId = chainId
    wallet.error = null
  } catch (err: any) {
    wallet.error = readable(err)
  }
}

const readable = (err: any): string => err?.shortMessage ?? err?.message ?? String(err)

function remember(name: string | null) {
  try {
    if (name) localStorage.setItem(LAST, name)
    else localStorage.removeItem(LAST)
  } catch {
    /* storage can be blocked; connecting still works for this tab */
  }
}

/**
 * Reconnects to the wallet used last, without a prompt.
 *
 * `eth_accounts` never opens the wallet: it answers with the accounts already
 * approved for this origin, and an empty list when there are none. So a person
 * who connected yesterday is connected on load, and a person who never did is
 * not asked.
 */
export async function restoreWallet() {
  let name: string | null = null
  try {
    name = localStorage.getItem(LAST)
  } catch {
    return
  }
  if (!name || endpoint.chainId === null) return
  const found = evm.requestWallets().find((w) => w.name === name)
  if (!found || refusal(found)) return
  try {
    const accounts: Address[] = await found.provider.request({method: 'eth_accounts'})
    if (!accounts?.length || accountRefusal(accounts[0])) return
    wallet.name = found.name
    wallet.icon = walletIcon(found) || null
    wallet.address = accounts[0]
    wallet.provider = found.provider
    wallet.chainId = Number(await found.provider.request({method: 'eth_chainId'}))
    found.provider.on?.('accountsChanged', followAccounts)
    found.provider.on?.('chainChanged', (id: string) => {
      wallet.chainId = Number(id)
    })
  } catch {
    /* a wallet that refuses eth_accounts simply stays disconnected */
  }
}

// Changing nodes can mean changing chains, and a balance read against the wrong
// one is worse than none. The address stays; the chain claim is re-read.
watch(
  () => endpoint.chainId,
  async () => {
    if (!wallet.provider) return
    try {
      wallet.chainId = Number(await wallet.provider.request({method: 'eth_chainId'}))
    } catch {
      /* leave the last known chain id */
    }
  },
)
