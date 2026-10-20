<script setup lang="ts">
// Bridging ZNN and QSR between Zenon and the ZVM, ported from the node's own
// bridge page (zvm/web/ui/src/pages/BridgePage.vue) so that people trading here
// can get funds in and out without leaving for another app.
//
// In is signed by Syrius, because the value starts on Zenon; out is signed by
// the EVM wallet, because it starts here. Each form tracks what it sent until
// the other side has it: a deposit until the ZVM credits it, a withdrawal until
// the committee's payout is derived back into the bridge contract.
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {encodeFunctionData, parseAbi, parseEventLogs, parseUnits, type Address, type Hash} from 'viem'
import {hexToNom, isNomAddress, toEvmAddress} from '@zvm/web/address'
import Chip from '@zvm/web/components/Chip.vue'
import {endpoint} from '../core/endpoint'
import {onBlock} from '../core/chain'
import {publicClient} from '../core/evm'
import {wallet, askToConnect, wrongChain, switchToChain} from '../core/wallet'
import {runCalls, type Step} from '../core/tx'
import {ago, short, units} from '../core/format'
import {BRIDGE_ABI, NOM_DECIMALS, ZNN_SCALE, ZTS_BYTES, ZTS_NOM, bridge, depositData, loadBridge, loadMine, mine, type BridgeToken} from '../core/bridge'
import {zenon, connectZenon, sendAccountBlock, watchZenon} from '../core/syrius'
import Panel from '../components/Panel.vue'
import TokenLogo from '../components/TokenLogo.vue'
import StepRail from '../components/StepRail.vue'
import BridgeStatus from '../components/BridgeStatus.vue'
import InfoTip from '../components/InfoTip.vue'

const route = useRoute()
const router = useRouter()

// ?dir=out opens on the withdraw side, so a link can say which way it means.
const dir = ref<'in' | 'out'>(route.query.dir === 'out' ? 'out' : 'in')
watch(dir, (d) => router.replace({query: {...route.query, dir: d === 'out' ? 'out' : undefined}}))

let timer = 0
let stopBlock: (() => void) | null = null
onMounted(() => {
  loadBridge()
  timer = window.setInterval(loadBridge, 6000)
  watchZenon()
  refreshBalances()
  refreshMine()
  stopBlock = onBlock(() => {
    refreshBalances()
    trackWithdrawal()
    refreshMine()
  })
})
onUnmounted(() => {
  clearInterval(timer)
  stopBlock?.()
})
watch(() => endpoint.apiBase, loadBridge)

const refreshMine = () => loadMine(wallet.address, zenon.address)
watch([() => wallet.address, () => zenon.address, () => bridge.checkedAt === null], refreshMine)

const parse = (v: string): bigint => {
  try {
    return parseUnits(v.trim() || '0', NOM_DECIMALS)
  } catch {
    return 0n
  }
}
const nom = (v: bigint | string | null | undefined, frac = 4) => units(v ?? 0n, NOM_DECIMALS, frac)
const readable = (err: any) => err?.shortMessage ?? err?.message ?? String(err)
const txUrl = (hash: string) => (endpoint.apiBase ? `${endpoint.apiBase}/tx/${hash}` : null)
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

// --- balances ----------------------------------------------------------------

const zvmBalance = ref<Record<BridgeToken, bigint | null>>({ZNN: null, QSR: null})
const nomBalance = ref<Record<BridgeToken, bigint | null>>({ZNN: null, QSR: null})
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

async function refreshBalances() {
  if (wallet.address && endpoint.chainId !== null) {
    const client = publicClient(endpoint.chainId)
    try {
      const [wei, qsr] = await Promise.all([
        client.getBalance({address: wallet.address}),
        client.readContract({address: bridge.wqsr, abi: erc20, functionName: 'balanceOf', args: [wallet.address]}),
      ])
      // ZNN is native value here, in wei; the bridge moves whole NoM units.
      zvmBalance.value = {ZNN: wei / ZNN_SCALE, QSR: qsr}
    } catch {
      /* keep the last reading */
    }
  } else {
    zvmBalance.value = {ZNN: null, QSR: null}
  }
  if (zenon.address && endpoint.apiBase) {
    try {
      const res = await fetch(`${endpoint.apiBase}/l1rpc`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ledger.getAccountInfoByAddress', params: [zenon.address]}),
        signal: AbortSignal.timeout(6000),
      })
      const map = (await res.json())?.result?.balanceInfoMap ?? {}
      // go-zenon sends amounts as JSON strings; BigInt, never Number.
      nomBalance.value = {
        ZNN: BigInt(map[ZTS_NOM.ZNN]?.balance ?? '0'),
        QSR: BigInt(map[ZTS_NOM.QSR]?.balance ?? '0'),
      }
    } catch {
      /* keep the last reading */
    }
  } else {
    nomBalance.value = {ZNN: null, QSR: null}
  }
}
watch([() => wallet.address, () => zenon.address], refreshBalances)

