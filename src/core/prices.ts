// Glyphswap's dollar prices.
//
// The store, the types and the arithmetic are @zvm/web's, so that a token is
// worth the same here as in the explorer and the NFT market. What is this app's
// is where the prices come from, and whether they come at all.
//
// Glyphswap is the one ZVM app that can be pointed at a bare op-reth with no
// node in front of it — that is the whole reason its endpoint is a JSON-RPC URL
// and not an API base (endpoint.ts). Such an endpoint has no /api/prices, so
// `apiBase` is null and every price below is simply unknown. That is not an
// error state and the interface does not report it as one: a swap is priced by
// the pool's reserves, which the RPC always answers for. Dollars are context.

import {prices as shared, format} from '@zvm/web'

import {endpoint} from './endpoint'
import {tokenKey, type Token} from './uniswap'

const store = shared.createPrices(() => endpoint.apiBase)

export const prices = store.state
export const refreshPrices = () => store.refresh()
export const startPrices = (intervalMs = 30_000) => store.start(intervalMs)

export const znnUsd = () => store.znnUsd()
export const qsrUsd = () => store.qsrUsd()
export const pricesStale = () => store.stale()

/** One whole token's price: a 0x address, or 'znn' for ZNN itself. */
export const usdOf = (token: string | null | undefined) => store.usdOf(token)

/** What an amount is worth, or null when this token has no price. */
export const usdValue = (
  amount: bigint | string | number | null | undefined,
  decimals: number,
  token: string | null | undefined,
) => store.usdValue(amount, decimals, token)

/** Where a token's price came from, for a tooltip that does not overclaim. */
export const usdSource = (token: string | null | undefined) => store.usdSource(token)

/**
 * What an amount of a token is worth, or null when it has no price.
 *
 * `tokenKey` is already the key /api/prices uses — 'znn' for the native coin,
 * the lower-case address for everything else — because both sides answer the
 * same question: the native coin and the WETH9 the router wraps it in are one
 * asset, and pricing them separately would show a swap gaining or losing value
 * on the wrap.
 */
export function tokenUsd(
  token: Token | null | undefined,
  amount: bigint | string | number | null | undefined,
): number | null {
  if (!token) return null
  return store.usdValue(amount, token.decimals, tokenKey(token))
}

/** True when dollars are available at all: no node API, or -prices=off. */
export const usdAvailable = () => store.state.snap?.enabled === true

export const fmtUsd = format.usd
export const fmtChange = format.change
export const changeTone = format.changeTone

export type {PriceQuote, TokenPrice, PriceSnapshot} from '@zvm/web'
