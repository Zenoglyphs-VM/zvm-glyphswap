// Uniswap V2 on the ZVM: the contracts deployed from Uniswap's published
// artifacts, unmodified, driven from this page. Nothing here knows it is on a
// rollup. "ETH" in the router's function names is the chain's native coin,
// which here is ZNN, and WETH9 is wrapped ZNN.
//
// Quotes are computed locally from reserves with the router's own formula
// (UniswapV2Library.getAmountOut), so typing costs no round trip; the minimum a
// transaction will accept is re-quoted on chain just before it is sent.

import {encodeFunctionData, parseAbi, parseUnits, type Address, type Hex} from 'viem'
import type {publicClient} from './evm'

type Client = ReturnType<typeof publicClient>

export const routerAbi = parseAbi([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function removeLiquidityETHSupportingFeeOnTransferTokens(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint amountETH)',
  'function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB, uint liquidity)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB)',
  'function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint amountToken, uint amountETH)',
  'function factory() view returns (address)',
  'function WETH() view returns (address)',
])

export const factoryAbi = parseAbi([
  'function allPairs(uint) view returns (address)',
  'function allPairsLength() view returns (uint)',
  'function getPair(address tokenA, address tokenB) view returns (address)',
])

export const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint)',
  'function balanceOf(address) view returns (uint)',
  'function approve(address spender, uint amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint)',
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint amount0, uint amount1)',
  'event Burn(address indexed sender, uint amount0, uint amount1, address indexed to)',
])

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint)',
  'function balanceOf(address) view returns (uint)',
  'function allowance(address owner, address spender) view returns (uint)',
  'function approve(address spender, uint amount) returns (bool)',
])

const wethAbi = parseAbi(['function deposit() payable', 'function withdraw(uint wad)'])

// A token that takes a cut of its own transfers to and from a pair, and says
// how much: BULLET's shape, buyTaxBps on a transfer out of the pair and
// sellTaxBps on one into it. It is not a standard, so a token without these
// reads is taken to have no tax, and one with them is believed.
const taxAbi = parseAbi(['function buyTaxBps() view returns (uint)', 'function sellTaxBps() view returns (uint)'])

/** What a UniswapV2Pair charges, in basis points. */
export const FEE_BPS = 30

// --- tokens ----------------------------------------------------------------

export interface Token {
  /** The contract. For ZNN itself this is WETH9, which the router routes it through. */
  address: Address
  symbol: string
  name: string
  decimals: number
  native?: boolean
  /** The token's own transfer tax, when it publishes one, in basis points. */
  tax?: {buyBps: number; sellBps: number}
}

/** What arrives of `amount` after a tax of `bps`, rounded down as the token rounds its tax. */
export const afterTax = (amount: bigint, bps: number) => amount - (amount * BigInt(bps)) / 10_000n

/**
 * Whether a swap has to use the router's fee-on-transfer functions. The plain
 * ones hand the pair less than they told it to expect, and the pair's K check
 * reverts; the fee-on-transfer ones measure what actually arrived.
 */
export const hasTax = (t?: Token) => !!t?.tax && (t.tax.buyBps > 0 || t.tax.sellBps > 0)

export const tokenKey = (t: Token) => (t.native ? 'znn' : t.address.toLowerCase())
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function nativeToken(weth: Address): Token {
  return {address: weth, symbol: 'ZNN', name: 'Zenon', decimals: 18, native: true}
}