// --- in: Zenon → ZVM ---------------------------------------------------------

const inToken = ref<BridgeToken>('ZNN')
const inAmount = ref('')
const inTo = ref('')
const inBusy = ref(false)
const inError = ref('')
const inHash = ref<string | null>(null)

// The connected EVM wallet is the obvious recipient. Filled once rather than
// bound, so it does not fight someone who typed a different address; an
// account switch refills it only while it still holds the auto-filled one.
let autoTo = ''
watch(
  () => wallet.address,
  (addr) => {
    if (!addr || (inTo.value && inTo.value !== autoTo)) return
    inTo.value = addr
    autoTo = addr
  },
  {immediate: true},
)

const chainMismatch = computed(
  () => zenon.address !== null && zenon.chainId !== null && bridge.nomChainId !== null && zenon.chainId !== bridge.nomChainId,
)

const inAction = computed(() => {
  if (!zenon.present) return {label: 'Syrius not found', ok: false}
  if (!zenon.address) return {label: zenon.connecting ? 'Waiting for Syrius…' : 'Connect Syrius', ok: !zenon.connecting, connect: true}
  if (chainMismatch.value) return {label: `Syrius is on chain ${zenon.chainId}`, ok: false}
  if (!bridge.vault) return {label: 'Vault unknown', ok: false}
  const amt = parse(inAmount.value)
  if (amt <= 0n) return {label: 'Enter an amount', ok: false}
  const bal = nomBalance.value[inToken.value]
  if (bal !== null && amt > bal) return {label: `Not enough ${inToken.value} on Zenon`, ok: false}
  if (!EVM_ADDRESS.test(inTo.value.trim())) return {label: 'Enter the 0x address to credit', ok: false}
  if (inBusy.value) return {label: 'Waiting for Syrius…', ok: false}
  return {label: `Deposit ${inToken.value}`, ok: true}
})

async function deposit() {
  if (inAction.value.connect) return connectZenon()
  inError.value = ''
  inHash.value = null
  inBusy.value = true
  try {
    const amt = parse(inAmount.value)
    const to = inTo.value.trim().toLowerCase() as Address
    inHash.value = await sendAccountBlock(
      {toAddress: bridge.vault, amount: amt, tokenStandard: ZTS_NOM[inToken.value], data: depositData(inToken.value, to, amt)},
      bridge.nomChainId ?? 69,
    )
  } catch (err: any) {
    inError.value = readable(err)
  } finally {
    inBusy.value = false
  }
}

// The deposit is found by its Zenon hash in the node's own list, which is where
// the derivation that credited it (or dropped it, and why) is recorded.
const inSeen = computed(() => {
  if (!inHash.value) return null
  const want = inHash.value.replace(/^0x/, '').toLowerCase()
  return bridge.deposits.find((d) => d.nomHash.replace(/^0x/, '').toLowerCase() === want) ?? null
})

// --- out: ZVM → Zenon --------------------------------------------------------

const outToken = ref<BridgeToken>('ZNN')
const outAmount = ref('')
const outTo = ref('')
const steps = ref<Step[]>([])
const outBusy = computed(() => steps.value.some((s) => s.state === 'signing' || s.state === 'ordered'))
const fee = ref<bigint | null>(null)

watch(
  () => zenon.address,
  (addr) => {
    if (addr && !outTo.value) outTo.value = addr
  },
  {immediate: true},
)

