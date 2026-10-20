// The deployment this interface is trading on, and everything read from it:
// which pools exist, what they hold, and what the connected account owns.
//
// Swap and Pool read the same state, so one refresh serves both, and it happens
// on the chain's beat rather than on a timer of its own.

import {computed, reactive, watch} from 'vue'
import type {Address} from 'viem'
import {endpoint} from './endpoint'
import {publicClient} from './evm'
import {chain, onBlock} from './chain'
import {wallet} from './wallet'
import {CHAINS, MULTICALL3, WQSR, overrideFor, type Deployment} from './chains'
import * as uni from './uniswap'

type Status = 'loading' | 'absent' | 'ready' | 'error'

interface DexState {
  status: Status
  error: string
  /** Where the addresses came from, which is worth saying when they look wrong. */
  source: 'settings' | 'node' | 'built in' | 'none'
  router: Address | null
  factory: Address | null
  weth: Address | null
  officialPair: Address | null
  tokens: uni.Token[]
  pools: uni.Pool[]
  balances: Record<string, bigint>
  /** LP balances, index-aligned with pools. */
  lp: bigint[]
  /** Addresses someone pasted in, kept per chain. */
  imported: Address[]
}

export const dex = reactive<DexState>({
  status: 'loading',
  error: '',
  source: 'none',
  router: null,
  factory: null,
  weth: null,
  officialPair: null,
  tokens: [],
  pools: [],
  balances: {},
  lp: [],
  imported: [],
})

const client = () => publicClient(endpoint.chainId!)

/** Tokens a two hop route is allowed to pass through. */
export const hubs = computed<Address[]>(() => {
  const out: Address[] = []
  if (dex.weth) out.push(dex.weth)
  if (dex.pools.some((p) => uni.same(p.token0, WQSR) || uni.same(p.token1, WQSR))) out.push(WQSR)
  return out
})

export function tokenByKey(key: string): uni.Token | undefined {
  return dex.tokens.find((t) => uni.tokenKey(t) === key)
}

export function tokenByAddress(address: string): uni.Token | undefined {
  // The ERC-20 spelling, never ZNN: a pool holds WZNN.
  return dex.tokens.find((t) => !t.native && uni.same(t.address, address))
}

/**
 * What to call one side of a pool.
 *
 * A pool holds wrapped ZNN, and the contract really is WZNN, but nobody calls
 * the pair anything other than ZNN and QSR. So wherever the subject is a *side
 * of a pool* this says ZNN, and WZNN is kept for where the token itself is the
 * subject: the token list, a balance you hold, and the pill on a field you can
 * change.
 */
export function sideSymbol(address: string | undefined): string {
  if (!address) return ''
  if (dex.weth && uni.same(address, dex.weth)) return 'ZNN'
  return tokenByAddress(address)?.symbol ?? ''
}

/**
 * Whether this is one of the tokens the chain itself ships.
 *
 * Checked by address, never by symbol. Anyone can deploy a contract that calls
 * itself ZNN, and a tick that trusted the symbol would be worse than no tick at
 * all: the native coin, the WETH9 the router routes ZNN through, and the QSR
 * predeploy are canonical here, and nothing else is.
 */
export function isCanonical(token: uni.Token): boolean {
  if (token.native) return true
  if (dex.weth && uni.same(token.address, dex.weth)) return true
  return uni.same(token.address, WQSR)
}

/** ZNN, then QSR, then wrapped ZNN, then everything else. */
export function canonicalRank(token: uni.Token): number {
  if (token.native) return 0
  if (uni.same(token.address, WQSR)) return 1
  if (dex.weth && uni.same(token.address, dex.weth)) return 2
  return 3
}

export function poolByAddress(address: string): uni.Pool | undefined {
  return dex.pools.find((p) => uni.same(p.pair, address))
}

/** The pair this chain opens on, when it has one. */
export const officialPool = computed(() => (dex.officialPair ? poolByAddress(dex.officialPair) : undefined))

// --- imported tokens --------------------------------------------------------

