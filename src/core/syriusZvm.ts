// Syrius as a ZVM wallet, and whether the Syrius in this browser is one this
// page can use.
//
// Syrius 0.4.0 and later holds an EVM account beside each Zenon account — the
// BIP-44 Ethereum key from the same recovery phrase — and announces it through
// EIP-6963 like any EVM wallet, so the ordinary wallet path (wallet.ts)
// connects it, switches it to this chain and signs through it. What this adds
// is knowing which announced wallet is Syrius, so the picker can put it first,
// and refusing a Syrius this page cannot rely on.
//
// The wallet says what it supports in `provider.syrius.zvm`
// (syrius-extension src/sections/Inpage/ethereum.js). Version 1 means the
// account a page sees on the ZVM is always the Ethereum key's. Early 0.4.0
// builds had no such field and could hand a page the Zenon account's own
// 0x00… address instead: it cannot sign messages, cannot pay ZVM gas through
// the relayer, and every transaction from it is a Zenon block on a different
// lane. A trade sent that way is not the trade this page quoted, so those
// builds are refused rather than half-supported.
//
// `zvm` is the field decided on, never `version`: a version string says which
// release it is, not what it promises, and a development build carries the
// release it is heading for.

import type {Address} from 'viem'
// The extension's own icon (syrius-extension src/assets/img/icon-128.png),
// copied here so a Syrius row has it even when nothing announced one: not
// installed, too old, or an early build that announced a placeholder mark.
import syriusIcon from '../assets/syrius.png'
import {isNomUser} from '@zvm/web/address'
import type {Discovered} from './evm'
import {providerPresent} from './syrius'

/** Where the extension's source and releases are. */
export const SYRIUS_URL = 'https://github.com/MichZNN/syrius-extension'

/** The lowest `provider.syrius.zvm` this page works with. */
export const REQUIRED_ZVM = 1

export const SYRIUS_ICON: string = syriusIcon

/** The flag Syrius's EIP-1193 provider carries (it never claims isMetaMask). */
export const isSyrius = (w: Discovered): boolean => w.provider?.isSyrius === true

/** The icon to show for a wallet: Syrius's own for Syrius, whatever it announced otherwise. */
export const walletIcon = (w: Discovered): string => (isSyrius(w) ? SYRIUS_ICON : w.icon)

/** What a Syrius provider declares, or null for a build that declares nothing. */
function declared(w: Discovered): {version: string | null; zvm: number} | null {
  const info = w.provider?.syrius
  if (!info || typeof info.zvm !== 'number') return null
  return {version: typeof info.version === 'string' ? info.version : null, zvm: info.zvm}
}

export type SyriusState =
  | {kind: 'ready'; wallet: Discovered; version: string | null}
  // Syrius announced an EVM account, but one this page cannot rely on.
  | {kind: 'outdated'; wallet: Discovered; reason: string}
  // window.zenon answers, but nothing announces an EVM account: Syrius before 0.4.0.
  | {kind: 'zenonOnly'}
  | {kind: 'missing'}

export function syriusState(wallets: Discovered[]): SyriusState {
  const wallet = wallets.find(isSyrius)
  if (!wallet) return providerPresent() ? {kind: 'zenonOnly'} : {kind: 'missing'}
  const info = declared(wallet)
  if (!info) {
    return {
      kind: 'outdated',
      wallet,
      reason: 'This Syrius is an early 0.4.0 build that can show sites its Zenon account instead of its EVM account. Update it.',
    }
  }
  if (info.zvm < REQUIRED_ZVM) {
    return {kind: 'outdated', wallet, reason: `This Syrius${info.version ? ` (${info.version})` : ''} is too old for this page. Update it.`}
  }
  return {kind: 'ready', wallet, version: info.version}
}

/** Why this wallet must not be connected, or null when it may. */
export function refusal(w: Discovered): string | null {
  if (!isSyrius(w)) return null
  const state = syriusState([w])
  return state.kind === 'outdated' ? state.reason : null
}

/**
 * Why an account a wallet handed over must not be used, or null.
 *
 * Whatever the wallet claims, an address whose first byte is 0x00 is a Zenon
 * account's own 20 bytes: no Ethereum key signs for it, so a transaction this
 * page asks for cannot come from it. Checked for every wallet, not only Syrius.
 */
export function accountRefusal(address: Address | undefined | null): string | null {
  if (!address || !isNomUser(address)) return null
  return 'The wallet offered a Zenon account address (0x00…), which cannot sign EVM transactions. Choose its EVM account, or update Syrius.'
}

/** Syrius first, then the rest in the order they announced. */
export const syriusFirst = (wallets: Discovered[]): Discovered[] => [
  ...wallets.filter(isSyrius),
  ...wallets.filter((w) => !isSyrius(w)),
]
