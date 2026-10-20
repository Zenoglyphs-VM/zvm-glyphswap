<script setup lang="ts">
// The trade itself.
//
// Uniswap's shape, because it is the shape everyone already knows: two amount
// wells, a flip between them, one primary action. What is different is what the
// chain underneath demands. A quote is re-read on chain before the transaction
// is built, because reserves here move a whole momentum at a time; an approval
// and a swap are two momentums and are shown as two steps; and the fees the
// wallet would guess are filled in from this node, because the relayer has a
// tip floor that no wallet knows about.
//
// A submitted swap is handed to core/pending.ts and runs on its own, shown in
// the bubble in the corner, so the card is free for the next trade at once.
// What it has committed to spend is held back from the balance offered here
// until it settles, or a second swap would quote against money already spent.
import {computed, ref, watch} from 'vue'
import {formatUnits} from 'viem'
import {dex, hubs, refreshPools, tokenByAddress, tokenByKey} from '../core/dex'
import {endpoint} from '../core/endpoint'
import {publicClient} from '../core/evm'
import {askToConnect, wallet, wrongChain} from '../core/wallet'
import {settings, HIGH_IMPACT, WARN_IMPACT} from '../core/settings'
import {reserved, startSwap} from '../core/pending'
import {plain, price as fmtPrice, short, units} from '../core/format'
import {fmtUsd, tokenUsd} from '../core/prices'
import {
  allowance,
  approveCall,
  bestRoute,
  deadlineIn,
  MAX_UINT,
  parseAmount,
  quoteOnChain,
  slip,
  swapCall,
  tokenKey,
} from '../core/uniswap'
import Icon from './Icon.vue'
import Chip from '@zvm/web/components/Chip.vue'
import TokenLogo from './TokenLogo.vue'
import TokenPicker from './TokenPicker.vue'
import SwapSettings from './SwapSettings.vue'

const props = defineProps<{inKey: string; outKey: string}>()
const emit = defineEmits<{(e: 'update:inKey', v: string): void; (e: 'update:outKey', v: string): void}>()

const amountIn = ref('')
/** Only while the trade is re-quoted on chain, a moment, not the swap itself. */
const quoting = ref(false)
const error = ref('')
const picking = ref<'in' | 'out' | null>(null)
const flipping = ref(false)
const confirmImpact = ref(false)
const showDetails = ref(false)

const tokenIn = computed(() => tokenByKey(props.inKey))
const tokenOut = computed(() => tokenByKey(props.outKey))

const parsedIn = computed<bigint | null>(() => (tokenIn.value ? parseAmount(amountIn.value, tokenIn.value.decimals) : null))

const balanceIn = computed(() => (tokenIn.value ? dex.balances[tokenKey(tokenIn.value)] : undefined))
/** The balance less what swaps still in flight are about to spend. */
const reservedIn = computed(() => (tokenIn.value ? reserved(tokenKey(tokenIn.value), endpoint.chainId) : 0n))
const availableIn = computed(() => {
  const b = balanceIn.value
  if (b === undefined) return undefined
  return b > reservedIn.value ? b - reservedIn.value : 0n
})
const balanceOut = computed(() => (tokenOut.value ? dex.balances[tokenKey(tokenOut.value)] : undefined))

// What the two sides are worth, when this endpoint has a node that knows. A
// token with no priced pool has none, and the line is left out rather than
// shown as $0.00 — a swap is priced by reserves, and the dollars are context.
const usdIn = computed(() => tokenUsd(tokenIn.value, parsedIn.value))
const usdOut = computed(() => tokenUsd(tokenOut.value, route.value?.amountOut ?? null))

const route = computed(() => {
  if (!tokenIn.value || !tokenOut.value || !parsedIn.value) return null
  return bestRoute(dex.pools, hubs.value, tokenIn.value, tokenOut.value, parsedIn.value)
})

