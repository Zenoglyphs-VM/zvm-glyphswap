<script setup lang="ts">
// Depositing into a pool.
//
// A deposit has to arrive at the pool's current ratio, so typing one side fills
// the other. The exception is a pool that does not exist yet: then the two
// amounts you choose are what sets the price, and nothing is filled in for you.
import {computed, ref, watch} from 'vue'
import {dex, refreshPools, tokenByKey} from '../core/dex'
import {endpoint} from '../core/endpoint'
import {publicClient} from '../core/evm'
import {askToConnect, wallet, wrongChain} from '../core/wallet'
import {settings} from '../core/settings'
import {runCalls, type Step} from '../core/tx'
import {plain, units} from '../core/format'
import {
  addLiquidityCall,
  allowance,
  approveCall,
  deadlineIn,
  MAX_UINT,
  parseAmount,
  poolFor,
  quote,
  reservesFor,
  same,
  tokenKey,
  type Call,
} from '../core/uniswap'
import Icon from './Icon.vue'
import TokenLogo from './TokenLogo.vue'
import TokenPicker from './TokenPicker.vue'
import StepRail from './StepRail.vue'

const props = defineProps<{aKey: string; bKey: string; locked?: boolean}>()
const emit = defineEmits<{(e: 'update:aKey', v: string): void; (e: 'update:bKey', v: string): void}>()

const amountA = ref('')
const amountB = ref('')
const busy = ref(false)
const error = ref('')
const steps = ref<Step[]>([])
const picking = ref<'a' | 'b' | null>(null)
/** Which side the person last typed into, so filling the other does not fight them. */
const driver = ref<'a' | 'b'>('a')

const tokenA = computed(() => tokenByKey(props.aKey))
const tokenB = computed(() => tokenByKey(props.bKey))

// On a pool page the pair is already decided, so the label names the token
// rather than telling someone which of two slots they are looking at.
const labelA = computed(() => (props.locked && tokenA.value ? `Deposit ${tokenA.value.symbol}` : 'First token'))
const labelB = computed(() => (props.locked && tokenB.value ? `Deposit ${tokenB.value.symbol}` : 'Second token'))

const pool = computed(() => {
  if (!tokenA.value || !tokenB.value) return undefined
  return poolFor(dex.pools, tokenA.value.address, tokenB.value.address)
})

/**
 * Which side of a fixed pair is ZNN, under either spelling.
 *
 * A pool holds wrapped ZNN, so a pool page names WZNN on that side. Almost
 * nobody holds any: the balance people have is ZNN, and the router takes it
 * directly through `addLiquidityETH`. So the deposit defaults to ZNN and this
 * offers the wrapped form to the few who want it, rather than leaving someone
 * staring at a field they cannot fill.
 */
const znnSide = computed<'a' | 'b' | null>(() => {
  if (!props.locked || !dex.weth) return null
  if (tokenA.value && same(tokenA.value.address, dex.weth)) return 'a'
  if (tokenB.value && same(tokenB.value.address, dex.weth)) return 'b'
  return null
})

const depositNative = computed({
  get: () => {
    const side = znnSide.value
    if (!side) return false
    return (side === 'a' ? tokenA.value : tokenB.value)?.native === true
  },
  set: (v: boolean) => {
    const side = znnSide.value
    if (!side || !dex.weth) return
    const key = v ? 'znn' : dex.weth.toLowerCase()
    if (side === 'a') emit('update:aKey', key)
    else emit('update:bKey', key)
  },
})

const isNew = computed(() => !pool.value || pool.value.totalSupply === 0n)

const parsedA = computed(() => (tokenA.value ? parseAmount(amountA.value, tokenA.value.decimals) : null))
const parsedB = computed(() => (tokenB.value ? parseAmount(amountB.value, tokenB.value.decimals) : null))

const balanceA = computed(() => (tokenA.value ? dex.balances[tokenKey(tokenA.value)] : undefined))
const balanceB = computed(() => (tokenB.value ? dex.balances[tokenKey(tokenB.value)] : undefined))

/** The other side, at the pool's ratio. Silent when the pool sets its own price. */
function mirror(from: 'a' | 'b') {
  const p = pool.value
  if (!p || isNew.value || !tokenA.value || !tokenB.value) return
  if (from === 'a') {
    const v = parsedA.value
    if (v === null) return
    const [rA, rB] = reservesFor(p, tokenA.value.address)
    amountB.value = v === 0n ? '' : plain(quote(v, rA, rB), tokenB.value.decimals)
  } else {
    const v = parsedB.value
    if (v === null) return
    const [rB, rA] = reservesFor(p, tokenB.value.address)
    amountA.value = v === 0n ? '' : plain(quote(v, rB, rA), tokenA.value.decimals)
  }
}