/** Reads symbol, name and decimals; an address that has no decimals is not offered. */
export async function loadTokens(client: Client, multicall: Address, weth: Address, addresses: string[]): Promise<Token[]> {
  const unique = [...new Map(addresses.map((a) => [a.toLowerCase(), a as Address])).values()]
  if (!unique.length) return []
  const res = (await client.multicall({
    multicallAddress: multicall,
    allowFailure: true,
    contracts: unique.flatMap((address) => [
      {address, abi: erc20Abi, functionName: 'symbol'},
      {address, abi: erc20Abi, functionName: 'name'},
      {address, abi: erc20Abi, functionName: 'decimals'},
      {address, abi: taxAbi, functionName: 'buyTaxBps'},
      {address, abi: taxAbi, functionName: 'sellTaxBps'},
    ]) as any,
  })) as any[]
  const out: Token[] = []
  unique.forEach((address, i) => {
    const [symbol, name, decimals, buy, sell] = res.slice(i * 5, i * 5 + 5)
    if (decimals?.status !== 'success') return
    // WETH9 calls itself Wrapped Ether wherever it is deployed.
    const isWeth = same(address, weth)
    const token: Token = {
      address,
      symbol: isWeth ? 'WZNN' : symbol.status === 'success' ? String(symbol.result) : '???',
      name: isWeth ? 'Wrapped ZNN' : name.status === 'success' ? String(name.result) : 'Unnamed token',
      decimals: Number(decimals.result),
    }
    if (buy?.status === 'success' && sell?.status === 'success' && buy.result <= 10_000n && sell.result <= 10_000n) {
      token.tax = {buyBps: Number(buy.result), sellBps: Number(sell.result)}
    }
    out.push(token)
  })
  return out
}

/** Balances keyed by tokenKey. ZNN is the account's own balance, not WETH9's. */
export async function loadBalances(client: Client, multicall: Address, owner: Address, tokens: Token[]): Promise<Record<string, bigint>> {
  const erc20s = tokens.filter((t) => !t.native)
  const [native, res] = await Promise.all([
    client.getBalance({address: owner}),
    erc20s.length
      ? (client.multicall({
          multicallAddress: multicall,
          allowFailure: true,
          contracts: erc20s.map((t) => ({address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner]})) as any,
        }) as Promise<any[]>)
      : Promise.resolve([] as any[]),
  ])
  const out: Record<string, bigint> = {znn: native}
  erc20s.forEach((t, i) => {
    if (res[i]?.status === 'success') out[tokenKey(t)] = res[i].result as bigint
  })
  return out
}

export async function allowance(client: Client, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender]})
}

// --- pools -----------------------------------------------------------------

export interface Pool {
  pair: Address
  token0: Address
  token1: Address
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
}

export async function loadPools(client: Client, multicall: Address, factory: Address, limit = 200): Promise<Pool[]> {
  const n = await client.readContract({address: factory, abi: factoryAbi, functionName: 'allPairsLength'})
  const count = Math.min(Number(n), limit)
  if (!count) return []
  const pairs = (await client.multicall({
    multicallAddress: multicall,
    allowFailure: false,
    contracts: Array.from({length: count}, (_, i) => ({
      address: factory,
      abi: factoryAbi,
      functionName: 'allPairs',
      args: [BigInt(i)],
    })) as any,
  })) as Address[]
  const res = (await client.multicall({
    multicallAddress: multicall,
    allowFailure: false,
    contracts: pairs.flatMap((address) => [
      {address, abi: pairAbi, functionName: 'token0'},
      {address, abi: pairAbi, functionName: 'token1'},
      {address, abi: pairAbi, functionName: 'getReserves'},
      {address, abi: pairAbi, functionName: 'totalSupply'},
    ]) as any,
  })) as any[]
  return pairs.map((pair, i) => {
    const [token0, token1, reserves, totalSupply] = res.slice(i * 4, i * 4 + 4)
    return {pair, token0, token1, reserve0: reserves[0], reserve1: reserves[1], totalSupply}
  })
}

export async function lpBalances(client: Client, multicall: Address, owner: Address, pools: Pool[]): Promise<bigint[]> {
  if (!pools.length) return []
  return (await client.multicall({
    multicallAddress: multicall,
    allowFailure: false,
    contracts: pools.map((p) => ({address: p.pair, abi: pairAbi, functionName: 'balanceOf', args: [owner]})) as any,
  })) as bigint[]
}

