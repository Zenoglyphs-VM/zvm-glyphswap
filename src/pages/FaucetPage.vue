<script setup lang="ts">
// Devnet funds, moved here from the explorer: the faucet is where a trader
// starts, and this is the app they start in. The node proxies it at
// /api/faucet (zvm-node/api/api.go), so like the bridge it needs a zvm node.
//
// The faucet takes either spelling of an address (faucet.ParseAnyAddress) and
// pays it on the one layer it can use: ZNN, QSR and a plasma fusion on Zenon
// when a Zenon key can sign for the 20 bytes, ZNN on the ZVM otherwise. It used
// to pay ZVM ZNN to a Zenon address too, where only a native call can spend it.
import {computed, onMounted, ref, watch} from 'vue'
import {hexToNom, isNomAddress, isNomUser, toEvmAddress} from '@zvm/web/address'
import Chip from '@zvm/web/components/Chip.vue'
import {endpoint} from '../core/endpoint'
import {wallet} from '../core/wallet'
import {zenon, watchZenon} from '../core/syrius'
import {number, short, units, znn} from '../core/format'
import Panel from '../components/Panel.vue'
import Icon from '../components/Icon.vue'
import InfoTip from '../components/InfoTip.vue'

interface Status {
  cooldown?: string
  served?: number
  l2Balance?: string
  drip?: {l1Znn?: string; l1Qsr?: string; fuseQsr?: string; l2ZnnWei?: string}
}

const address = ref('')
const busy = ref(false)
const error = ref('')
const result = ref<any>(null)
const status = ref<Status | null>(null)
const statusError = ref('')
const loading = ref(true)

async function loadStatus() {
  if (!endpoint.apiBase) {
    status.value = null
    statusError.value = 'This node is not a zvm node, so it has no faucet. Choose a zvm node.'
    loading.value = false
    return
  }
  try {
    const res = await fetch(`${endpoint.apiBase}/api/faucet`, {signal: AbortSignal.timeout(8000)})
    if (!res.ok) throw new Error(`${res.status}`)
    status.value = await res.json()
    statusError.value = ''
  } catch {
    // A node can run without a faucet; that is a fact about the node, not a failure.
    status.value = null
    statusError.value = 'This node is not running a faucet. Choose one that is, or start `zvm faucet` beside it.'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadStatus()
  watchZenon()
})
watch(() => endpoint.apiBase, loadStatus)

// Whichever wallet is connected fills the field, so the common case is one
// click. The EVM wallet wins: it is the one that trades here.
watch(
  [() => wallet.address, () => zenon.address],
  ([evm, nom]) => {
    if (!address.value) address.value = evm ?? nom ?? ''
  },
  {immediate: true},
)

const trimmed = computed(() => address.value.trim())

/** The same 20 bytes in both spellings, or null when it is neither. */
const spellings = computed<{evm: string; nom: string} | null>(() => {
  const a = trimmed.value
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) return {evm: a, nom: hexToNom(a)}
    if (isNomAddress(a)) return {evm: toEvmAddress(a), nom: a}
  } catch {
    /* a bad checksum is simply not an address */
  }
  return null
})

// Only bytes starting 0x00 have a Zenon key behind them, and those are paid on
// Zenon alone. Anything else exists on the ZVM alone.
const onZenon = computed(() => !!spellings.value && isNomUser(spellings.value.evm))

const hint = computed(() => {
  if (!trimmed.value) return {text: 'Paste a 0x or z1 address, or connect a wallet.', tone: 'dim'}
  if (!spellings.value) return {text: 'Not an address. It is 0x and 40 hex characters, or z1… from Syrius.', tone: 'bad'}
  return onZenon.value
    ? {text: 'Funds on Zenon only. For ZNN on the ZVM, use your EVM (0x…) address.', tone: 'ok'}
    : {text: 'ZNN on the ZVM only: no Zenon key can sign for these bytes.', tone: 'ok'}
})