const outText = computed(() => {
  if (!route.value || !tokenOut.value) return ''
  return units(route.value.amountOut, tokenOut.value.decimals, 6)
})

// --- approval ---------------------------------------------------------------

const allowanceIn = ref<bigint | null>(null)

async function loadAllowance() {
  allowanceIn.value = null
  const t = tokenIn.value
  if (!t || t.native || !wallet.address || !dex.router || endpoint.chainId === null) return
  allowanceIn.value = await allowance(publicClient(endpoint.chainId), t.address, wallet.address, dex.router).catch(() => null)
}

watch([() => props.inKey, () => wallet.address, () => dex.router, () => dex.balances], loadAllowance, {immediate: true})

const needsApproval = computed(
  () => !!tokenIn.value && !tokenIn.value.native && route.value?.kind === 'swap' && (allowanceIn.value ?? 0n) < (parsedIn.value ?? 0n),
)

// --- what the trade costs ---------------------------------------------------

const insufficient = computed(
  () => availableIn.value !== undefined && parsedIn.value !== null && parsedIn.value > availableIn.value,
)

const rate = computed(() => {
  const r = route.value
  const a = parsedIn.value
  if (!r || !a || !tokenIn.value || !tokenOut.value) return ''
  const x = Number(formatUnits(r.amountOut, tokenOut.value.decimals)) / Number(formatUnits(a, tokenIn.value.decimals))
  return `1 ${tokenIn.value.symbol} = ${fmtPrice(x)} ${tokenOut.value.symbol}`
})

const routeLabel = computed(() => {
  const r = route.value
  if (!r || r.kind !== 'swap') return ''
  return r.path
    .map((a, i) =>
      i === 0 ? tokenIn.value!.symbol : i === r.path.length - 1 ? tokenOut.value!.symbol : (tokenByAddress(a)?.symbol ?? short(a)),
    )
    .join(' to ')
})

// A taxed token's cut, already taken out of the quote above.
const taxLabel = computed(() => {
  const r = route.value
  if (!r || r.kind !== 'swap' || !r.tax) return ''
  const parts: string[] = []
  if (r.tax.inBps) parts.push(`${r.tax.inBps / 100}% of the ${tokenIn.value?.symbol} you pay`)
  if (r.tax.outBps) parts.push(`${r.tax.outBps / 100}% of the ${tokenOut.value?.symbol} you receive`)
  return parts.join(', ')
})

const impact = computed(() => route.value?.impact ?? 0)
const impactTone = computed(() => (impact.value < WARN_IMPACT ? 'plain' : impact.value < HIGH_IMPACT ? 'warn' : 'bad'))
const impactBlocked = computed(() => route.value?.kind === 'swap' && impact.value >= HIGH_IMPACT && !settings.allowHighImpact)

const minReceived = computed(() => {
  const r = route.value
  if (!r || !tokenOut.value) return ''
  const v = r.kind === 'swap' ? slip(r.amountOut, settings.slippageBps) : r.amountOut
  return `${units(v, tokenOut.value.decimals, 6)} ${tokenOut.value.symbol}`
})

const feePaid = computed(() => {
  const r = route.value
  const a = parsedIn.value
  if (!r || r.kind !== 'swap' || !a || !tokenIn.value) return ''
  const hops = BigInt(r.path.length - 1)
  return `${units((a * 3n * hops) / 1000n, tokenIn.value.decimals, 6)} ${tokenIn.value.symbol}`
})

// --- controls ---------------------------------------------------------------

function flip() {
  const a = props.inKey
  emit('update:inKey', props.outKey)
  emit('update:outKey', a)
  flipping.value = true
  setTimeout(() => (flipping.value = false), 260)
}

function setPicked(key: string) {
  if (picking.value === 'in') {
    if (key === props.outKey) emit('update:outKey', props.inKey)
    emit('update:inKey', key)
  } else if (picking.value === 'out') {
    if (key === props.inKey) emit('update:inKey', props.outKey)
    emit('update:outKey', key)
  }
}

