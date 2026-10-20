// The chain's heartbeat.
//
// One NoM momentum orders exactly one ZVM block, so this chain does not have a
// mempool that drains continuously: it has a beat, measured at about fifteen
// seconds on the devnets. Everything that looks slow about a swap here follows
// from that, so the beat is tracked once, in one place, and drawn under the
// header where a person can see what they are waiting for.

import {reactive, watch} from 'vue'
import {endpoint, reachable} from './endpoint'
import {publicClient} from './evm'

export interface ChainState {
  chainId: number | null
  head: number | null
  /** Unix seconds of the head block. */
  timestamp: number | null
  baseFee: bigint | null
  /** Measured seconds between the last few blocks, not the nominal ten. */
  interval: number
  /** Wall clock (ms) when the head last changed, for the pulse. */
  landedAt: number
  error: string | null
}

export const chain = reactive<ChainState>({
  chainId: null,
  head: null,
  timestamp: null,
  baseFee: null,
  interval: 15,
  landedAt: Date.now(),
  error: null,
})

/** Called once per new block, by whoever wants to refresh on the beat. */
const onBlockListeners = new Set<(head: number) => void>()

export function onBlock(fn: (head: number) => void): () => void {
  onBlockListeners.add(fn)
  return () => onBlockListeners.delete(fn)
}

let timer: number | undefined
let lastSeen = 0
const gaps: number[] = []

async function poll() {
  // A tab nobody is looking at does not need the beat, and every block it sees
  // sets off each page's own refresh behind it. It catches up the moment it is
  // shown again (below), so the first thing on screen is current.
  if (typeof document !== 'undefined' && document.hidden) return
  if (!reachable.value || endpoint.chainId === null) return
  try {
    const block = await publicClient(endpoint.chainId).getBlock({blockTag: 'latest'})
    const head = Number(block.number)
    chain.chainId = endpoint.chainId
    chain.baseFee = block.baseFeePerGas ?? null
    chain.error = null
    if (head !== lastSeen) {
      // Blocks carry NoM's own timestamps, so the gap between two of them is
      // the momentum cadence rather than this browser's clock drift.
      if (chain.timestamp && block.timestamp) {
        const gap = Number(block.timestamp) - chain.timestamp
        if (gap > 0 && gap < 120) {
          gaps.push(gap)
          if (gaps.length > 8) gaps.shift()
          chain.interval = gaps.reduce((a, b) => a + b, 0) / gaps.length
        }
      }
      lastSeen = head
      chain.head = head
      chain.timestamp = Number(block.timestamp)
      chain.landedAt = Date.now()
      onBlockListeners.forEach((fn) => fn(head))
    }
  } catch (err: any) {
    chain.error = err?.shortMessage ?? err?.message ?? String(err)
  }
}

export function startChainPolling(intervalMs = 3000) {
  if (timer) return
  poll()
  timer = window.setInterval(poll, intervalMs)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll()
  })
}

// A new node is a new chain until proven otherwise: drop what the old one said
// rather than showing its head height under the new endpoint's name.
watch(
  () => endpoint.rpc,
  () => {
    lastSeen = 0
    gaps.length = 0
    chain.head = null
    chain.timestamp = null
    chain.baseFee = null
    chain.error = null
    poll()
  },
)