// The fee is the contract's own answer for this amount, not a copy of its rule.
watch(
  [outAmount, outToken, () => endpoint.chainId, () => bridge.bridge],
  async () => {
    fee.value = null
    const amt = parse(outAmount.value)
    if (amt <= 0n || endpoint.chainId === null) return
    try {
      fee.value = await publicClient(endpoint.chainId).readContract({
        address: bridge.bridge,
        abi: BRIDGE_ABI,
        functionName: 'feeFor',
        args: [ZTS_BYTES[outToken.value], amt],
      })
    } catch {
      fee.value = null
    }
  },
  {immediate: true},
)

const outAction = computed(() => {
  if (!wallet.address) return {label: 'Connect wallet', ok: true, connect: true}
  if (wrongChain.value) return {label: 'Switch network', ok: true, switch: true}
  const amt = parse(outAmount.value)
  if (amt <= 0n) return {label: 'Enter an amount', ok: false}
  const bal = zvmBalance.value[outToken.value]
  if (bal !== null && amt > bal) return {label: `Not enough ${outToken.value} on the ZVM`, ok: false}
  if (fee.value !== null && amt <= fee.value) return {label: 'Amount does not cover the fee', ok: false}
  const to = outTo.value.trim()
  if (!isNomAddress(to)) return {label: 'Enter the z1 address to pay', ok: false}
  // Only a user account (type byte 0) can spend what it is paid; the contract
  // refuses anything else rather than burn the payout.
  if (!toEvmAddress(to).startsWith('0x00')) return {label: 'That is a contract address', ok: false}
  if (outBusy.value) return {label: 'Withdrawing…', ok: false}
  return {label: `Withdraw ${outToken.value}`, ok: true}
})

const withdrawal = ref<{id: bigint; tx: Hash; paidIn: string | null} | null>(null)

async function withdraw() {
  if (outAction.value.connect) return askToConnect()
  if (outAction.value.switch) return switchToChain()
  withdrawal.value = null
  const amt = parse(outAmount.value)
  const to = toEvmAddress(outTo.value.trim())
  const token = outToken.value
  const data =
    token === 'ZNN'
      ? encodeFunctionData({abi: BRIDGE_ABI, functionName: 'withdrawZNN', args: [to]})
      : encodeFunctionData({abi: BRIDGE_ABI, functionName: 'withdrawQSR', args: [to, amt]})
  const label = `Withdraw ${nom(amt)} ${token} to ${short(outTo.value.trim(), 7, 5)}`
  const done = await runCalls(
    [{to: bridge.bridge, data, value: token === 'ZNN' ? amt * ZNN_SCALE : 0n, gas: 200_000n, label}],
    (s) => (steps.value = s),
  )
  const hash = done[0]?.state === 'done' ? done[0].hash : undefined
  if (!hash || endpoint.chainId === null) return
  refreshBalances()
  refreshMine()
  // The id is what the payout on Zenon will name, and what the contract is
  // asked about from here on.
  try {
    const receipt = await publicClient(endpoint.chainId).getTransactionReceipt({hash})
    const [log] = parseEventLogs({abi: BRIDGE_ABI, eventName: 'WithdrawalInitiated', logs: receipt.logs})
    if (log) {
      withdrawal.value = {id: log.args.id, tx: hash, paidIn: null}
      trackWithdrawal()
    }
  } catch {
    /* the transaction succeeded; only the tracking is missing */
  }
}

async function trackWithdrawal() {
  const w = withdrawal.value
  if (!w || w.paidIn || endpoint.chainId === null) return
  try {
    const rec = await publicClient(endpoint.chainId).readContract({
      address: bridge.bridge,
      abi: BRIDGE_ABI,
      functionName: 'withdrawal',
      args: [w.id],
    })
    if (rec.paidIn && !/^0x0+$/.test(rec.paidIn)) w.paidIn = rec.paidIn
  } catch {
    /* ask again on the next block */
  }
}

// --- recent movements ---------------------------------------------------------

// Only the connected wallets' movements: see loadMine in core/bridge.ts for
// where each comes from, and the one kind of deposit no event can find.
const movements = ref<'out' | 'in'>('out')
const connectedAny = computed(() => !!wallet.address || !!zenon.address)
const movementsNote = computed(() => {
  if (!connectedAny.value) return "Only yours: nobody else's movements are shown."
  if (movements.value === 'out') return 'Withdrawals made from your EVM wallet, newest first.'
  return zenon.address
    ? 'Deposits your Syrius account signed, and QSR credited to your EVM wallet.'
    : 'QSR credited to your EVM wallet. Connect Syrius to include the ZNN deposits you signed.'
})
</script>

