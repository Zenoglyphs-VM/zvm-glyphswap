<script setup lang="ts">
// Choosing a token. The list is everything the factory has a pool for, plus
// anything pasted in, sorted by what the connected account actually holds,
// because the token you want is usually one you own.
import {computed, nextTick, ref, watch} from 'vue'
import {canonicalRank, dex, forgetToken, importToken, isCanonical, tokenByKey} from '../core/dex'
import {wallet} from '../core/wallet'
import {watchAsset} from '../core/evm'
import {tokenKey, type Token} from '../core/uniswap'
import {short, units} from '../core/format'
import Icon from './Icon.vue'
import Modal from './Modal.vue'
import TokenLogo from './TokenLogo.vue'

const props = defineProps<{open: boolean; exclude?: string}>()
const emit = defineEmits<{(e: 'close'): void; (e: 'pick', key: string): void}>()

const query = ref('')
const error = ref('')
const busy = ref(false)
const field = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    query.value = ''
    error.value = ''
    nextTick(() => field.value?.focus())
  },
)

const balance = (t: Token) => dex.balances[tokenKey(t)] ?? 0n

const listed = computed(() => {
  const q = query.value.trim().toLowerCase()
  const match = (t: Token) =>
    !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase().includes(q)
  // The chain's own three first and in their own order, then whatever you hold
  // most of. A token you happen to own should not push ZNN down the list.
  return dex.tokens
    .filter((t) => tokenKey(t) !== props.exclude && match(t))
    .slice()
    .sort((a, b) => {
      const ra = canonicalRank(a)
      const rb = canonicalRank(b)
      if (ra !== rb) return ra - rb
      const ba = balance(a)
      const bb = balance(b)
      if (ba !== bb) return ba > bb ? -1 : 1
      return 0
    })
})

/** A pasted address that is not on the list yet, so the button can offer it. */
const unlisted = computed(() => {
  const q = query.value.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(q)) return null
  if (dex.tokens.some((t) => t.address.toLowerCase() === q.toLowerCase())) return null
  return q
})

/** The chain's own tokens, offered as chips: what most trades here are denominated in. */
const common = computed(() =>
  dex.tokens.filter(isCanonical).slice().sort((a, b) => canonicalRank(a) - canonicalRank(b)),
)

function choose(key: string) {
  emit('pick', key)
  emit('close')
}

async function add() {
  if (!unlisted.value) return
  busy.value = true
  error.value = ''
  try {
    const t = await importToken(unlisted.value)
    choose(tokenKey(t))
  } catch (err: any) {
    error.value = err?.shortMessage ?? err?.message ?? String(err)
  } finally {
    busy.value = false
  }
}

function drop(t: Token, event: Event) {
  event.stopPropagation()
  forgetToken(t.address)
}

const isImported = (t: Token) => dex.imported.some((a) => a.toLowerCase() === t.address.toLowerCase())

async function toWallet(t: Token, event: Event) {
  event.stopPropagation()
  if (!wallet.provider || t.native) return
  await watchAsset(wallet.provider, t)
}

const picked = (key: string) => tokenByKey(key)
void picked
</script>

<template>
  <Modal :open="open" title="Select a token" :width="420" @close="emit('close')">
    <div class="p-4 pb-3 grid gap-3 border-b border-line">
      <input
        ref="field"
        v-model="query"
        class="input"
        spellcheck="false"
        autocomplete="off"
        placeholder="Search by name, symbol or address"
        aria-label="Search tokens"
      />
      <div v-if="common.length" class="flex flex-wrap gap-1.5">
        <button
          v-for="t in common"
          :key="tokenKey(t)"
          class="pill"
          :disabled="tokenKey(t) === exclude"
          :style="tokenKey(t) === exclude ? 'opacity:.4;cursor:not-allowed' : ''"
          @click="choose(tokenKey(t))"
        >
          <TokenLogo :symbol="t.symbol" :address="t.address" :size="20" />
          <span class="text-[13px]">{{ t.symbol }}</span>
        </button>
      </div>
    </div>

    <div class="max-h-[50vh] overflow-y-auto">
      <button
        v-for="t in listed"
        :key="tokenKey(t)"
        class="w-full text-left px-4 py-2.5 flex items-center gap-3 hover:bg-surface transition-colors"
        @click="choose(tokenKey(t))"
      >
        <TokenLogo :symbol="t.symbol" :address="t.address" :size="30" />
        <span class="min-w-0 grow">
          <span class="flex items-center gap-1.5 text-[14px] leading-tight">
            {{ t.symbol }}
            <!-- Matched on the address, so a contract that borrows the symbol
                 gets no tick. -->
            <Icon v-if="isCanonical(t)" name="ok" :size="13" style="color: var(--znn-ink)" title="Verified" />
          </span>
          <span class="block text-[12px] text-dim truncate">
            {{ t.name }}
            <span v-if="!t.native" class="mono">{{ short(t.address) }}</span>
          </span>
        </span>
        <span class="mono text-[13px] text-right shrink-0">{{ units(balance(t), t.decimals, 4) }}</span>
        <span class="flex items-center gap-1 shrink-0">
          <span
            v-if="!t.native && wallet.address"
            class="p-1 rounded text-dim hover:text-fg"
            title="Add to your wallet"
            role="button"
            tabindex="0"
            @click="toWallet(t, $event)"
            @keydown.enter.stop="toWallet(t, $event)"
          >
            <Icon name="plus" :size="13" />
          </span>
          <span
            v-if="isImported(t)"
            class="p-1 rounded text-dim hover:text-fg"
            title="Remove from your list"
            role="button"
            tabindex="0"
            @click="drop(t, $event)"
            @keydown.enter.stop="drop(t, $event)"
          >
            <Icon name="trash" :size="13" />
          </span>
        </span>
      </button>

      <div v-if="unlisted" class="px-4 py-3 border-t border-line grid gap-2">
        <p class="text-[13px]">
          That address is not on the list. Check it is the token you mean before trading it: anyone can deploy a
          contract that calls itself anything.
        </p>
        <button class="btn btn-sm btn-plasma justify-self-start" :disabled="busy" @click="add">
          {{ busy ? 'Reading the contract' : 'Import this token' }}
        </button>
      </div>

      <p v-else-if="!listed.length" class="px-4 py-6 text-[13px] text-dim">
        Nothing matches. Paste a contract address to add a token that has no pool yet.
      </p>

      <p v-if="error" class="px-4 pb-3 text-[13px]" style="color: var(--danger)">{{ error }}</p>
    </div>
  </Modal>
</template>
