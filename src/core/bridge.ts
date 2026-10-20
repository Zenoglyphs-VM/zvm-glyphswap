// Moving ZNN and QSR between Zenon and the ZVM.
//
// In is a Zenon send to the vault, signed by Syrius. Nobody signs a deposit on
// the ZVM side: every node sees the same send and mints the same amount, so this
// direction asks for no trust. Out is a call to the bridge predeploy from the
// EVM wallet; the amount is locked (ZNN) or burned (QSR) at once, and the vault
// committee pays it on Zenon after the finality depth. That half is trusted, and
// the page says so.
//
// Everything here comes from the node's /api/info and /api/bridge, which is the
// one place this otherwise backend-free app needs a zvm node rather than any
// EVM RPC: the vault address and the committee's health are not on the ZVM.

import {reactive} from 'vue'
import {toRlp, type Address, type Hash, type Hex} from 'viem'
import {endpoint} from './endpoint'
import {publicClient} from './evm'

export const BRIDGE_ABI = [
  {type: 'function', name: 'withdrawZNN', stateMutability: 'payable', inputs: [{name: 'nomRecipient', type: 'address'}], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'withdrawQSR', stateMutability: 'nonpayable', inputs: [{name: 'nomRecipient', type: 'address'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'feeFor', stateMutability: 'view', inputs: [{name: 'zts', type: 'bytes10'}, {name: 'amount', type: 'uint256'}], outputs: [{type: 'uint256'}]},
  {
    type: 'function',
    name: 'withdrawal',
    stateMutability: 'view',
    inputs: [{name: 'id', type: 'uint256'}],
    outputs: [
      {
        type: 'tuple',
        components: [
          {name: 'from', type: 'address'},
          {name: 'to', type: 'address'},
          {name: 'zts', type: 'bytes10'},
          {name: 'amount', type: 'uint64'},
          {name: 'l2Block', type: 'uint64'},
          {name: 'paidIn', type: 'bytes32'},
          {name: 'fee', type: 'uint64'},
        ],
      },
    ],
  },
  {
    type: 'event',
    name: 'QSRDeposited',
    inputs: [
      {name: 'nomBlock', type: 'bytes32', indexed: true},
      {name: 'to', type: 'address', indexed: true},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
  {
    type: 'event',
    name: 'WithdrawalInitiated',
    inputs: [
      {name: 'id', type: 'uint256', indexed: true},
      {name: 'from', type: 'address', indexed: true},
      {name: 'to', type: 'address', indexed: true},
      {name: 'zts', type: 'bytes10', indexed: false},
      {name: 'amount', type: 'uint256', indexed: false},
    ],
  },
] as const

export type BridgeToken = 'ZNN' | 'QSR'

/** The tokens as the bridge contract's ABI takes them: bytes10. */
export const ZTS_BYTES: Record<BridgeToken, Hex> = {ZNN: '0x14e66318c6318c6318c6', QSR: '0x04066318c6318c6318c6'}
/** The same tokens as Syrius's account-block template wants them: bech32. */
export const ZTS_NOM: Record<BridgeToken, string> = {ZNN: 'zts1znnxxxxxxxxxxxxx9z4ulx', QSR: 'zts1qsrxxxxxxxxxxxxxmrhjll'}

/** Both tokens are 8 decimals on Zenon; ZNN is 18 on the ZVM, as native value. */
export const NOM_DECIMALS = 8
export const ZNN_SCALE = 10n ** 10n

/** Where the predeploys sit when the node does not say (zvm-node genesis). */
const BRIDGE_DEFAULT = '0x4200000000000000000000000000000000000100' as Address
const WQSR_DEFAULT = '0x4200000000000000000000000000000000000101' as Address

export interface Flow {
  id: number
  kind: string
  account: string
  amount: string
  token: string
  l2Tx?: string
  nomBlock?: string
  note?: string
  timestamp: number
  withdrawalId?: number
}

export interface Deposit {
  nomHash: string
  author: string
  amount: string
  token: string
  status: string
  reason: string
  momentum: number
  txs?: string[]
}

export interface Committee {
  healthy?: boolean
  lastOkAt?: string
  error?: string
  lastError?: string
  pendingZNN?: string
  pendingQSR?: string
  paidZNN?: string
  paidQSR?: string
  deferredDeposits?: number
  unreceivedDeposits?: number
  payouts?: Record<string, number>
}

export interface BridgeState {
  loaded: boolean
  error: string | null
  /** From /api/info. */
  vault: string
  nomChainId: number | null
  bridge: Address
  wqsr: Address
  finalityDepth: number
  derivation: {lag: number; stalled: boolean; sinceProgressMs: number} | null
  /** From /api/bridge. */
  vaultZnn: string | null
  vaultQsr: string | null
  lockedOnZVM: string | null
  committee: Committee | null
  flows: Flow[]
  deposits: Deposit[]
  checkedAt: number | null
}

export const bridge = reactive<BridgeState>({
  loaded: false,
  error: null,
  vault: '',
  nomChainId: null,
  bridge: BRIDGE_DEFAULT,
  wqsr: WQSR_DEFAULT,
  finalityDepth: 6,
  derivation: null,
  vaultZnn: null,
  vaultQsr: null,
  lockedOnZVM: null,
  committee: null,
  flows: [],
  deposits: [],
  checkedAt: null,
})

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${endpoint.apiBase}${path}`, {headers: {accept: 'application/json'}, signal: AbortSignal.timeout(8000)})
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return res.json()
}

/** Reads both endpoints. Keeps the last good copy when a read fails. */
export async function loadBridge(): Promise<void> {
  if (!endpoint.apiBase) {
    bridge.error = 'This node is not a zvm node, so it cannot say where the vault is. Choose a zvm node to bridge.'
    bridge.loaded = true
    return
  }
  try {
    const [info, b] = await Promise.all([getJson('/api/info'), getJson('/api/bridge?limit=200')])
    bridge.vault = b?.vault?.address ?? info?.l1?.vault ?? ''
    bridge.nomChainId = typeof info?.l1?.chainId === 'number' ? info.l1.chainId : null
    bridge.bridge = (info?.predeploys?.ZVMBridge ?? BRIDGE_DEFAULT) as Address
    bridge.wqsr = (info?.predeploys?.WrappedQSR ?? WQSR_DEFAULT) as Address
    bridge.finalityDepth = info?.l2?.finalityDepth ?? 6
    bridge.derivation = info?.derivation ?? null
    bridge.vaultZnn = b?.vault?.znn ?? null
    bridge.vaultQsr = b?.vault?.qsr ?? null
    bridge.lockedOnZVM = b?.lockedOnZVM ?? null
    bridge.committee = b?.committee ?? null
    bridge.flows = Array.isArray(b?.flows) ? b.flows : []
    bridge.deposits = Array.isArray(b?.deposits) ? b.deposits : []
    bridge.checkedAt = Date.now()
    bridge.error = null
  } catch (err: any) {
    bridge.error = err?.message ?? String(err)
  } finally {
    bridge.loaded = true
  }
}

export type Health = 'operational' | 'degraded' | 'down' | 'unknown'

/**
 * One word for whether bridging works right now, and why not.
 *
 * The two directions fail differently, so they are judged apart. Deposits need
 * derivation moving and nothing else; withdrawals also need the committee,
 * which is a separate process that can be down while the chain is fine.
 */
export function health(): {deposits: Health; withdrawals: Health; why: string[]} {
  const why: string[] = []
  if (!bridge.checkedAt) return {deposits: 'unknown', withdrawals: 'unknown', why}

  let deposits: Health = 'operational'
  const d = bridge.derivation
  if (d?.stalled) {
    deposits = 'down'
    why.push(`Derivation has not advanced for ${Math.round(d.sinceProgressMs / 1000)} s, so deposits are not being credited.`)
  } else if (d && d.lag > 3) {
    deposits = 'degraded'
    why.push(`Derivation is ${d.lag} momentums behind Zenon; deposits arrive late.`)
  }
  // The committee's deferredDeposits is deliberately not read here: a deferred
  // deposit is one the vault has not yet *received* on NoM, and the depositor
  // already has their balance, because the ZVM credits from the send.
  const c = bridge.committee

  let withdrawals: Health = deposits === 'down' ? 'down' : 'operational'
  if (!c || c.error) {
    withdrawals = 'down'
    why.push('The vault committee is not reachable, so withdrawals are locked on the ZVM but not paid.')
  } else if (c.healthy === false) {
    withdrawals = 'degraded'
    why.push(`The vault committee's last sweep failed${c.lastError ? `: ${c.lastError}` : ''}. Payouts may be delayed.`)
  } else if (c.lastOkAt && Date.now() - Date.parse(c.lastOkAt) > 5 * 60_000) {
    withdrawals = 'degraded'
    why.push('The vault committee has not checked in for over five minutes.')
  }
  return {deposits, withdrawals, why}
}

// --- deposits carry a call ---------------------------------------------------
//
// A bare send to the vault credits the sender's own 20 bytes, spelled 0x… on
// the ZVM — an address no EVM wallet holds the key for. So a deposit here always
// carries a native ZVM call naming the address it credits (spec/SPEC.md §5):
// 0x01 ‖ rlp([to, value, gas, data]). This is the one message the app builds;
// the encoder is the one the original bridge page used, which the golden vectors
// pin (zvm `npm run verify:vectors`).

const hexBytes = (v: bigint): Hex => {
  if (v <= 0n) return '0x'
  const h = v.toString(16)
  return `0x${h.length % 2 ? '0' : ''}${h}` as Hex
}

export function encodeCall(call: {to: Address; value?: bigint; gas?: bigint; data?: Hex}): Uint8Array {
  const rlp = toRlp([call.to, hexBytes(call.value ?? 0n), hexBytes(call.gas ?? 0n), call.data ?? '0x'], 'bytes')
  const out = new Uint8Array(rlp.length + 1)
  out[0] = 0x01
  out.set(rlp, 1)
  return out
}

/**
 * ZNN mints to the sender and then spends the mint in a value transfer to `to`,
 * so it needs gas — `zvm deposit -to`'s own 30,000, a plain transfer with room
 * for the recipient's code. QSR has no native value to spend: WrappedQSR is
 * minted straight to `to`, and the call names nothing else.
 */
export function depositData(token: BridgeToken, to: Address, baseUnits: bigint): Uint8Array {
  return token === 'ZNN' ? encodeCall({to, value: baseUnits * ZNN_SCALE, gas: 30_000n}) : encodeCall({to})
}

// --- one wallet's movements -----------------------------------------------------
//
// The node's /api/bridge has no account filter, only a limit across everyone,
// so filtering its list here would silently lose older movements as the chain
// grows. The contract's own events are exact instead: WithdrawalInitiated and
// QSRDeposited both index the EVM address. What no event covers is a ZNN
// deposit (a plain mint, derived without a bridge event), so those are found in
// the node's deposit list by the Zenon account that signed them.

export interface MyWithdrawal {
  id: bigint
  token: BridgeToken
  /** Net of the fee: what the payout sends. */
  amount: bigint
  to: Address
  tx: Hash
  block: bigint
  timestamp: number | null
  paidIn: Hex | null
}

export interface MyDeposit {
  nomHash: string
  token: BridgeToken
  amount: bigint
  status: string
  reason: string
  tx: string | null
  momentum: number | null
}

export const mine = reactive({
  loading: false,
  error: null as string | null,
  withdrawals: [] as MyWithdrawal[],
  deposits: [] as MyDeposit[],
})

const CHUNK = 5000n
const MINE_MAX = 25
const zeroHash = (h?: string | null) => !h || /^0x0*$/.test(h)
const bare = (h: string) => h.replace(/^0x/, '').toLowerCase()
const tokenOf = (zts: string): BridgeToken => (zts.toLowerCase() === ZTS_BYTES.QSR || zts === ZTS_NOM.QSR ? 'QSR' : 'ZNN')

async function logsFor<T>(read: (from: bigint, to: bigint) => Promise<T[]>, head: bigint): Promise<T[]> {
  const out: T[] = []
  for (let start = 0n; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n
    out.push(...(await read(start, end)))
  }
  return out
}

let reading = false

/** Reads what `evm` withdrew and was credited, and what `nom` deposited. */
export async function loadMine(evm: Address | null, nom: string | null): Promise<void> {
  if (!evm && !nom) {
    mine.withdrawals = []
    mine.deposits = []
    return
  }
  if (reading || endpoint.chainId === null) return
  reading = true
  mine.loading = true
  try {
    const client = publicClient(endpoint.chainId)
    const head = await client.getBlockNumber()
    const withdrawals: MyWithdrawal[] = []
    const deposits = new Map<string, MyDeposit>()

    if (evm) {
      const [out, qsrIn] = await Promise.all([
        logsFor((fromBlock, toBlock) => client.getContractEvents({address: bridge.bridge, abi: BRIDGE_ABI, eventName: 'WithdrawalInitiated', args: {from: evm}, fromBlock, toBlock}), head),
        logsFor((fromBlock, toBlock) => client.getContractEvents({address: bridge.bridge, abi: BRIDGE_ABI, eventName: 'QSRDeposited', args: {to: evm}, fromBlock, toBlock}), head),
      ])
      const recent = out.slice(-MINE_MAX).reverse()
      const [records, blocks] = await Promise.all([
        Promise.all(recent.map((l) => client.readContract({address: bridge.bridge, abi: BRIDGE_ABI, functionName: 'withdrawal', args: [l.args.id!]}).catch(() => null))),
        Promise.all([...new Set(recent.map((l) => l.blockNumber))].map((n) => client.getBlock({blockNumber: n}).catch(() => null))),
      ])
      const time = new Map(blocks.filter(Boolean).map((b) => [b!.number, Number(b!.timestamp)]))
      recent.forEach((l, i) => {
        const r = records[i]
        withdrawals.push({
          id: l.args.id!,
          token: tokenOf(l.args.zts!),
          amount: l.args.amount!,
          to: l.args.to!,
          tx: l.transactionHash,
          block: l.blockNumber,
          timestamp: time.get(l.blockNumber) ?? null,
          paidIn: r && !zeroHash(r.paidIn) ? r.paidIn : null,
        })
      })
      for (const l of qsrIn.slice(-MINE_MAX)) {
        deposits.set(bare(l.args.nomBlock!), {
          nomHash: bare(l.args.nomBlock!),
          token: 'QSR',
          amount: l.args.amount!,
          status: 'included',
          reason: '',
          tx: l.transactionHash,
          momentum: null,
        })
      }
    }

    // The node's list is richer — momentum, and why a deposit was dropped — so
    // where it has the same deposit, its row wins.
    for (const d of bridge.deposits) {
      const key = bare(d.nomHash)
      if (!(nom && d.author === nom) && !deposits.has(key)) continue
      deposits.set(key, {
        nomHash: key,
        token: tokenOf(d.token),
        amount: BigInt(d.amount),
        status: d.status,
        reason: d.reason,
        tx: d.txs?.[0] ?? deposits.get(key)?.tx ?? null,
        momentum: d.momentum,
      })
    }

    mine.withdrawals = withdrawals
    mine.deposits = [...deposits.values()]
      .sort((a, b) => (b.momentum ?? Number.MAX_SAFE_INTEGER) - (a.momentum ?? Number.MAX_SAFE_INTEGER))
      .slice(0, MINE_MAX)
    mine.error = null
  } catch (err: any) {
    mine.error = err?.shortMessage ?? err?.message ?? String(err)
  } finally {
    mine.loading = false
    reading = false
  }
}