/** A relayed transaction pays its gas in ZNN, so a native max leaves some behind. */
const GAS_RESERVE = 10n ** 16n

function fill(share: 1 | 2) {
  const t = tokenIn.value
  const b = availableIn.value
  if (!t || b === undefined) return
  const spendable = t.native ? (b > GAS_RESERVE ? b - GAS_RESERVE : 0n) : b
  amountIn.value = plain(spendable / BigInt(share), t.decimals)
}

const action = computed(() => {
  if (endpoint.health !== 'ok') return {label: 'Choose a node first', ok: false}
  if (dex.status === 'loading') return {label: 'Reading the pools', ok: false}
  if (dex.status === 'absent') return {label: 'No exchange on this chain', ok: false}
  if (dex.status === 'error') return {label: 'Could not read the pools', ok: false}
  if (!wallet.address) return {label: 'Connect wallet', ok: false, connect: true}
  if (wrongChain.value) return {label: 'Switch your wallet to this chain', ok: false}
  if (!tokenIn.value || !tokenOut.value) return {label: 'Choose two tokens', ok: false}
  if (!amountIn.value.trim()) return {label: 'Enter an amount', ok: false}
  if (parsedIn.value === null || parsedIn.value === 0n) return {label: 'Enter an amount', ok: false}
  if (!route.value) return {label: `No pool for ${tokenIn.value.symbol} and ${tokenOut.value.symbol}`, ok: false}
  if (insufficient.value) return {label: `Not enough ${tokenIn.value.symbol}`, ok: false}
  if (quoting.value) return {label: 'Checking the price', ok: false}
  if (impactBlocked.value) return {label: 'Price impact too high', ok: false, impact: true}
  const verb = route.value.kind === 'wrap' ? 'Wrap' : route.value.kind === 'unwrap' ? 'Unwrap' : 'Swap'
  if (needsApproval.value) return {label: `Approve ${tokenIn.value.symbol}, then ${verb.toLowerCase()}`, ok: true}
  return {label: verb, ok: true}
})

async function submit() {
  error.value = ''
  confirmImpact.value = false
  const owner = wallet.address
  const r = route.value
  const a = parsedIn.value
  const tIn = tokenIn.value
  const tOut = tokenOut.value
  const chainId = endpoint.chainId
  if (!owner || !r || !a || !tIn || !tOut || !dex.router || chainId === null) return
  quoting.value = true
  try {
    // Re-quote against the reserves as they are now: a local quote can be a
    // whole momentum out of date, which on this chain is fifteen seconds of
    // other people's trades.
    const fresh = r.kind === 'swap' ? await quoteOnChain(publicClient(chainId), dex.router, a, r.path, tIn, tOut) : r.amountOut
    const minOut = r.kind === 'swap' ? slip(fresh, settings.slippageBps) : fresh
    const call = swapCall(dex.router, tIn, tOut, r, a, minOut, owner, deadlineIn(settings.deadlineMin))
    // An approval another swap still in flight is sending is not visible in
    // the allowance yet, so this may approve twice. That costs a little gas;
    // leaving it out would make this swap's estimate revert until the other
    // one lands.
    const calls = needsApproval.value ? [approveCall(tIn, dex.router, settings.exactApproval ? a : MAX_UINT), call] : [call]
    startSwap({
      summary: `${units(a, tIn.decimals, 6)} ${tIn.symbol} for ${units(fresh, tOut.decimals, 6)} ${tOut.symbol}`,
      chainId,
      tokenInKey: tokenKey(tIn),
      amountIn: a,
      calls,
      settled: () => Promise.all([refreshPools(), loadAllowance()]),
    })
    amountIn.value = ''
  } catch (err: any) {
    error.value = err?.shortMessage ?? err?.message ?? String(err)
  } finally {
    quoting.value = false
  }
}

function onAction() {
  if (action.value.connect) return askToConnect()
  if (action.value.impact) {
    confirmImpact.value = true
    return
  }
  if (action.value.ok) void submit()
}
</script>

