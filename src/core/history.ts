// A pair's recent life, read from its own logs.
//
// There is no indexer behind this page, so the chart and the trade list are
// built from `Swap` events fetched straight from the node. That is affordable
// here for a reason worth knowing: one momentum is one block, so a day of this
// chain is a few thousand blocks rather than a few hundred thousand.
//
// Prices come from each trade's own amounts, which is the price that was
// actually paid, rather than from reserves sampled afterwards.

import type {Address} from 'viem'
import {parseAbiItem, type Log} from 'viem'
import {publicClient} from './evm'
import {reservesFor, type Pool, type Token} from './uniswap'

const swapEvent = parseAbiItem(
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
)

export interface Trade {
  hash: string
  block: number
  time: number
  /** Whether the trade bought the base token or sold it. */
  side: 'buy' | 'sell'
  /** Base token moved, in base units. */
  baseAmount: bigint
  /** Quote token moved, in quote units. */
  quoteAmount: bigint
  /** Quote per base. */
  price: number
  taker: Address
}

export interface PairHistory {
  trades: Trade[]
  /** Oldest first, for the chart. */
  series: {time: number; price: number}[]
  volume24hBase: bigint
  trades24h: number
  /** Change against the oldest trade inside the window, as a fraction. */
  change24h: number | null
  /** How far back the scan actually reached. */
  fromBlock: number
  toBlock: number
  /** The most recent trade of any age, so an empty window can say how long it has been. */
  lastTradeAt: number | null
  /**
   * True only when every block back to genesis was read and none held a trade.
   * A window with no trades in it proves nothing about the pair, so this is
   * never inferred from an empty scan of anything shorter.
   */
  neverTraded: boolean
}

/**
 * The spans the chart offers. Zero hours means everything the node still has.
 *
 * `span` is the same period written out, because the stats beside the chart are
 * measured over whichever window is selected and a caption that says "24 hours"
 * under an all-time chart is simply wrong.
 */
export const WINDOWS = [
  {hours: 1, label: '1h', span: 'last hour'},
  {hours: 24, label: '24h', span: 'last 24 hours'},
  {hours: 24 * 7, label: '7d', span: 'last 7 days'},
  {hours: 0, label: 'All', span: 'all time'},
]

export const spanOf = (hours: number) => WINDOWS.find((w) => w.hours === hours)?.span ?? 'last 24 hours'

/** One getLogs call cannot span the whole chain on every node, so it is chunked. */
const CHUNK = 5000n

type Client = ReturnType<typeof publicClient>

/**
 * A pair's Swap logs over [from, to], in block order.
 *
 * A node caps how many results one call returns (20,000 on the devnet node),
 * and the fleet benchmark's pair passes that in far fewer than a chunk's worth
 * of blocks. A capped range is split in half until each half fits, rather than
 * failing the whole window.
 */
async function getLogsChunked(client: Client, address: Address, from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = []
  const read = async (start: bigint, end: bigint): Promise<void> => {
    try {
      out.push(...((await client.getLogs({address, event: swapEvent, fromBlock: start, toBlock: end})) as Log[]))
    } catch (err: any) {
      if (end <= start || !/max results|too many|limit/i.test(`${err?.details ?? ''} ${err?.message ?? ''}`)) throw err
      const mid = start + (end - start) / 2n
      await read(start, mid)
      await read(mid + 1n, end)
    }
  }
  for (let start = from; start <= to; start += CHUNK) await read(start, start + CHUNK - 1n > to ? to : start + CHUNK - 1n)
  return out
}

interface Span {
  from: bigint
  to: bigint
  logs: Log[]
}

/**
 * The Swap logs already read, per chain and pair.
 *
 * Both pages reload on every block, and before this each reload read the whole
 * window again: every log and every trading block's timestamp, a few hundred
 * calls a block on a busy pair, for the one block that was actually new. A
 * written block does not change, so a reload now reads only what is past the
 * cached range, and the window's older edge only when a longer window reaches
 * past it.
 */
const spans = new Map<string, Span>()

/**
 * Blocks re-read at the head on every reload. The ZVM derives a block from a
 * momentum, and a node that re-derives the head can replace it, so the newest
 * cached blocks are not trusted.
 */