watch(amountA, () => driver.value === 'a' && mirror('a'))
watch(amountB, () => driver.value === 'b' && mirror('b'))
// Keyed on the addresses rather than the keys: ZNN and wrapped ZNN share one
// address, so switching between those two spellings is not a change of token
// and must not throw away an amount already typed.
watch([() => tokenA.value?.address, () => tokenB.value?.address], () => {
  amountA.value = ''
  amountB.value = ''
  steps.value = []
  error.value = ''
})

const share = computed(() => {
  const p = pool.value
  if (!p || isNew.value || !tokenA.value || parsedA.value === null || parsedA.value === 0n) return null
  const [rA] = reservesFor(p, tokenA.value.address)
  if (rA === 0n) return null
  const minted = (parsedA.value * p.totalSupply) / rA
  return Number(minted) / Number(p.totalSupply + minted)
})

const startPrice = computed(() => {
  if (!isNew.value || !parsedA.value || !parsedB.value || !tokenA.value || !tokenB.value) return null
  const a = Number(parsedA.value) / 10 ** tokenA.value.decimals
  const b = Number(parsedB.value) / 10 ** tokenB.value.decimals
  return a > 0 ? b / a : null
})

const insufficient = computed(() => {
  if (parsedA.value !== null && balanceA.value !== undefined && parsedA.value > balanceA.value) return tokenA.value?.symbol
  if (parsedB.value !== null && balanceB.value !== undefined && parsedB.value > balanceB.value) return tokenB.value?.symbol
  return null
})

const action = computed(() => {
  if (!wallet.address) return {label: 'Connect wallet', ok: false, connect: true}
  if (wrongChain.value) return {label: 'Switch your wallet to this chain', ok: false}
  if (!tokenA.value || !tokenB.value) return {label: 'Choose two tokens', ok: false}
  if (tokenKey(tokenA.value) === tokenKey(tokenB.value)) return {label: 'Choose two different tokens', ok: false}
  if (!parsedA.value || !parsedB.value) return {label: 'Enter both amounts', ok: false}
  if (insufficient.value) return {label: `Not enough ${insufficient.value}`, ok: false}
  if (busy.value) return {label: 'Working', ok: false}
  return {label: isNew.value ? 'Create this pool' : 'Add liquidity', ok: true}
})

function fillMax(side: 'a' | 'b') {
  const t = side === 'a' ? tokenA.value : tokenB.value
  const b = side === 'a' ? balanceA.value : balanceB.value
  if (!t || b === undefined) return
  const keep = t.native ? 10n ** 16n : 0n
  driver.value = side
  const v = plain(b > keep ? b - keep : 0n, t.decimals)
  if (side === 'a') amountA.value = v
  else amountB.value = v
}

function pick(key: string) {
  if (picking.value === 'a') {
    if (key === props.bKey) emit('update:bKey', props.aKey)
    emit('update:aKey', key)
  } else if (picking.value === 'b') {
    if (key === props.aKey) emit('update:aKey', props.bKey)
    emit('update:bKey', key)
  }
}

