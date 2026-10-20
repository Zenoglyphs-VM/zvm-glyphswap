// Swaps that have been submitted and have not settled yet.
//
// A swap here takes about two momentums to execute, thirty seconds, and the
// card used to hold its button in "Working" for all of that. Nothing about the
// chain requires it: the relayer serialises one sender's transactions on one
// Zenon account and answers eth_getTransactionCount past what it is holding, so
// a wallet can have several of its own transactions in flight and they land in
// nonce order (zvm-docs, PROGRESS.md 2026-09-16). So a submitted swap is handed
// to this store and runs on its own, and the card is free for the next one.
//
// It lives outside any component so a swap keeps running, and keeps being
// shown, when the person navigates to another page while it is in flight.

import {reactive} from 'vue'
import {runCalls, type Step} from './tx'
import type {Call} from './uniswap'

export interface PendingSwap {
  id: number
  /** "0.5 ZNN for 1.23 QSR", as quoted when it was submitted. */
  summary: string
  chainId: number
  /** What it spends, so the card can keep it out of the balance it offers. */
  tokenInKey: string
  amountIn: bigint
  steps: Step[]
  status: 'running' | 'done' | 'failed'
  startedAt: number
}

export const pending = reactive<{items: PendingSwap[]}>({items: []})

/** How long a finished swap stays in the bubble. A failure stays until it is
 *  dismissed: it is the one outcome the person has to act on. */
const DONE_LINGER_MS = 12_000

let nextId = 1

export interface SwapJob {
  summary: string
  chainId: number
  tokenInKey: string
  amountIn: bigint
  calls: Call[]
  /** Runs after the swap settles either way, to re-read balances and pools. */
  settled?: () => Promise<unknown> | void
}

/** Starts a swap and returns at once; its progress is in `pending.items`. */
export function startSwap(job: SwapJob): number {
  const id = nextId++
  pending.items.push({
    id,
    summary: job.summary,
    chainId: job.chainId,
    tokenInKey: job.tokenInKey,
    amountIn: job.amountIn,
    steps: job.calls.map((c) => ({label: c.label, state: 'queued'})),
    status: 'running',
    startedAt: Date.now(),
  })
  // Always the reactive proxy, looked up again: a reference taken before the
  // push would be the raw object, and writes through it would never render.
  const item = () => pending.items.find((p) => p.id === id)

  void (async () => {
    let failed = false
    try {
      const steps = await runCalls(job.calls, (s) => {
        const p = item()
        if (p) p.steps = s
      })
      failed = !steps.every((s) => s.state === 'done')
    } catch (err: any) {
      // runCalls only throws before the first transaction: no node, no wallet.
      failed = true
      const p = item()
      if (p) {
        const first = p.steps.find((s) => s.state !== 'done') ?? p.steps[0]
        if (first) {
          first.state = 'failed'
          first.detail = err?.shortMessage ?? err?.message ?? String(err)
        }
      }
    }
    // Re-read balances before the swap stops counting as running: in between,
    // the card would offer the old balance with nothing reserved against it.
    try {
      await job.settled?.()
    } catch {
      /* a failed refresh is the next poll's problem, not this swap's */
    }
    const p = item()
    if (p) p.status = failed ? 'failed' : 'done'
    if (!failed) setTimeout(() => dismiss(id), DONE_LINGER_MS)
  })()

  return id
}

export function dismiss(id: number) {
  pending.items = pending.items.filter((p) => p.id !== id)
}

/** What running swaps on this chain have committed to spend of one token. A
 *  balance read from the chain does not know about them until they execute. */
export function reserved(tokenInKey: string, chainId: number | null): bigint {
  let sum = 0n
  for (const p of pending.items) {
    if (p.status === 'running' && p.chainId === chainId && p.tokenInKey === tokenInKey) sum += p.amountIn
  }
  return sum
}
