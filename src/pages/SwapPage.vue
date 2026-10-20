<script setup lang="ts">
// The trading page: the pair on the left, the trade on the right.
//
// The pair panel follows whatever the swap card is set to, so the chart is
// always the pair you are about to trade. ZNN and QSR is what the page opens
// on, because it is the one pair this chain has by construction: ZNN is the
// coin that pays for gas and QSR is the predeploy that fuses plasma.
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {useRoute} from 'vue-router'
import {dex, officialPool, tokenByKey} from '../core/dex'
import {endpoint} from '../core/endpoint'
import {chain, onBlock} from '../core/chain'
import {WQSR} from '../core/chains'
import {loadPairHistory, spanOf, spotPrice, WINDOWS, type PairHistory} from '../core/history'
import {poolFor, tokenKey} from '../core/uniswap'
import {number} from '../core/format'
import SwapCard from '../components/SwapCard.vue'
import PairHeader from '../components/PairHeader.vue'
import PriceChart from '../components/PriceChart.vue'
import TradeList from '../components/TradeList.vue'
import Panel from '../components/Panel.vue'
import Icon from '../components/Icon.vue'

const route = useRoute()

const inKey = ref('znn')
const outKey = ref(WQSR.toLowerCase())

// A link can name the pair, which is how a pool page hands one over:
// /?in=znn&out=0x4200…0101
watch(
  () => route.query,
  (q) => {
    if (typeof q.in === 'string') inKey.value = q.in.toLowerCase()
    if (typeof q.out === 'string') outKey.value = q.out.toLowerCase()
  },
  {immediate: true},
)

const tokenIn = computed(() => tokenByKey(inKey.value))
const tokenOut = computed(() => tokenByKey(outKey.value))

const pool = computed(() => {
  if (!tokenIn.value || !tokenOut.value) return undefined
  return poolFor(dex.pools, tokenIn.value.address, tokenOut.value.address)
})

const isOfficial = computed(() => !!pool.value && !!officialPool.value && pool.value.pair === officialPool.value.pair)

const history = ref<PairHistory | null>(null)
const loading = ref(false)
/** The last read threw, as opposed to not having finished. */
const failed = ref(false)
const windowHours = ref(24)

// Once the tokens load, settle on a pair that exists rather than leaving the
// card on a pair this chain has never heard of.
watch(
  () => dex.status,
  (status) => {
    if (status !== 'ready') return
    if (!tokenByKey(outKey.value)) {
      const qsr = dex.tokens.find((t) => t.symbol === 'QSR')
      const first = dex.tokens.find((t) => !t.native && t.symbol !== 'WZNN')
      if (qsr ?? first) outKey.value = tokenKey((qsr ?? first)!)
    }
  },
  {immediate: true},
)

let loadToken = 0

async function load() {
  const p = pool.value
  const base = tokenIn.value
  const quote = tokenOut.value
  if (!p || !base || !quote || endpoint.chainId === null) {
    history.value = null
    return
  }
  const mine = ++loadToken
  loading.value = true
  try {
    const h = await loadPairHistory(endpoint.chainId, p, base, quote, {
      hours: windowHours.value,
      intervalSecs: chain.interval,
    })
    if (mine === loadToken) {
      history.value = h
      failed.value = false
    }
  } catch {
    if (mine === loadToken) {
      history.value = null
      failed.value = true
    }
  } finally {
    if (mine === loadToken) loading.value = false
  }
}

watch([() => pool.value?.pair, inKey, outKey, windowHours, () => endpoint.chainId], () => void load(), {immediate: true})

// A new block can carry a trade in this pair, so the chart follows the beat.
let off: (() => void) | undefined
onMounted(() => {
  off = onBlock(() => void load())
})
onUnmounted(() => off?.())

/**
 * The trades in the window, plus where the pool stands now.
 *
 * The pool's price holds between trades, so the current price at the head
 * block is as real a point as any trade, and appending it is what lets a pair
 * with a single trade still draw a line rather than a dot.
 */
