<script setup lang="ts">
// Syrius, MetaMask, Rabby, Phantom, and anything else announcing itself
// through EIP-6963. Syrius is listed first, and listed even when it is missing
// or too old to offer an EVM account, since it is the wallet Zenon users
// already hold (core/syriusZvm.ts). Connected, the same button opens the
// account: what this browser has sent, and the way out.
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {wallet, walletPicker, connectWallet, disconnectWallet, wrongChain, switchToChain} from '../core/wallet'
import {knownWallets, requestWallets, onWallets, type Discovered} from '../core/evm'
import {isSyrius, refusal, syriusFirst, syriusState, walletIcon, SYRIUS_ICON, SYRIUS_URL} from '../core/syriusZvm'
import {endpoint} from '../core/endpoint'
import {chainName} from '../core/chains'
import {activity, clearActivity, STEP_WORD} from '../core/tx'
import {ago, short} from '../core/format'
import {cachedName, nameOf} from '@zvm/web/names'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import Chip from '@zvm/web/components/Chip.vue'

const wallets = ref<Discovered[]>([])
const picking = ref(false)
const account = ref(false)
const busy = ref(false)
const copied = ref(false)

let off: (() => void) | undefined
onMounted(() => {
  wallets.value = requestWallets()
  off = onWallets(() => (wallets.value = knownWallets()))
})
onUnmounted(() => off?.())

const canConnect = computed(() => endpoint.health === 'ok' && endpoint.chainId !== null)

// An outdated Syrius is listed with its reason in place of a working button.
const listed = computed(() => syriusFirst(wallets.value).filter((w) => !refusal(w)))
const syrius = computed(() => syriusState(wallets.value))

const mine = computed(() => activity.items.filter((a) => a.chainId === endpoint.chainId))

async function pick(w: Discovered) {
  busy.value = true
  try {
    await connectWallet(w)
    picking.value = false
  } catch {
    // wallet.error carries the message, and the header shows it.
  } finally {
    busy.value = false
  }
}

// A form elsewhere on the page asked for the wallet list.
// The wallet reads as its ZNS primary name when it has one.
const primary = computed(() => cachedName(wallet.address))
watch(() => [wallet.address, endpoint.chainId] as const, ([a, chainId]) => a && nameOf(chainId, a), {immediate: true})

watch(
  () => walletPicker.open,
  (want) => {
    if (!want) return
    walletPicker.open = false
    if (!wallet.address) open()
  },
)

function open() {
  if (wallet.address) {
    account.value = true
    return
  }
  wallets.value = requestWallets()
  picking.value = true
}