async function submit() {
  error.value = ''
  steps.value = []
  const owner = wallet.address
  const a = tokenA.value
  const b = tokenB.value
  if (!owner || !a || !b || !parsedA.value || !parsedB.value || !dex.router || endpoint.chainId === null) return
  busy.value = true
  try {
    const client = publicClient(endpoint.chainId)
    const calls: Call[] = []
    for (const [token, amount] of [
      [a, parsedA.value],
      [b, parsedB.value],
    ] as const) {
      if (token.native) continue
      const current = await allowance(client, token.address, owner, dex.router).catch(() => 0n)
      if (current < amount) calls.push(approveCall(token, dex.router, settings.exactApproval ? amount : MAX_UINT))
    }
    calls.push(
      addLiquidityCall(dex.router, a, b, parsedA.value, parsedB.value, owner, deadlineIn(settings.deadlineMin), {
        createsPair: !pool.value,
        setsPrice: isNew.value,
        slippageBps: settings.slippageBps,
      }),
    )
    await runCalls(calls, (s) => (steps.value = s))
    if (steps.value.every((s) => s.state === 'done')) {
      amountA.value = ''
      amountB.value = ''
    }
    await refreshPools()
  } catch (err: any) {
    error.value = err?.shortMessage ?? err?.message ?? String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="p-4 grid gap-2">
    <div class="field">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="ledger">{{ labelA }}</span>
        <span v-if="balanceA !== undefined && tokenA" class="flex items-center gap-1.5 text-[12px] text-dim">
          <span>Balance</span>
          <span class="mono">{{ units(balanceA, tokenA.decimals, 4) }}</span>
          <button class="btn btn-sm btn-quiet px-1.5 py-0" @click="fillMax('a')">Max</button>
        </span>
      </div>
      <div class="flex items-center gap-3">
        <input
          v-model="amountA"
          class="amount"
          inputmode="decimal"
          placeholder="0"
          aria-label="First amount"
          @focus="driver = 'a'"
        />
        <button class="pill" :disabled="locked" @click="picking = 'a'">
          <TokenLogo v-if="tokenA" :symbol="tokenA.symbol" :address="tokenA.address" :size="24" />
          <span>{{ tokenA?.symbol ?? 'Select' }}</span>
          <Icon v-if="!locked" name="down" :size="14" class="text-dim" />
        </button>
      </div>
    </div>

    <div class="flex justify-center -my-1 text-dim"><Icon name="plus" :size="16" /></div>

    <div class="field">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="ledger">{{ labelB }}</span>
        <span v-if="balanceB !== undefined && tokenB" class="flex items-center gap-1.5 text-[12px] text-dim">
          <span>Balance</span>
          <span class="mono">{{ units(balanceB, tokenB.decimals, 4) }}</span>
          <button class="btn btn-sm btn-quiet px-1.5 py-0" @click="fillMax('b')">Max</button>
        </span>
      </div>
      <div class="flex items-center gap-3">
        <input
          v-model="amountB"
          class="amount"
          inputmode="decimal"
          placeholder="0"
          aria-label="Second amount"
          @focus="driver = 'b'"
        />
        <button class="pill" :disabled="locked" @click="picking = 'b'">
          <TokenLogo v-if="tokenB" :symbol="tokenB.symbol" :address="tokenB.address" :size="24" />
          <span>{{ tokenB?.symbol ?? 'Select' }}</span>
          <Icon v-if="!locked" name="down" :size="14" class="text-dim" />
        </button>
      </div>
    </div>

    <p
      v-if="isNew && tokenA && tokenB"
      class="text-[12.5px] rounded p-2.5 mt-1"
      style="background: color-mix(in srgb, var(--warn) 10%, transparent); color: var(--warn)"
    >
      No pool holds {{ tokenA.symbol }} and {{ tokenB.symbol }} yet. The two amounts you put in set its opening
      price, and the first trade against a wrong price will take the difference.
    </p>

    <dl v-if="parsedA && parsedB" class="grid gap-1.5 text-[13px] rounded p-3 mt-1" style="background: var(--sunk)">
      <div v-if="startPrice !== null" class="flex justify-between gap-3">
        <dt class="text-dim">Opening price</dt>
        <dd class="mono">1 {{ tokenA?.symbol }} = {{ startPrice.toPrecision(6) }} {{ tokenB?.symbol }}</dd>
      </div>
      <div v-if="share !== null" class="flex justify-between gap-3">
        <dt class="text-dim">Your share of the pool</dt>
        <dd class="mono">{{ (share * 100).toFixed(share < 0.01 ? 4 : 2) }}%</dd>
      </div>
      <div class="flex justify-between gap-3">
        <dt class="text-dim">You earn</dt>
        <dd>0.3% of every trade, in proportion to your share</dd>
      </div>
    </dl>

    <label v-if="znnSide" class="flex items-center gap-2.5 text-[13px] cursor-pointer mt-1">
      <input v-model="depositNative" type="checkbox" class="accent-[var(--znn)]" />
      Deposit ZNN rather than wrapped ZNN
    </label>

    <button
      class="btn justify-center py-3 text-[15px] mt-1"
      :class="action.ok || action.connect ? 'btn-plasma' : ''"
      :disabled="!action.ok && !action.connect"
      @click="action.connect ? askToConnect() : submit()"
    >
      {{ action.label }}
    </button>

    <p v-if="error" class="text-[13px] break-words" style="color: var(--danger)">{{ error }}</p>
    <StepRail :steps="steps" />

    <TokenPicker
      :open="picking !== null"
      :exclude="picking === 'a' ? bKey : aKey"
      @close="picking = null"
      @pick="pick"
    />
  </div>
</template>