const series = computed(() => {
  const h = history.value
  const p = pool.value
  if (!h || !p || !tokenIn.value || !tokenOut.value) return []
  if (!h.series.length) return []
  // Wall clock, not the head block's timestamp: right after your own trade the
  // head *is* the block that carried it, and a spot point stamped at the same
  // second as the trade would be dropped rather than drawn.
  const now = Math.floor(Date.now() / 1000)
  const spot = spotPrice(p, tokenIn.value, tokenOut.value)
  const last = h.series[h.series.length - 1]
  return now > last.time && spot > 0 ? [...h.series, {time: now, price: spot}] : h.series
})
/**
 * The window's move, measured over exactly the points the chart draws.
 *
 * Reading it off the trades alone while the chart also shows where the pool
 * stands now let the two disagree: the badge said down while the line went up.
 */
const change = computed(() => {
  const ps = series.value
  if (ps.length < 2 || ps[0].price <= 0) return null
  return ps[ps.length - 1].price / ps[0].price - 1
})


</script>

<template>
  <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] items-start">
    <!-- The pair. Second on a phone, because the trade is what you came for. -->
    <div class="grid gap-5 order-2 lg:order-1">
      <Panel>
        <div class="p-4">
          <PairHeader
            :pool="pool"
            :base="tokenIn"
            :quote="tokenOut"
            :change24h="change"
            :volume24h-base="history?.volume24hBase ?? 0n"
            :trades24h="history?.trades24h ?? 0"
            :span="spanOf(windowHours)"
            :loading="loading"
          >
            <template #badge>
              <!-- A mark, not a label. The heading beside it already names the
                   pair. The title and the hidden text carry the meaning a tick
                   on its own cannot. -->
              <span v-if="isOfficial" class="flex items-center" style="color: var(--znn-ink)" title="Verified">
                <Icon name="ok" :size="16" />
                <span class="sr-only">Verified</span>
              </span>
            </template>
            <template #actions>
              <div class="flex items-center gap-1.5">
                <button
                  v-for="w in WINDOWS"
                  :key="w.hours"
                  class="btn btn-sm"
                  :style="windowHours === w.hours ? 'background: var(--raised); border-color: var(--dim)' : ''"
                  @click="windowHours = w.hours"
                >
                  {{ w.label }}
                </button>
                <router-link v-if="pool" class="btn btn-sm btn-quiet" :to="`/pool/${pool.pair}`" title="This pool">
                  <Icon name="droplets" :size="14" />
                </router-link>
              </div>
            </template>
          </PairHeader>

          <p v-if="!pool" class="py-10 text-center text-[13.5px] text-dim">
            <template v-if="dex.status === 'ready' && tokenIn && tokenOut">
              No pool holds {{ tokenIn.symbol }} and {{ tokenOut.symbol }}.
              <router-link class="link" to="/pool/new">Create one</router-link> and you set its opening price.
            </template>
            <template v-else-if="dex.status === 'absent'">
              This node serves a chain with no exchange deployed on it. Point the app at another node, or set the
              router address yourself.
            </template>
            <template v-else>Reading the pools from {{ endpoint.rpc }}</template>
          </p>
        </div>

        <div v-if="pool && tokenIn && tokenOut" class="border-t border-line px-2 pb-2">
          <PriceChart
            :series="series"
            :base-symbol="tokenIn.symbol"
            :quote-symbol="tokenOut.symbol"
            :last-trade-at="history?.lastTradeAt ?? null"
            :never-traded="history?.neverTraded ?? false"
            :status="history ? 'ready' : failed ? 'failed' : 'loading'"
            :height="200"
          />
        </div>
      </Panel>

      <Panel v-if="pool && tokenIn && tokenOut" title="Recent trades">
        <template #actions>
          <span class="text-[12px] text-dim">
            <template v-if="history">blocks {{ number(history.fromBlock) }} to {{ number(history.toBlock) }}</template>
          </span>
        </template>
        <TradeList :trades="history?.trades ?? []" :base="tokenIn" :quote="tokenOut" :loading="loading" />
      </Panel>
    </div>

    <div class="order-1 lg:order-2 lg:sticky lg:top-[68px]">
      <SwapCard v-model:in-key="inKey" v-model:out-key="outKey" />
    </div>
  </div>
</template>