const HEAD_OVERLAP = 2n

/**
 * The read in progress per pair. A reload that arrives while one is running
 * waits for it and then extends it, rather than starting the same read again:
 * a busy pair's first day takes longer than a block, and each block used to
 * start another copy of it.
 */
const reading = new Map<string, Promise<unknown>>()

function logsFor(client: Client, key: string, pair: Address, from: bigint, head: bigint): Promise<Log[]> {
  const run = (reading.get(key) ?? Promise.resolve()).catch(() => {}).then(() => extend(client, key, pair, from, head))
  reading.set(key, run)
  void run.finally(() => reading.get(key) === run && reading.delete(key)).catch(() => {})
  return run
}

async function extend(client: Client, key: string, pair: Address, from: bigint, head: bigint): Promise<Log[]> {
  const known = spans.get(key)
  let span: Span
  if (!known || known.to + 1n < from || known.from > head) {
    span = {from, to: head, logs: await getLogsChunked(client, pair, from, head)}
  } else {
    const keepTo = known.to - HEAD_OVERLAP < known.from ? known.from - 1n : known.to - HEAD_OVERLAP
    const older = from < known.from ? await getLogsChunked(client, pair, from, known.from - 1n) : []
    const newer = head > keepTo ? await getLogsChunked(client, pair, keepTo + 1n, head) : []
    span = {
      from: from < known.from ? from : known.from,
      to: head > keepTo ? head : keepTo,
      logs: [...older, ...known.logs.filter((l) => l.blockNumber! <= keepTo), ...newer],
    }
  }
  spans.set(key, span)
  return span.logs.filter((l) => l.blockNumber! >= from && l.blockNumber! <= head)
}

/** Block timestamps, per chain. A written block's time never changes. */
const stamps = new Map<string, number>()

/**
 * Past this many blocks without a known time, the rest are interpolated.
 *
 * The fleet benchmark's pair trades in nearly every block, so a day of it is
 * several thousand blocks, and reading each one's header to place a point on a
 * 640 pixel chart is most of the page's traffic. One block is one momentum, so
 * time runs close to linear in block number: the headers on a fixed grid are
 * read, and a block between two of them is placed by where it falls. The grid
 * is aligned to absolute block numbers so the next reload hits the same
 * headers in the cache. What it costs is a few seconds of error in a trade's
 * time on a pair busy enough to need it.
 */
const EXACT_LIMIT = 200

async function timesFor(client: Client, chainId: number, blocks: bigint[], head: bigint): Promise<Map<bigint, number>> {
  const k = (b: bigint) => `${chainId}:${b}`
  const read = async (want: bigint[]) => {
    const missing = [...new Set(want)].filter((b) => !stamps.has(k(b)))
    const BATCH = 24
    for (let i = 0; i < missing.length; i += BATCH) {
      const slice = missing.slice(i, i + BATCH)
      const got = await Promise.all(slice.map((n) => client.getBlock({blockNumber: n, includeTransactions: false})))
      got.forEach((b, j) => stamps.set(k(slice[j]), Number(b.timestamp)))
    }
  }

  const unknown = blocks.filter((b) => !stamps.has(k(b)))
  const out = new Map<bigint, number>()
  // Decided by the window, not by what happens to be cached: once a busy
  // window's grid is cached, the blocks between it would otherwise fall under
  // the limit and all be read on the next reload.
  if (blocks.length <= EXACT_LIMIT || unknown.length <= 24) {
    await read(unknown)
    for (const b of blocks) out.set(b, stamps.get(k(b))!)
    return out
  }

  const lo = unknown.reduce((a, b) => (b < a ? b : a))
  const hi = unknown.reduce((a, b) => (b > a ? b : a))
  // A power of two, so the grid only changes when the range doubles.
  let stride = 1n
  while ((hi - lo) / stride > BigInt(EXACT_LIMIT)) stride *= 2n
  const below = (b: bigint) => (b / stride) * stride
  const above = (b: bigint) => (below(b) + stride > head ? head : below(b) + stride)
  await read(unknown.flatMap((b) => [below(b), above(b)]))
  for (const b of blocks) {
    const exact = stamps.get(k(b))
    if (exact !== undefined) {
      out.set(b, exact)
      continue
    }
    const b0 = below(b)
    const b1 = above(b)
    const t0 = stamps.get(k(b0))!
    const t1 = stamps.get(k(b1))!
    out.set(b, b1 === b0 ? t0 : Math.round(t0 + ((t1 - t0) * Number(b - b0)) / Number(b1 - b0)))
  }
  return out
}