export function poolFor(pools: Pool[], a: Address, b: Address): Pool | undefined {
  return pools.find((p) => (same(p.token0, a) && same(p.token1, b)) || (same(p.token0, b) && same(p.token1, a)))
}

/** [reserve of `token`, reserve of the other side]. */
export function reservesFor(pool: Pool, token: Address): [bigint, bigint] {
  return same(pool.token0, token) ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0]
}

// --- quoting and routing ---------------------------------------------------

/** UniswapV2Library.getAmountOut: the constant product, less the 0.3% fee. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const inWithFee = amountIn * 997n
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee)
}

export function amountsOut(pools: Pool[], amountIn: bigint, path: Address[]): bigint[] | null {
  const amounts = [amountIn]
  for (let i = 0; i < path.length - 1; i++) {
    const pool = poolFor(pools, path[i], path[i + 1])
    if (!pool) return null
    const [rIn, rOut] = reservesFor(pool, path[i])
    const out = getAmountOut(amounts[i], rIn, rOut)
    if (out <= 0n) return null
    amounts.push(out)
  }
  return amounts
}

/** How far a trade's price falls short of the pools' price before it, with the 0.3% fee left out. */
export function priceImpact(pools: Pool[], path: Address[], amountIn: bigint, amountOut: bigint): number {
  let mid = Number(amountIn)
  for (let i = 0; i < path.length - 1; i++) {
    const pool = poolFor(pools, path[i], path[i + 1])
    if (!pool) return 0
    const [rIn, rOut] = reservesFor(pool, path[i])
    mid = (mid * Number(rOut)) / Number(rIn)
  }
  const beforeFee = Number(amountOut) / Math.pow(0.997, path.length - 1)
  return mid > 0 ? Math.max(0, 1 - beforeFee / mid) : 0
}

export type Route =
  | {kind: 'wrap' | 'unwrap'; path: Address[]; amountOut: bigint; impact: number}
  | {kind: 'swap'; path: Address[]; amountOut: bigint; impact: number; tax?: {inBps: number; outBps: number}}

/**
 * The direct pool, or two hops through a hub token, whichever pays more.
 * ZNN to WZNN and back is the same contract spelled twice, so it is a wrap,
 * not a swap.
 */
export function bestRoute(pools: Pool[], hubs: Address[], tokenIn: Token, tokenOut: Token, amountIn: bigint): Route | null {
  if (amountIn <= 0n || tokenKey(tokenIn) === tokenKey(tokenOut)) return null
  if (same(tokenIn.address, tokenOut.address)) {
    return {kind: tokenIn.native ? 'wrap' : 'unwrap', path: [], amountOut: amountIn, impact: 0}
  }
  const candidates: Address[][] = [[tokenIn.address, tokenOut.address]]
  for (const hub of hubs) {
    if (same(tokenIn.address, hub) || same(tokenOut.address, hub)) continue
    candidates.push([tokenIn.address, hub, tokenOut.address])
  }
  // A taxed token loses its cut on the way into the first pair, or on the way
  // out of the last one. The pools only ever see what is left, so that is what
  // they are quoted on, and the price impact is measured before the tax: the
  // tax is not the pool moving.
  const intoPool = tokenIn.tax ? afterTax(amountIn, tokenIn.tax.sellBps) : amountIn
  let best: bigint[] | null = null
  let bestPath: Address[] = []
  for (const path of candidates) {
    const amounts = amountsOut(pools, intoPool, path)
    if (amounts && (!best || amounts[amounts.length - 1] > best[best.length - 1])) {
      best = amounts
      bestPath = path
    }
  }
  if (!best) return null
  const outOfPool = best[best.length - 1]
  const amountOut = tokenOut.tax ? afterTax(outOfPool, tokenOut.tax.buyBps) : outOfPool
  const route: Route = {kind: 'swap', path: bestPath, amountOut, impact: priceImpact(pools, bestPath, intoPool, outOfPool)}
  if (hasTax(tokenIn) || hasTax(tokenOut)) route.tax = {inBps: tokenIn.tax?.sellBps ?? 0, outBps: tokenOut.tax?.buyBps ?? 0}
  return route
}