<template>
  <div class="grid gap-5">
    <div class="panel px-4 py-3">
      <h1 class="text-[22px] font-semibold tracking-[-0.02em] flex items-center gap-1.5">
        Bridge
        <InfoTip label="About the bridge">
          Move ZNN and QSR between Zenon and the ZVM. Deposits are credited by every node from the Zenon send itself.
          Withdrawals are paid from the vault by the committee after {{ bridge.finalityDepth }} momentums.
        </InfoTip>
      </h1>
    </div>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)] items-start">
      <section class="panel p-4 grid gap-3 w-full max-w-[520px] justify-self-center lg:justify-self-stretch lg:max-w-none">
        <div class="flex items-center gap-1" role="tablist">
          <button class="tab" :class="dir === 'in' ? 'tab-on' : ''" role="tab" :aria-selected="dir === 'in'" @click="dir = 'in'">
            Deposit to ZVM
          </button>
          <button class="tab" :class="dir === 'out' ? 'tab-on' : ''" role="tab" :aria-selected="dir === 'out'" @click="dir = 'out'">
            Withdraw to Zenon
          </button>
        </div>

        <!-- In -->
        <template v-if="dir === 'in'">
          <div class="field">
            <div class="flex items-center justify-between gap-2 mb-2">
              <span class="ledger">From Zenon</span>
              <button
                v-if="nomBalance[inToken] !== null"
                class="text-[12px] text-dim hover:text-fg"
                title="Use the whole balance"
                @click="inAmount = units(nomBalance[inToken]!, NOM_DECIMALS, 8).replace(/,/g, '')"
              >
                Balance <span class="mono">{{ nom(nomBalance[inToken]) }}</span>
              </button>
            </div>
            <div class="flex items-center gap-3">
              <input v-model="inAmount" class="amount" inputmode="decimal" placeholder="0" aria-label="Amount to deposit" />
              <div class="flex gap-1 shrink-0">
                <button v-for="t in ['ZNN', 'QSR'] as const" :key="t" class="pill" :class="inToken === t ? '' : 'opacity-50'" @click="inToken = t">
                  <TokenLogo :symbol="t" :size="20" /> {{ t }}
                </button>
              </div>
            </div>
          </div>

          <label class="field grid gap-1.5">
            <span class="ledger">Credit on the ZVM</span>
            <input v-model="inTo" class="mono text-[13.5px] field-input bg-transparent outline-none w-full" placeholder="0x…" spellcheck="false" aria-label="EVM address to credit" />
            <span v-if="wallet.address && inTo === wallet.address" class="text-[12px] text-dim">Your connected {{ wallet.name }} wallet.</span>
          </label>

          <button class="btn justify-center py-3 text-[15px]" :class="inAction.ok ? 'btn-plasma' : ''" :disabled="!inAction.ok" @click="deposit">
            {{ inAction.label }}
          </button>

          <p v-if="!zenon.present" class="text-[12.5px] text-dim">
            Deposits are signed by the Syrius extension, and none was found in this browser. Install it and reload, or
            send to the vault from any Zenon wallet with <code class="mono">zvm deposit -to 0x…</code>. A bare send with
            no call credits an address no EVM wallet holds.
          </p>
          <p v-else-if="chainMismatch" class="text-[12.5px]" style="color: var(--warn)">
            Syrius signs for chain {{ zenon.chainId }}, and this bridge is on Zenon chain {{ bridge.nomChainId }}. In
            Syrius, open Settings → Node, select a chain {{ bridge.nomChainId }} node and press Use chain
            {{ bridge.nomChainId }}.
          </p>
          <p v-else-if="zenon.address" class="text-[12px] text-dim">Signing as <span class="mono">{{ short(zenon.address, 8, 6) }}</span></p>
          <p v-if="zenon.error || inError" class="text-[12.5px] break-words" style="color: var(--danger)">{{ inError || zenon.error }}</p>

          <div v-if="inHash" class="rounded p-3 grid gap-1.5 text-[13px]" style="background: var(--sunk)">
            <div class="flex items-center justify-between gap-2">
              <span>Zenon send <span class="mono text-dim">{{ short(inHash, 8, 6) }}</span></span>
              <Chip v-if="!inSeen" tone="warn" dot>Waiting for a momentum</Chip>
              <Chip v-else-if="inSeen.status === 'included'" tone="l2" dot>Credited</Chip>
              <Chip v-else tone="bad">{{ inSeen.status }}</Chip>
            </div>
            <p v-if="inSeen?.reason" class="text-[12.5px]" style="color: var(--danger)">{{ inSeen.reason }}</p>
            <a v-if="inSeen?.txs?.[0] && txUrl(inSeen.txs[0])" class="link mono text-[12px]" :href="txUrl(inSeen.txs[0])!" target="_blank" rel="noreferrer noopener">
              ZVM transaction {{ short(inSeen.txs[0], 10, 6) }}
            </a>
            <p v-if="!inSeen" class="text-[12px] text-dim">A deposit is credited when the momentum carrying it is derived, normally within thirty seconds.</p>
          </div>
        </template>

        <!-- Out -->
        <template v-else>
          <div class="field">
            <div class="flex items-center justify-between gap-2 mb-2">
              <span class="ledger">From the ZVM</span>
              <button
                v-if="zvmBalance[outToken] !== null"
                class="text-[12px] text-dim hover:text-fg"
                title="Use the whole balance"
                @click="outAmount = units(zvmBalance[outToken]!, NOM_DECIMALS, 8).replace(/,/g, '')"
              >
                Balance <span class="mono">{{ nom(zvmBalance[outToken]) }}</span>
              </button>
            </div>
            <div class="flex items-center gap-3">
              <input v-model="outAmount" class="amount" inputmode="decimal" placeholder="0" aria-label="Amount to withdraw" />
              <div class="flex gap-1 shrink-0">
                <button v-for="t in ['ZNN', 'QSR'] as const" :key="t" class="pill" :class="outToken === t ? '' : 'opacity-50'" @click="outToken = t">
                  <TokenLogo :symbol="t" :size="20" /> {{ t }}
                </button>
              </div>
            </div>
          </div>

          <label class="field grid gap-1.5">
            <span class="ledger">Pay on Zenon</span>
            <input v-model="outTo" class="mono text-[13.5px] field-input bg-transparent outline-none w-full" placeholder="z1…" spellcheck="false" aria-label="Zenon address to pay" />
            <span v-if="zenon.address && outTo === zenon.address" class="text-[12px] text-dim">Your connected Syrius account.</span>
          </label>

          <dl v-if="fee !== null" class="grid gap-1.5 text-[13px] rounded p-3" style="background: var(--sunk)">
            <div class="flex justify-between gap-3">
              <dt class="text-dim">Fee, kept by the vault</dt>
              <dd class="mono">{{ nom(fee, 8) }} {{ outToken }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-dim">Arrives on Zenon</dt>
              <dd class="mono">{{ parse(outAmount) > fee ? nom(parse(outAmount) - fee, 8) : '0' }} {{ outToken }}</dd>
            </div>
          </dl>

          <button class="btn justify-center py-3 text-[15px]" :class="outAction.ok ? 'btn-plasma' : ''" :disabled="!outAction.ok" @click="withdraw">
            {{ outAction.label }}
          </button>

          <StepRail :steps="steps" />

          <div v-if="withdrawal" class="rounded p-3 grid gap-1.5 text-[13px]" style="background: var(--sunk)">
            <div class="flex items-center justify-between gap-2">
              <span>Withdrawal <span class="mono">#{{ withdrawal.id }}</span></span>
              <Chip v-if="withdrawal.paidIn" tone="l2" dot>Paid on Zenon</Chip>
              <Chip v-else tone="warn" dot>Waiting for the vault</Chip>
            </div>
            <p v-if="withdrawal.paidIn" class="text-[12px] text-dim">
              Zenon block <span class="mono">{{ short(withdrawal.paidIn.replace(/^0x/, ''), 10, 6) }}</span>
            </p>
            <p v-else class="text-[12px] text-dim">
              Locked on the ZVM now. The committee pays it once the block is {{ bridge.finalityDepth }} momentums deep,
              and every node derives that payout back into the bridge contract, which is what turns this green.
            </p>
          </div>

          <p class="text-[12px] text-dim">
            This direction trusts the committee: it can refuse to pay or pay the wrong party, and cannot mint on the
            ZVM. A payout that matches no withdrawal is flagged, not accepted.
          </p>
        </template>
      </section>

      <BridgeStatus />
    </div>

    <Panel title="Your recent movements" :subtitle="movementsNote">
      <template #actions>
        <button class="tab" :class="movements === 'out' ? 'tab-on' : ''" @click="movements = 'out'">Withdrawals</button>
        <button class="tab" :class="movements === 'in' ? 'tab-on' : ''" @click="movements = 'in'">Deposits</button>
      </template>

      <div v-if="!connectedAny" class="px-4 py-6 text-[13px] text-dim flex flex-wrap items-center gap-3">
        <span>Connect a wallet to see your deposits and withdrawals.</span>
        <button class="btn btn-sm" @click="askToConnect">Connect wallet</button>
      </div>
      <p v-else-if="mine.error" class="px-4 py-5 text-[13px]" style="color: var(--danger)">Could not read your movements: {{ mine.error }}</p>

      <template v-else-if="movements === 'out'">
        <p v-if="!wallet.address" class="px-4 py-5 text-[13px] text-dim">Withdrawals are made from an EVM wallet. Connect one to see yours.</p>
        <p v-else-if="mine.loading && !mine.withdrawals.length" class="px-4 py-5 text-[13px] text-dim">Reading your withdrawals…</p>
        <p v-else-if="!mine.withdrawals.length" class="px-4 py-5 text-[13px] text-dim">You have not withdrawn anything from this wallet.</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-[13px] min-w-[640px]">
            <thead>
              <tr>
                <th class="th">Withdrawal</th>
                <th class="th">Age</th>
                <th class="th text-right">Arrives</th>
                <th class="th">Payee on Zenon</th>
                <th class="th">Status</th>
                <th class="th">ZVM transaction</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in mine.withdrawals" :key="String(w.id)">
                <td class="td mono">#{{ w.id }}</td>
                <td class="td text-dim">{{ w.timestamp ? ago(w.timestamp) : `block ${w.block}` }}</td>
                <td class="td text-right num">{{ nom(w.amount) }} <span class="text-dim">{{ w.token }}</span></td>
                <td class="td mono text-[12.5px] text-dim">{{ short(hexToNom(w.to), 7, 5) }}</td>
                <td class="td">
                  <Chip v-if="w.paidIn" tone="l2" dot :title="`Zenon block ${w.paidIn.replace(/^0x/, '')}`">Paid on Zenon</Chip>
                  <Chip v-else tone="warn" dot>Waiting for the vault</Chip>
                </td>
                <td class="td">
                  <a v-if="txUrl(w.tx)" class="link mono text-[12.5px]" :href="txUrl(w.tx)!" target="_blank" rel="noreferrer noopener">{{ short(w.tx, 8, 4) }}</a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <template v-else>
        <p v-if="mine.loading && !mine.deposits.length" class="px-4 py-5 text-[13px] text-dim">Reading your deposits…</p>
        <p v-else-if="!mine.deposits.length" class="px-4 py-5 text-[13px] text-dim">No deposits found for your connected wallets.</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-[13px] min-w-[560px]">
            <thead>
              <tr>
                <th class="th">Status</th>
                <th class="th">Momentum</th>
                <th class="th text-right">Amount</th>
                <th class="th">Zenon send</th>
                <th class="th">ZVM transaction</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in mine.deposits" :key="d.nomHash">
                <td class="td">
                  <Chip :tone="d.status === 'included' ? 'l1' : 'bad'" :title="d.reason || undefined">{{ d.status === 'included' ? 'credited' : d.status }}</Chip>
                </td>
                <td class="td num text-dim">{{ d.momentum ?? '—' }}</td>
                <td class="td text-right num">{{ nom(d.amount) }} <span class="text-dim">{{ d.token }}</span></td>
                <td class="td mono text-[12.5px] text-dim">{{ short(d.nomHash, 8, 4) }}</td>
                <td class="td">
                  <a v-if="d.tx && txUrl(d.tx)" class="link mono text-[12.5px]" :href="txUrl(d.tx)!" target="_blank" rel="noreferrer noopener">{{ short(d.tx, 8, 4) }}</a>
                  <span v-else class="text-dim" :title="d.reason">{{ d.reason || '—' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </Panel>
  </div>
</template>