interface Earlier {
  /** Every block below this one, down to `floor`, has been read. */
  below: bigint
  floor: bigint
  /** The newest trade found in that range. */
  trade: {block: number; time: number} | null
}

/**
 * The newest trade before each window, per chain and pair.
 *
 * The pages reload on every block, and an idle pair would otherwise walk back
 * to genesis each time to find the same trade. What sits below a block does not
 * change, so each reload only reads the blocks that left the window since.
 */
const earlier = new Map<string, Earlier>()

/** How far back the search for an earlier trade reaches, beyond the window. */
const EARLIER_CAP = 250_000n

async function tradeBefore(
  client: Client,
  key: string,
  pair: Address,
  from: bigint,
  isTrade: (log: Log) => boolean,
): Promise<Earlier> {
  let known = earlier.get(key)
  // A cached trade at or above the window's start means the chain was reorged
  // under it; the window scan just said there is none there.
  if (known?.trade && BigInt(known.trade.block) >= from) known = undefined
  if (known && known.below >= from) return known

  const floor = known ? known.below : from > EARLIER_CAP ? from - EARLIER_CAP : 0n
  let found: Log | null = null
  // Newest chunk first, so a pair that traded recently costs one call.
  for (let end = from - 1n; end >= floor && !found; end -= CHUNK) {
    const start = end - CHUNK + 1n > floor ? end - CHUNK + 1n : floor
    const logs = await client.getLogs({address: pair, event: swapEvent, fromBlock: start, toBlock: end})
    for (let i = logs.length - 1; i >= 0 && !found; i--) if (isTrade(logs[i] as Log)) found = logs[i] as Log
  }

  let trade = known?.trade ?? null
  if (found) {
    const block = await client.getBlock({blockNumber: found.blockNumber!, includeTransactions: false})
    trade = {block: Number(found.blockNumber), time: Number(block.timestamp)}
  }
  const next: Earlier = {below: from, floor: known ? known.floor : floor, trade}
  earlier.set(key, next)
  return next
}

/**
 * Reads the pair's trades over roughly `hours` of chain time.
 *
 * `base` decides which way round the price is quoted: it is the token being
 * priced, and the other side of the pool is what it is priced in.
 */