async function copyAddress() {
  if (!wallet.address) return
  try {
    await navigator.clipboard.writeText(wallet.address)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {
    /* a browser that refuses the clipboard leaves the address on screen to select */
  }
}

function leave() {
  disconnectWallet()
  account.value = false
}

const explorerTx = (hash: string) => (endpoint.apiBase ? `${endpoint.apiBase}/tx/${hash}` : null)
</script>

<template>
  <div class="flex items-center gap-1.5">
    <button
      v-if="wrongChain"
      class="btn btn-sm"
      style="color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent)"
      @click="switchToChain"
    >
      <Icon name="alert" :size="13" />
      <span class="hidden sm:inline">Switch to {{ chainName(endpoint.chainId) }}</span>
      <span class="sm:hidden">Switch</span>
    </button>

    <!-- Only while it is an invitation. Connected, this button shows the
         address and opens the account, and a green address on hover would
         read as the connected dot rather than as a hover state. -->
    <button
      class="btn btn-sm"
      :class="wallet.address ? '' : 'btn-connect'"
      :disabled="busy || (!canConnect && !wallet.address)"
      @click="open"
    >
      <span class="dot" :style="{background: wallet.address ? 'var(--znn-ink)' : 'var(--line-strong)'}" />
      <span v-if="primary" class="text-[13px] font-medium max-w-[160px] truncate">{{ primary }}</span>
      <span v-else class="mono text-[12px]">{{ wallet.address ? short(wallet.address) : 'Connect wallet' }}</span>
    </button>

    <Modal :open="picking" title="Connect a wallet" :width="380" @close="picking = false">
      <div class="p-3 grid gap-1">
        <!-- Syrius comes first, and is offered even when it cannot be picked,
             because the person holding a Zenon wallet is the one most likely to
             look for it here. When it can be picked, it heads the list below. -->
        <div v-if="syrius.kind !== 'ready'" class="px-3 py-2.5 rounded flex items-start gap-3">
          <img :src="SYRIUS_ICON" alt="" class="w-6 h-6 rounded opacity-50" />
          <span class="grid gap-0.5 min-w-0">
            <span class="text-[14px] text-dim">Syrius</span>
            <span v-if="syrius.kind === 'outdated'" class="text-[12px]" style="color: var(--warn)">
              {{ syrius.reason }}
              <a class="link" :href="SYRIUS_URL" target="_blank" rel="noreferrer noopener">Get the latest</a>, then reload this page.
            </span>
            <span v-else-if="syrius.kind === 'zenonOnly'" class="text-[12px] text-dim">
              This Syrius has no ZVM account. Update it to 0.4.0 or later, then reload this page.
            </span>
            <span v-else class="text-[12px] text-dim">
              Not in this browser.
              <a class="link" :href="SYRIUS_URL" target="_blank" rel="noreferrer noopener">Get Syrius</a>
              (0.4.0 or later) to trade with your Zenon recovery phrase.
            </span>
          </span>
        </div>
        <button
          v-for="w in listed"
          :key="w.id"
          class="w-full text-left px-3 py-2.5 rounded flex items-center gap-3 hover:bg-surface transition-colors"
          :disabled="busy"
          @click="pick(w)"
        >
          <img v-if="walletIcon(w)" :src="walletIcon(w)" alt="" class="w-6 h-6 rounded" />
          <Icon v-else name="wallet" :size="18" class="text-dim" />
          <span class="grid min-w-0">
            <span class="text-[14px]">{{ w.name }}</span>
            <span v-if="isSyrius(w)" class="text-[12px] text-dim">
              Zenon's wallet. Its ZVM account comes from the same recovery phrase.
            </span>
          </span>
        </button>
        <p v-if="!wallets.length" class="px-3 py-4 text-[13px] text-dim">
          No EVM wallet answered in this browser. Install Syrius, MetaMask, Rabby or Phantom, then reload this page.
        </p>
        <p class="px-3 pt-2 pb-1 text-[12px] text-dim border-t border-line mt-2">
          Your wallet signs an ordinary EVM transaction. A relayer posts it to Zenon, which orders it into the
          next momentum.
        </p>
      </div>
    </Modal>

    <Modal :open="account" title="Account" :width="440" @close="account = false">
      <div class="p-4 grid gap-4">
        <div class="flex items-center gap-3">
          <img v-if="wallet.icon" :src="wallet.icon" alt="" class="w-8 h-8 rounded" />
          <Icon v-else name="wallet" :size="22" class="text-dim" />
          <div class="min-w-0">
            <div class="mono text-[14px] truncate">{{ wallet.address }}</div>
            <div class="text-[12px] text-dim">{{ wallet.name }} on {{ chainName(wallet.chainId) }}</div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2">
          <button class="btn btn-sm" @click="copyAddress">
            <Icon :name="copied ? 'check' : 'copy'" :size="13" />
            {{ copied ? 'Copied' : 'Copy address' }}
          </button>
          <a
            v-if="endpoint.apiBase && wallet.address"
            class="btn btn-sm"
            :href="`${endpoint.apiBase}/address/${wallet.address}`"
            target="_blank"
            rel="noreferrer noopener"
            ><Icon name="external" :size="13" /> View on the node</a
          >
          <span class="grow" />
          <button class="btn btn-sm btn-quiet" @click="leave">Disconnect</button>
        </div>

        <div class="border-t border-line pt-3 grid gap-2">
          <div class="flex items-center justify-between">
            <span class="ledger">Sent from this browser</span>
            <button v-if="mine.length" class="btn btn-sm btn-quiet" @click="clearActivity">Clear</button>
          </div>
          <p v-if="!mine.length" class="text-[13px] text-dim">
            Nothing yet. Trades you send here will be listed, with a link to the node that carried them.
          </p>
          <ol v-else class="grid gap-1.5">
            <li v-for="a in mine" :key="a.hash" class="flex items-center justify-between gap-3 text-[13px]">
              <span class="min-w-0 truncate">{{ a.label }}</span>
              <span class="flex items-center gap-2 shrink-0">
                <Chip :tone="a.state === 'done' ? 'l2' : a.state === 'failed' ? 'bad' : 'l1'" dot>{{
                  STEP_WORD[a.state]
                }}</Chip>
                <span class="text-dim text-[12px]">{{ ago(Math.floor(a.at / 1000)) }}</span>
                <a
                  v-if="explorerTx(a.hash)"
                  class="link"
                  :href="explorerTx(a.hash)!"
                  target="_blank"
                  rel="noreferrer noopener"
                  :title="a.hash"
                  ><Icon name="external" :size="13"
                /></a>
              </span>
            </li>
          </ol>
        </div>
      </div>
    </Modal>
  </div>
</template>