const IMPORT_KEY = 'glyphswap.imported'

function readImports(chainId: number): Address[] {
  try {
    const all = JSON.parse(localStorage.getItem(IMPORT_KEY) ?? '{}')
    return all[String(chainId)] ?? []
  } catch {
    return []
  }
}

function writeImports(chainId: number, list: Address[]) {
  try {
    const all = JSON.parse(localStorage.getItem(IMPORT_KEY) ?? '{}')
    all[String(chainId)] = list
    localStorage.setItem(IMPORT_KEY, JSON.stringify(all))
  } catch {
    /* storage can be blocked; the import still holds for this tab */
  }
}

// --- resolving the deployment ----------------------------------------------

/** Asks a zvm node for the deployment it was started with. Absent elsewhere. */
async function fromNode(): Promise<Partial<Deployment> | null> {
  if (!endpoint.apiBase) return null
  try {
    const res = await fetch(`${endpoint.apiBase}/api/info`, {
      headers: {accept: 'application/json'},
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const body = await res.json()
    const u = body?.uniswapV2
    if (!u?.router || !u?.factory || !u?.weth) return null
    return {
      factory: u.factory,
      router: u.router,
      weth: u.weth,
      officialPair: body?.apps?.znnQsrPair ?? undefined,
      tokens: Array.isArray(u.tokens) ? u.tokens : undefined,
    }
  } catch {
    return null
  }
}

async function resolve(chainId: number): Promise<{d: Deployment; source: DexState['source']} | null> {
  const saved = overrideFor(chainId)
  if (saved?.router && saved?.factory && saved?.weth) return {d: saved as Deployment, source: 'settings'}

  const node = await fromNode()
  if (node?.router && node?.factory && node?.weth) return {d: node as Deployment, source: 'node'}

  const built = CHAINS[chainId]?.deployment
  if (built) return {d: built, source: 'built in'}
  return null
}

// --- loading ----------------------------------------------------------------

let loadToken = 0

export async function loadDex(): Promise<void> {
  const chainId = endpoint.chainId
  if (chainId === null) return
  const mine = ++loadToken
  dex.status = 'loading'
  dex.error = ''
  try {
    const found = await resolve(chainId)
    if (mine !== loadToken) return
    if (!found) {
      dex.source = 'none'
      dex.status = 'absent'
      return
    }
    const {d, source} = found
    // A stale address is the usual failure after a devnet is re-genesised, and
    // it deserves its own sentence rather than a hundred failed reads.
    const code = await client().getCode({address: d.router})
    if (mine !== loadToken) return
    if (!code || code === '0x') {
      dex.source = source
      dex.status = 'absent'
      dex.error = `No router at ${d.router} on chain ${chainId}.`
      return
    }
    dex.source = source
    dex.router = d.router
    dex.factory = d.factory
    dex.weth = d.weth
    dex.officialPair = d.officialPair ?? null
    dex.imported = readImports(chainId)

    const pools = await uni.loadPools(client(), MULTICALL3, d.factory)
    if (mine !== loadToken) return
    const listed = [...(d.tokens ?? []), WQSR, ...dex.imported, ...pools.flatMap((p) => [p.token0, p.token1])]
    const tokens = await uni.loadTokens(client(), MULTICALL3, d.weth, listed)
    if (mine !== loadToken) return
    dex.tokens = [uni.nativeToken(d.weth), ...tokens.sort(order(d))]
    dex.pools = pools
    dex.status = 'ready'
    await refreshAccount()
  } catch (err: any) {
    if (mine !== loadToken) return
    dex.status = 'error'
    dex.error = err?.shortMessage ?? err?.message ?? String(err)
  }
}

/** QSR first, then everything else by symbol, with wrapped ZNN last: it is ZNN's plumbing. */
function order(d: Deployment) {
  return (a: uni.Token, b: uni.Token) => {
    const rank = (t: uni.Token) => (uni.same(t.address, d.weth) ? 2 : uni.same(t.address, WQSR) ? 0 : 1)
    return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol)
  }
}

export async function refreshAccount(): Promise<void> {
  const owner = wallet.address
  if (!owner || dex.status !== 'ready') {
    dex.balances = {}
    dex.lp = []
    return
  }
  const [balances, lp] = await Promise.all([
    uni.loadBalances(client(), MULTICALL3, owner, dex.tokens),
    uni.lpBalances(client(), MULTICALL3, owner, dex.pools),
  ])
  dex.balances = balances
  dex.lp = lp
}

/** Reserves move on every block that trades, so this runs on the beat. */
export async function refreshPools(): Promise<void> {
  if (dex.status !== 'ready' || !dex.factory || !dex.weth) return
  const pools = await uni.loadPools(client(), MULTICALL3, dex.factory)
  const known = new Set(dex.tokens.map((t) => t.address.toLowerCase()))
  const unseen = pools.flatMap((p) => [p.token0, p.token1]).filter((a) => !known.has(a.toLowerCase()))
  if (unseen.length) dex.tokens.push(...(await uni.loadTokens(client(), MULTICALL3, dex.weth, unseen)))
  dex.pools = pools
  await refreshAccount()
}

/** Adds a token someone pasted, and returns it. */
export async function importToken(address: string): Promise<uni.Token> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error('That is not a contract address.')
  const addr = address.trim() as Address
  const existing = tokenByAddress(addr)
  if (existing) return existing
  const [token] = await uni.loadTokens(client(), MULTICALL3, dex.weth!, [addr])
  if (!token) throw new Error('Nothing at that address answers decimals(), so it is not an ERC-20.')
  dex.tokens.push(token)
  dex.imported = [...dex.imported, token.address]
  if (endpoint.chainId !== null) writeImports(endpoint.chainId, dex.imported)
  await refreshAccount()
  return token
}

