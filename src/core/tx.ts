// Sending calls from the connected wallet, and knowing when they landed.
//
// The wallet signs an ordinary EIP-1559 transaction. The node hands it to a
// relayer, which posts it to NoM; it becomes a ZVM transaction once the
// momentum carrying it is derived. That is why a step here has a state between
// "sent" and "confirmed" that an ordinary chain does not: the transaction has
// been ordered, and is waiting to be executed.

import {reactive} from 'vue'
import type {Address, Hash} from 'viem'
import {estimateFees, publicClient, walletClient} from './evm'
import {endpoint} from './endpoint'
import {wallet} from './wallet'
import type {Call} from './uniswap'

export type StepState = 'queued' | 'signing' | 'ordered' | 'done' | 'failed'

export interface Step {
  label: string
  state: StepState
  hash?: Hash
  detail?: string
}

export const STEP_WORD: Record<StepState, string> = {
  queued: 'Next',
  signing: 'Waiting for your wallet',
  ordered: 'Ordered by NoM',
  done: 'Executed',
  failed: 'Failed',
}

const reason = (err: any): string => {
  const s = err?.shortMessage ?? err?.details ?? err?.message ?? String(err)
  // Wallets all phrase a rejection differently, and none of them phrase it well.
  if (/user rejected|denied transaction|user denied/i.test(s)) return 'You dismissed the request in your wallet.'
  return s
}

const RECEIPT = {pollingInterval: 2_000, timeout: 600_000} as const

async function estimate(from: Address, call: Call): Promise<bigint> {
  const client = publicClient(endpoint.chainId!)
  const est = await client.estimateGas({account: from, to: call.to, data: call.data, value: call.value})
  return (est * 13n) / 10n
}

/**
 * Runs calls in order, waiting for each receipt, because a wallet estimates the
 * next transaction against the chain as it is. Approve then swap is two
 * momentums, and pretending otherwise is what makes the second one revert.
 */
export async function runCalls(calls: Call[], update: (steps: Step[]) => void): Promise<Step[]> {
  const chainId = endpoint.chainId
  if (chainId === null) throw new Error('No node connected.')
  const steps: Step[] = calls.map((c) => ({label: c.label, state: 'queued'}))
  const emit = () => update(steps.map((s) => ({...s})))
  const client = publicClient(chainId)
  emit()

  const from = wallet.address
  if (!from || !wallet.provider) throw new Error('Connect a wallet first.')
  const signer = walletClient(wallet.provider, chainId, from)

  for (const [i, call] of calls.entries()) {
    const step = steps[i]
    try {
      step.state = 'signing'
      emit()
      const [gas, fees] = await Promise.all([estimate(from, call), estimateFees(chainId)])
      const hash = await signer.sendTransaction({to: call.to, data: call.data, value: call.value, gas, ...fees})
      step.hash = hash
      step.state = 'ordered'
      emit()
      record({hash, label: call.label, chainId, at: Date.now(), state: 'ordered'})
      const r = await client.waitForTransactionReceipt({hash, ...RECEIPT})
      if (r.status !== 'success') throw new Error('The ZVM reverted this transaction.')
      step.state = 'done'
      emit()
      record({hash, label: call.label, chainId, at: Date.now(), state: 'done'})
    } catch (err) {
      step.state = 'failed'
      step.detail = reason(err)
      emit()
      if (step.hash) record({hash: step.hash, label: call.label, chainId, at: Date.now(), state: 'failed'})
      return steps
    }
  }
  return steps
}

// --- what this browser has sent --------------------------------------------

export interface Activity {
  hash: Hash
  label: string
  chainId: number
  at: number
  state: 'ordered' | 'done' | 'failed'
}

const ACTIVITY_KEY = 'glyphswap.activity'
const ACTIVITY_MAX = 25

export const activity = reactive<{items: Activity[]}>({items: readActivity()})

function readActivity(): Activity[] {
  try {
    return JSON.parse(localStorage.getItem(ACTIVITY_KEY) ?? '[]')
  } catch {
    return []
  }
}

function record(entry: Activity) {
  const rest = activity.items.filter((a) => a.hash !== entry.hash)
  activity.items = [entry, ...rest].slice(0, ACTIVITY_MAX)
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity.items))
  } catch {
    /* storage can be blocked; the list still holds for this tab */
  }
}

export function clearActivity() {
  activity.items = []
  try {
    localStorage.removeItem(ACTIVITY_KEY)
  } catch {
    /* nothing to clear */
  }
}