export async function loadPairHistory(
  chainId: number,
  pool: Pool,
  base: Token,
  quote: Token,
  opts: {hours?: number; intervalSecs?: number; maxBlocks?: number} = {},
): Promise<PairHistory> {
  const hours = opts.hours ?? 24
  // Zero hours is "all", which reaches back to genesis and filters nothing out.
  // Its own cap is far higher than a timed window's, because the point of it is
  // to find the trades a shorter window cannot, and the panel prints the block
  // range it actually reached so a truncated scan is never silent.
  const allTime = hours <= 0
  const interval = Math.max(1, opts.intervalSecs ?? 15)
  const client = publicClient(chainId)
  const head = await client.getBlockNumber()
  const cap = BigInt(opts.maxBlocks ?? (allTime ? 250_000 : 20_000))
  const want = allTime ? head : BigInt(Math.ceil((hours * 3600) / interval))
  const span = want > cap ? cap : want
  const from = head > span ? head - span : 0n

  const baseIs0 = pool.token0.toLowerCase() === base.address.toLowerCase()
  const scale = 10 ** (base.decimals - quote.decimals)

  /** Base and quote moved by one Swap log, or null for a log that moved neither. */
  const amounts = (log: Log) => {
    const args = (log as any).args as {amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint; to: Address}
    const baseIn = baseIs0 ? args.amount0In : args.amount1In
    const baseOut = baseIs0 ? args.amount0Out : args.amount1Out
    const quoteIn = baseIs0 ? args.amount1In : args.amount0In
    const quoteOut = baseIs0 ? args.amount1Out : args.amount0Out
    const baseAmount = baseIn > 0n ? baseIn : baseOut
    const quoteAmount = quoteIn > 0n ? quoteIn : quoteOut
    if (baseAmount === 0n || quoteAmount === 0n) return null
    return {baseAmount, quoteAmount, baseOut, taker: args.to, price: (Number(quoteAmount) / Number(baseAmount)) * scale}
  }

  const cutoff = allTime ? 0 : Math.floor(Date.now() / 1000) - hours * 3600
  const key = `${chainId}:${pool.pair}`.toLowerCase()
  const logs = await logsFor(client, key, pool.pair, from, head)

  // An empty window is not an empty pair. Nothing has moved the price since the
  // last trade, so the chart draws the pool's price flat across the window
  // instead of saying there is nothing to draw. The pool's own price, not the
  // last trade's: a trade's price is the average it paid along the curve, and
  // the pool is left at the far end of it, so drawing the trade's price flat
  // and then the pool's price now put a cliff at the right edge that no trade
  // ever made.
  const held = (since: number) => {
    const spot = spotPrice(pool, base, quote)
    return spot > 0 ? [{time: Math.max(since, cutoff), price: spot}] : []
  }

  if (!logs.length) {
    const prior = await tradeBefore(client, key, pool.pair, from, (l) => amounts(l) !== null)
    return {
      trades: [],
      series: prior.trade ? held(prior.trade.time) : [],
      volume24hBase: 0n,
      trades24h: 0,
      change24h: null,
      fromBlock: Number(from),
      toBlock: Number(head),
      lastTradeAt: prior.trade?.time ?? null,
      neverTraded: !prior.trade && prior.floor === 0n,
    }
  }

  // Timestamps come from the blocks that actually traded, which on a quiet pair
  // is a handful even across a whole day.
  const times = await timesFor(client, chainId, [...new Set(logs.map((l) => l.blockNumber!))], head)

  const trades: Trade[] = []
  for (const log of logs) {
    const a = amounts(log)
    if (!a) continue
    trades.push({
      hash: log.transactionHash!,
      block: Number(log.blockNumber),
      time: times.get(log.blockNumber!) ?? 0,
      side: a.baseOut > 0n ? 'buy' : 'sell',
      baseAmount: a.baseAmount,
      quoteAmount: a.quoteAmount,
      price: a.price,
      taker: a.taker,
    })
  }

  trades.sort((a, b) => a.block - b.block || a.hash.localeCompare(b.hash))

  // A block count is only an estimate of a time window, and on a chain that
  // has been idle it overshoots badly. Everything reported is cut to the window
  // that was actually asked for, so a chart labelled 24 hours never draws a
  // trade from last week as a cliff on its left edge.
  const inWindow = trades.filter((t) => t.time >= cutoff)
  const volume24hBase = inWindow.reduce((sum, t) => sum + t.baseAmount, 0n)
  const first = inWindow[0]?.price
  const last = inWindow[inWindow.length - 1]?.price
  const change24h = first && last && first > 0 ? last / first - 1 : null

  return {
    trades: inWindow.slice().reverse(),
    // The scan can reach past the window and find only older trades, which is
    // the same empty window as above.
    series: inWindow.length ? inWindow.map((t) => ({time: t.time, price: t.price})) : held(trades[trades.length - 1].time),
    volume24hBase,
    trades24h: inWindow.length,
    change24h,
    fromBlock: Number(from),
    toBlock: Number(head),
    /** The last trade of any age, so an empty window can say how long it has been. */
    lastTradeAt: trades.length ? trades[trades.length - 1].time : null,
    neverTraded: false,
  }
}

/** The pool's own price right now, which is where the chart's last point belongs. */
export function spotPrice(pool: Pool, base: Token, quote: Token): number {
  const [rBase, rQuote] = reservesFor(pool, base.address)
  if (rBase === 0n) return 0
  return (Number(rQuote) / Number(rBase)) * 10 ** (base.decimals - quote.decimals)
}