async function drip() {
  if (!spellings.value) return
  busy.value = true
  error.value = ''
  result.value = null
  try {
    const res = await fetch(`${endpoint.apiBase}/api/faucet`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({address: trimmed.value}),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(text.trim() || `the faucet answered ${res.status}`)
    result.value = JSON.parse(text)
    loadStatus()
  } catch (err: any) {
    error.value = err?.name === 'TimeoutError' ? 'The faucet did not answer within a minute.' : (err?.message ?? String(err))
  } finally {
    busy.value = false
  }
}

const nom = (v?: string) => (v == null ? '—' : units(v, 8, 4))
const txUrl = (hash: string) => (endpoint.apiBase ? `${endpoint.apiBase}/tx/${hash}` : null)
</script>

<template>
  <div class="grid gap-5">
    <div class="panel px-4 py-3">
      <h1 class="text-[22px] font-semibold tracking-[-0.02em] flex items-center gap-1.5">
        Faucet
        <InfoTip label="About the faucet">
          Devnet funds. An EVM address gets ZNN on the ZVM to trade with. A Zenon address gets ZNN, QSR and a plasma
          fusion on Zenon instead, so Syrius can publish without computing proof of work.
        </InfoTip>
      </h1>
    </div>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)] items-start">
      <section class="panel p-4 grid gap-3">
        <label class="field grid gap-1.5">
          <span class="ledger">Address to fund</span>
          <input
            v-model="address"
            class="mono text-[14px] field-input bg-transparent outline-none w-full"
            placeholder="0x… or z1…"
            spellcheck="false"
            autocomplete="off"
            aria-label="Address to fund"
          />
          <span class="text-[12px]" :style="{color: hint.tone === 'bad' ? 'var(--danger)' : hint.tone === 'ok' ? 'var(--znn-ink)' : 'var(--dim)'}">
            {{ hint.text }}
          </span>
        </label>

        <!-- The same 20 bytes in each layer's spelling, dimmed where nothing is paid. -->
        <dl v-if="spellings" class="grid gap-1.5 text-[12.5px] rounded p-3" style="background: var(--sunk)">
          <div class="flex items-baseline gap-2 min-w-0" :class="onZenon ? 'opacity-50' : ''">
            <dt class="ledger w-[52px] shrink-0">ZVM</dt>
            <dd class="mono break-all" style="color: var(--znn-ink)">{{ spellings.evm }}</dd>
          </div>
          <div class="flex items-baseline gap-2 min-w-0" :class="onZenon ? '' : 'opacity-50'">
            <dt class="ledger w-[52px] shrink-0">Zenon</dt>
            <dd class="mono break-all" style="color: var(--nom-ink)">{{ spellings.nom }}</dd>
          </div>
        </dl>

        <button
          class="btn justify-center py-3 text-[15px]"
          :class="spellings && !statusError && !busy ? 'btn-plasma' : ''"
          :disabled="busy || !spellings || !!statusError"
          @click="drip"
        >
          {{ busy ? 'Sending…' : 'Send me funds' }}
        </button>

        <p v-if="statusError" class="text-[13px] text-dim">{{ statusError }}</p>
        <p v-if="error" class="text-[13px] flex items-start gap-2 break-words" style="color: var(--danger)">
          <Icon name="alert" :size="15" class="mt-0.5 shrink-0" />{{ error }}
        </p>

        <div v-if="result" class="rounded p-3 grid gap-1.5 text-[13px]" style="background: var(--sunk)">
          <div><Chip tone="l2" dot>Sent</Chip></div>
          <div v-if="result.l2Tx" class="flex gap-2">
            <span class="text-dim w-[120px] shrink-0">ZVM transfer</span>
            <a v-if="txUrl(result.l2Tx)" class="link mono" :href="txUrl(result.l2Tx)!" target="_blank" rel="noreferrer noopener">{{ short(result.l2Tx, 10, 6) }}</a>
          </div>
          <div v-if="result.l1ZnnBlock" class="flex gap-2">
            <span class="text-dim w-[120px] shrink-0">Zenon ZNN</span><span class="mono">{{ short(result.l1ZnnBlock, 10, 6) }}</span>
          </div>
          <div v-if="result.l1QsrBlock" class="flex gap-2">
            <span class="text-dim w-[120px] shrink-0">Zenon QSR</span><span class="mono">{{ short(result.l1QsrBlock, 10, 6) }}</span>
          </div>
          <div v-if="result.l1FuseBlock" class="flex gap-2">
            <span class="text-dim w-[120px] shrink-0">Plasma fusion</span><span class="mono">{{ short(result.l1FuseBlock, 10, 6) }}</span>
          </div>
          <p v-if="result.l1ZnnBlock" class="text-[12.5px] text-dim mt-1">
            On Zenon a send is not a balance until a receive block is published. Opening Syrius does it for you.
            For ZNN on the ZVM, ask again with your EVM (0x…) address.
          </p>
          <p v-if="result.l2Tx" class="text-[12.5px] text-dim">
            ZVM funds arrive with the next block. To move them to Zenon or back, use the
            <router-link to="/bridge" class="link">bridge</router-link>.
          </p>
        </div>
      </section>

      <Panel title="What a drip contains">
        <p v-if="loading" class="px-4 py-5 text-[13px] text-dim">Loading…</p>
        <p v-else-if="!status" class="px-4 py-5 text-[13px] text-dim">No faucet on this node.</p>
        <dl v-else class="p-4 grid gap-2 text-[13px]">
          <div class="flex justify-between gap-3">
            <dt class="text-dim">ZNN on the ZVM</dt>
            <dd class="num">{{ znn(status.drip?.l2ZnnWei) }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">ZNN on Zenon</dt>
            <dd class="num">{{ nom(status.drip?.l1Znn) }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">QSR on Zenon</dt>
            <dd class="num">{{ nom(status.drip?.l1Qsr) }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">QSR fused for plasma</dt>
            <dd class="num">{{ nom(status.drip?.fuseQsr) }}</dd>
          </div>
          <div class="flex justify-between gap-3 border-t border-line pt-2 mt-1">
            <dt class="text-dim">Cooldown</dt>
            <dd class="num">{{ status.cooldown ?? '—' }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Served</dt>
            <dd class="num">{{ number(status.served) }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Faucet balance</dt>
            <dd class="num">{{ znn(status.l2Balance, 0) }} ZNN</dd>
          </div>
        </dl>
      </Panel>
    </div>
  </div>
</template>