/** The router's quote, with a taxed token's cut taken off the way bestRoute takes it. */
export async function quoteOnChain(client: Client, router: Address, amountIn: bigint, path: Address[], tokenIn?: Token, tokenOut?: Token): Promise<bigint> {
  const intoPool = tokenIn?.tax ? afterTax(amountIn, tokenIn.tax.sellBps) : amountIn
  const amounts = await client.readContract({address: router, abi: routerAbi, functionName: 'getAmountsOut', args: [intoPool, path]})
  const outOfPool = amounts[amounts.length - 1]
  return tokenOut?.tax ? afterTax(outOfPool, tokenOut.tax.buyBps) : outOfPool
}

/** UniswapV2Library.quote: the other side of a deposit at the pool's current ratio. */
export function quote(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  return reserveA > 0n ? (amountA * reserveB) / reserveA : 0n
}

/** What burning `liquidity` pays out, as [token0, token1]. */
export function burnAmounts(pool: Pool, liquidity: bigint): [bigint, bigint] {
  if (pool.totalSupply === 0n) return [0n, 0n]
  return [(liquidity * pool.reserve0) / pool.totalSupply, (liquidity * pool.reserve1) / pool.totalSupply]
}

export function parseAmount(s: string, decimals: number): bigint | null {
  const t = s.trim().replace(/,/g, '')
  if (!t || t === '.' || !/^\d*\.?\d*$/.test(t)) return null
  try {
    return parseUnits(t, decimals)
  } catch {
    return null
  }
}

export const slip = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n
export const deadlineIn = (minutes: number) => BigInt(Math.floor(Date.now() / 1000) + minutes * 60)

/** Never asks for more than this trade needs: an infinite approval is a standing risk. */
export const MAX_UINT = (1n << 256n) - 1n

// --- calls -----------------------------------------------------------------

export interface Call {
  to: Address
  data: Hex
  value: bigint
  /** A generous limit, used only where estimating is impossible. */
  gas: bigint
  label: string
}

export function approveCall(token: {address: Address; symbol: string}, spender: Address, amount: bigint): Call {
  return {
    to: token.address,
    value: 0n,
    gas: 70_000n,
    label: `Approve ${token.symbol}`,
    data: encodeFunctionData({abi: erc20Abi, functionName: 'approve', args: [spender, amount]}),
  }
}