export function forgetToken(address: Address) {
  dex.tokens = dex.tokens.filter((t) => t.native || !uni.same(t.address, address))
  dex.imported = dex.imported.filter((a) => !uni.same(a, address))
  if (endpoint.chainId !== null) writeImports(endpoint.chainId, dex.imported)
}

// --- comparing pools --------------------------------------------------------

/**
 * A pool's size, priced in ZNN, so pools of unrelated tokens can be ranked
 * against each other without any price feed.
 *
 * A pool that holds wrapped ZNN is worth twice its ZNN side, because a constant
 * product pool holds equal value on both. A pool that does not is worth what
 * its tokens fetch in their own ZNN pool, when one exists. When neither side
 * has a route to ZNN there is no honest number, so it returns null rather than
 * a zero that would sort like a real answer.
 */
export function liquidityInZnn(pool: uni.Pool): number | null {
  const weth = dex.weth
  if (!weth) return null
  const asZnn = (side: Address, reserve: bigint): number | null => {
    const token = tokenByAddress(side)
    if (!token) return null
    const amount = Number(reserve) / 10 ** token.decimals
    if (uni.same(side, weth)) return amount
    const znnPool = uni.poolFor(dex.pools, side, weth)
    if (!znnPool) return null
    const [rSide, rZnn] = uni.reservesFor(znnPool, side)
    if (rSide === 0n) return null
    const znn = tokenByAddress(weth)
    if (!znn) return null
    const priceInZnn = (Number(rZnn) / 10 ** znn.decimals) / (Number(rSide) / 10 ** token.decimals)
    return amount * priceInZnn
  }
  const a = asZnn(pool.token0, pool.reserve0)
  const b = asZnn(pool.token1, pool.reserve1)
  if (a !== null && b !== null) return a + b
  if (a !== null) return a * 2
  if (b !== null) return b * 2
  return null
}

// --- wiring -----------------------------------------------------------------

export function startDex() {
  watch(() => endpoint.chainId, () => void loadDex(), {immediate: true})
  watch(() => wallet.address, () => void refreshAccount())
  onBlock(() => {
    if (dex.status === 'ready') void refreshPools()
  })
  // The beat is the refresh, so nothing polls reserves on a second clock.
  void chain
}