<template>
  <section class="panel relative overflow-visible">
    <header class="flex items-center justify-between gap-3 px-4 py-3">
      <h1 class="text-[15px] font-semibold tracking-[-0.01em]">Swap</h1>
      <SwapSettings />
    </header>

    <div class="px-4 pb-4 grid gap-2">
      <!-- You pay -->
      <div class="field">
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="ledger">You pay</span>
          <span v-if="balanceIn !== undefined && tokenIn" class="flex items-center gap-1.5 text-[12px] text-dim">
            <span>Balance</span>
            <span class="mono">{{ units(balanceIn, tokenIn.decimals, 4) }}</span>
            <span v-if="reservedIn > 0n" class="mono" title="Being spent by a swap that has not executed yet">
              ({{ units(reservedIn, tokenIn.decimals, 4) }} in flight)
            </span>
            <button class="btn btn-sm btn-quiet px-1.5 py-0" @click="fill(2)">Half</button>
            <button class="btn btn-sm btn-quiet px-1.5 py-0" @click="fill(1)">Max</button>
          </span>
        </div>
        <div class="flex items-center gap-3">
          <input
            v-model="amountIn"
            class="amount"
            inputmode="decimal"
            placeholder="0"
            aria-label="Amount to pay"
            spellcheck="false"
          />
          <button class="pill" @click="picking = 'in'">
            <TokenLogo v-if="tokenIn" :symbol="tokenIn.symbol" :address="tokenIn.address" :size="24" />
            <span>{{ tokenIn?.symbol ?? 'Select' }}</span>
            <Icon name="down" :size="14" class="text-dim" />
          </button>
        </div>
        <div v-if="usdIn !== null" class="mt-1 text-[12px] text-dim mono">{{ fmtUsd(usdIn) }}</div>
      </div>

      <!-- The flip. It sits between the wells and overlaps both, so the two
           rows read as one control rather than two forms. -->
      <div class="relative h-0">
        <button
          class="flip"
          :class="flipping ? 'flip-turn' : ''"
          title="Trade the other way"
          aria-label="Trade the other way"
          @click="flip"
        >
          <Icon name="swap" :size="15" />
        </button>
      </div>

      <!-- You receive -->
      <div class="field">
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="ledger">You receive</span>
          <span v-if="balanceOut !== undefined && tokenOut" class="text-[12px] text-dim">
            Balance <span class="mono">{{ units(balanceOut, tokenOut.decimals, 4) }}</span>
          </span>
        </div>
        <div class="flex items-center gap-3">
          <output
            :key="outText"
            class="amount truncate"
            :class="[outText ? 'quote-in' : '', route ? '' : 'text-dim']"
            style="display: block"
            >{{ outText || '0' }}</output
          >
          <button class="pill" @click="picking = 'out'">
            <TokenLogo v-if="tokenOut" :symbol="tokenOut.symbol" :address="tokenOut.address" :size="24" />
            <span>{{ tokenOut?.symbol ?? 'Select' }}</span>
            <Icon name="down" :size="14" class="text-dim" />
          </button>
        </div>
        <div v-if="usdOut !== null" class="mt-1 text-[12px] text-dim mono">{{ fmtUsd(usdOut) }}</div>
      </div>

      <!-- Trade details. One line always, the rest on request: the rate is what
           a person checks every time, the others are what they check once. -->
      <div v-if="route" class="grid gap-2 pt-1">
        <button class="flex items-center justify-between gap-3 text-[13px] w-full" @click="showDetails = !showDetails">
          <span class="mono text-left">{{ rate }}</span>
          <span class="flex items-center gap-2 text-dim">
            <Chip v-if="route.kind === 'swap' && impact >= WARN_IMPACT" :tone="impactTone" dot>
              {{ (impact * 100).toFixed(2) }}% impact
            </Chip>
            <Icon name="down" :size="14" :style="showDetails ? 'transform: rotate(180deg)' : ''" />
          </span>
        </button>

        <dl v-if="showDetails" class="grid gap-1.5 text-[13px] rounded p-3" style="background: var(--sunk)">
          <div v-if="route.kind === 'swap'" class="flex justify-between gap-3">
            <dt class="text-dim">Minimum received</dt>
            <dd class="mono">{{ minReceived }}</dd>
          </div>
          <div v-if="route.kind === 'swap'" class="flex justify-between gap-3">
            <dt class="text-dim">Price impact</dt>
            <dd><Chip :tone="impactTone">{{ (impact * 100).toFixed(2) }}%</Chip></dd>
          </div>
          <div v-if="route.kind === 'swap'" class="flex justify-between gap-3">
            <dt class="text-dim">Liquidity provider fee</dt>
            <dd class="mono">{{ feePaid }}</dd>
          </div>
          <div v-if="route.kind === 'swap' && route.tax" class="flex justify-between gap-3">
            <dt class="text-dim">Token's own tax</dt>
            <dd class="mono">{{ taxLabel }}</dd>
          </div>
          <div v-if="route.kind === 'swap'" class="flex justify-between gap-3">
            <dt class="text-dim">Route</dt>
            <dd class="mono">{{ routeLabel }}</dd>
          </div>
          <div v-else class="flex justify-between gap-3">
            <dt class="text-dim">What this does</dt>
            <dd>{{ route.kind === 'wrap' ? 'Deposits ZNN into WZNN, one for one' : 'Returns WZNN as ZNN, one for one' }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Slippage allowed</dt>
            <dd class="mono">{{ (settings.slippageBps / 100).toFixed(2) }}%</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Gas paid in</dt>
            <dd>ZNN, by your wallet</dd>
          </div>
        </dl>
      </div>

      <button
        class="btn justify-center py-3 text-[15px] mt-1"
        :class="action.ok || action.impact || action.connect ? 'btn-plasma' : ''"
        :disabled="!action.ok && !action.impact && !action.connect"
        @click="onAction"
      >
        {{ action.label }}
      </button>

      <!-- The refusal, and the way past it, in the same place. -->
      <div
        v-if="confirmImpact"
        class="rounded p-3 grid gap-2 text-[13px]"
        style="background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent)"
      >
        <p>
          This trade moves the pool {{ (impact * 100).toFixed(2) }}%, so you would receive
          {{ (impact * 100).toFixed(2) }}% less than the pool's current price. That is usually a sign the pool is
          too small for the size you are trading.
        </p>
        <div class="flex gap-2">
          <button class="btn btn-sm" @click="submit">Trade anyway</button>
          <button class="btn btn-sm btn-quiet" @click="confirmImpact = false">Cancel</button>
        </div>
      </div>

      <p v-if="error" class="text-[13px] break-words" style="color: var(--danger)">{{ error }}</p>
      <p v-else-if="dex.status === 'absent' && dex.error" class="text-[13px] text-dim">{{ dex.error }}</p>

    </div>

    <TokenPicker
      :open="picking !== null"
      :exclude="picking === 'in' ? outKey : inKey"
      @close="picking = null"
      @pick="setPicked"
    />
  </section>
</template>

<style scoped>
.flip {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius);
  border: 3px solid var(--surface);
  background: var(--raised);
  color: var(--fg);
  cursor: pointer;
  transition: background 150ms var(--ease), color 150ms var(--ease);
}

.flip:hover {
  background: var(--sunk);
  color: var(--znn-ink);
}

/* The one motion the flip earns: the arrows turn through half a circle, which
   is what the button just did to the trade. */
.flip-turn {
  animation: flip-turn 260ms var(--ease);
}

@keyframes flip-turn {
  from {
    transform: translate(-50%, -50%) rotate(0deg);
  }
  to {
    transform: translate(-50%, -50%) rotate(180deg);
  }
}
</style>