export function swapCall(
  router: Address,
  tokenIn: Token,
  tokenOut: Token,
  route: Route,
  amountIn: bigint,
  minOut: bigint,
  to: Address,
  deadline: bigint,
): Call {
  if (route.kind === 'wrap') {
    return {to: tokenIn.address, value: amountIn, gas: 60_000n, label: 'Wrap ZNN', data: encodeFunctionData({abi: wethAbi, functionName: 'deposit'})}
  }
  if (route.kind === 'unwrap') {
    return {
      to: tokenIn.address,
      value: 0n,
      gas: 70_000n,
      label: 'Unwrap WZNN',
      data: encodeFunctionData({abi: wethAbi, functionName: 'withdraw', args: [amountIn]}),
    }
  }
  const label = `Swap ${tokenIn.symbol} for ${tokenOut.symbol}`
  const gas = 120_000n + 80_000n * BigInt(route.path.length - 1)
  // minOut is checked against what the recipient actually received, after
  // the tax, by the fee-on-transfer functions; bestRoute quotes the same.
  const fot = hasTax(tokenIn) || hasTax(tokenOut)
  if (tokenIn.native) {
    return {
      to: router,
      value: amountIn,
      gas,
      label,
      data: fot
        ? encodeFunctionData({abi: routerAbi, functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens', args: [minOut, route.path, to, deadline]})
        : encodeFunctionData({abi: routerAbi, functionName: 'swapExactETHForTokens', args: [minOut, route.path, to, deadline]}),
    }
  }
  const functionName = fot
    ? tokenOut.native
      ? 'swapExactTokensForETHSupportingFeeOnTransferTokens'
      : 'swapExactTokensForTokensSupportingFeeOnTransferTokens'
    : tokenOut.native
      ? 'swapExactTokensForETH'
      : 'swapExactTokensForTokens'
  return {
    to: router,
    value: 0n,
    gas,
    label,
    data: encodeFunctionData({abi: routerAbi, functionName, args: [amountIn, minOut, route.path, to, deadline]}),
  }
}

export interface AddOptions {
  /** No pair exists: the router creates it, which costs about 2.5 M gas. */
  createsPair: boolean
  /** The pool is empty, so this deposit sets its price and must not be trimmed. */
  setsPrice: boolean
  slippageBps: number
}

export function addLiquidityCall(
  router: Address,
  a: Token,
  b: Token,
  amountA: bigint,
  amountB: bigint,
  to: Address,
  deadline: bigint,
  o: AddOptions,
): Call {
  const gas = o.createsPair ? 3_300_000n : 260_000n
  const label = `${o.createsPair ? 'Create' : 'Add to'} the ${a.symbol} and ${b.symbol} pool`
  const min = (x: bigint) => (o.setsPrice ? x : slip(x, o.slippageBps))
  if (a.native || b.native) {
    const [token, amountToken, amountZnn] = a.native ? [b, amountB, amountA] : [a, amountA, amountB]
    return {
      to: router,
      value: amountZnn,
      gas,
      label,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: 'addLiquidityETH',
        args: [token.address, amountToken, min(amountToken), min(amountZnn), to, deadline],
      }),
    }
  }
  return {
    to: router,
    value: 0n,
    gas,
    label,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'addLiquidity',
      args: [a.address, b.address, amountA, amountB, min(amountA), min(amountB), to, deadline],
    }),
  }
}

/** Withdraws liquidity. A pool with wrapped ZNN on one side pays that side out as ZNN. */
export function removeLiquidityCall(
  router: Address,
  weth: Address,
  pool: Pool,
  label: string,
  liquidity: bigint,
  slippageBps: number,
  to: Address,
  deadline: bigint,
  asNative = true,
  taxed = false,
): Call {
  const [out0, out1] = burnAmounts(pool, liquidity)
  const gas = 300_000n
  if (asNative && (same(pool.token0, weth) || same(pool.token1, weth))) {
    const znnIs0 = same(pool.token0, weth)
    const [token, amountToken, amountZnn] = znnIs0 ? [pool.token1, out1, out0] : [pool.token0, out0, out1]
    // removeLiquidityETH has the pair pay the router, then forwards exactly the
    // amount the pair burned; a taxed token reaches the router short, so the
    // forward reverts. The fee-on-transfer version forwards what arrived. Its
    // minimums are checked on the burn, before the tax, as the plain one's are.
    return {
      to: router,
      value: 0n,
      gas,
      label,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: taxed ? 'removeLiquidityETHSupportingFeeOnTransferTokens' : 'removeLiquidityETH',
        args: [token, liquidity, slip(amountToken, slippageBps), slip(amountZnn, slippageBps), to, deadline],
      }),
    }
  }
  return {
    to: router,
    value: 0n,
    gas,
    label,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'removeLiquidity',
      args: [pool.token0, pool.token1, liquidity, slip(out0, slippageBps), slip(out1, slippageBps), to, deadline],
    }),
  }
}

export function approvePairCall(pair: Address, spender: Address, amount: bigint, label: string): Call {
  return {
    to: pair,
    value: 0n,
    gas: 70_000n,
    label,
    data: encodeFunctionData({abi: pairAbi, functionName: 'approve', args: [spender, amount]}),
  }
}
