<script setup lang="ts">
// One pool: what it holds, what it has been trading at, and your side of it.
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import {useRoute} from 'vue-router'
import {dex, poolByAddress, sideSymbol, tokenByAddress} from '../core/dex'
import {endpoint} from '../core/endpoint'
import {chain, onBlock} from '../core/chain'
import {wallet} from '../core/wallet'
import {loadPairHistory, spanOf, spotPrice, WINDOWS, type PairHistory} from '../core/history'
import {burnAmounts, same, tokenKey, type Token} from '../core/uniswap'
import {number, short, units} from '../core/format'
import Panel from '../components/Panel.vue'
import PairHeader from '../components/PairHeader.vue'
import PriceChart from '../components/PriceChart.vue'
import TradeList from '../components/TradeList.vue'
import LiquidityForm from '../components/LiquidityForm.vue'
import RemoveLiquidity from '../components/RemoveLiquidity.vue'
import Icon from '../components/Icon.vue'

const route = useRoute()
const pairAddress = computed(() => String(route.params.pair ?? ''))

const pool = computed(() => poolByAddress(pairAddress.value))
const index = computed(() => dex.pools.findIndex((p) => p.pair === pool.value?.pair))
const balance = computed(() => (index.value >= 0 ? (dex.lp[index.value] ?? 0n) : 0n))

const base = computed(() => (pool.value ? tokenByAddress(pool.value.token0) : undefined))
const quote = computed(() => (pool.value ? tokenByAddress(pool.value.token1) : undefined))

// A pool holds wrapped ZNN; the pair is still called ZNN.
const baseName = computed(() => (pool.value ? sideSymbol(pool.value.token0) : ''))
const quoteName = computed(() => (pool.value ? sideSymbol(pool.value.token1) : ''))

const mine = computed(() => {
  const p = pool.value
  if (!p || balance.value === 0n) return null
  const [out0, out1] = burnAmounts(p, balance.value)
  return {out0, out1, share: p.totalSupply > 0n ? Number(balance.value) / Number(p.totalSupply) : 0}
})

const tab = ref<'add' | 'remove'>('add')
watch(balance, (b) => {
  if (b === 0n) tab.value = 'add'
})

/**
 * A pool holds wrapped ZNN, but the balance anyone actually has is ZNN, and the
 * router takes it directly. So the deposit form is handed the native spelling
 * of that side by default; the form offers the wrapped one to whoever wants it.
 */
const nativeSpelling = ref(true)

const keyFor = (t: Token | undefined) => {
  if (!t) return ''
  return nativeSpelling.value && dex.weth && same(t.address, dex.weth) ? 'znn' : tokenKey(t)
}

/** The pair is fixed here. The one change accepted is ZNN for wrapped ZNN. */
function acceptSpelling(v: string, t: Token | undefined) {
  if (!t || !dex.weth || !same(t.address, dex.weth)) return
  nativeSpelling.value = v === 'znn'
}

const aKey = computed({
  get: () => keyFor(base.value),
  set: (v) => acceptSpelling(v, base.value),
})
const bKey = computed({
  get: () => keyFor(quote.value),
  set: (v) => acceptSpelling(v, quote.value),
})

const history = ref<PairHistory | null>(null)
const loading = ref(false)
/** The last read threw, as opposed to not having finished. */
const failed = ref(false)
const windowHours = ref(24)
let loadToken = 0

/** The window's trades plus the pool's price now, as on the swap page. */
const series = computed(() => {
  const h = history.value
  const p = pool.value
  if (!h || !p || !base.value || !quote.value || !h.series.length) return []
  const now = Math.floor(Date.now() / 1000)
  const spot = spotPrice(p, base.value, quote.value)
  const last = h.series[h.series.length - 1]
  return now > last.time && spot > 0 ? [...h.series, {time: now, price: spot}] : h.series
})

async function load() {
  const p = pool.value
  if (!p || !base.value || !quote.value || endpoint.chainId === null) {
    history.value = null
    return
  }
  const token = ++loadToken
  loading.value = true
  try {
    const h = await loadPairHistory(endpoint.chainId, p, base.value, quote.value, {
      hours: windowHours.value,
      intervalSecs: chain.interval,
    })
    if (token === loadToken) {
      history.value = h
      failed.value = false
    }
  } catch {
    if (token === loadToken) {
      history.value = null
      failed.value = true
    }
  } finally {
    if (token === loadToken) loading.value = false
  }
}

watch([() => pool.value?.pair, () => endpoint.chainId, windowHours], () => void load(), {immediate: true})

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

let off: (() => void) | undefined
onMounted(() => {
  off = onBlock(() => void load())
})
onUnmounted(() => off?.())
</script>

<template>
  <div class="grid gap-5">
    <div class="flex items-center gap-2">
      <router-link class="btn btn-sm btn-quiet px-2" to="/explore" title="Back to the pools">
        <Icon name="left" :size="15" />
      </router-link>
      <span class="mono text-[12.5px] text-dim">{{ short(pairAddress, 12, 8) }}</span>
      <a
        v-if="endpoint.apiBase"
        class="link text-[12.5px]"
        :href="`${endpoint.apiBase}/address/${pairAddress}`"
        target="_blank"
        rel="noreferrer noopener"
        >View the contract <Icon name="external" :size="12" class="inline align-[-1px]"
      /></a>
    </div>

    <div v-if="!pool" class="panel px-4 py-12 text-center">
      <p class="text-[14px]">
        <template v-if="dex.status === 'ready'">No pool at that address on this chain.</template>
        <template v-else>Reading the pools</template>
      </p>
      <router-link v-if="dex.status === 'ready'" class="link text-[13px]" to="/explore">See the pools that exist</router-link>
    </div>

    <template v-else>
      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] items-start">
        <div class="grid gap-5 order-2 lg:order-1">
          <Panel>
            <div class="p-4">
              <PairHeader
                :pool="pool"
                :base="base"
                :quote="quote"
                :change24h="change"
                :volume24h-base="history?.volume24hBase ?? 0n"
                :trades24h="history?.trades24h ?? 0"
                :span="spanOf(windowHours)"
                :loading="loading"
              >
                <template #actions>
                  <div class="flex flex-wrap items-center gap-1.5">
                    <button
                      v-for="w in WINDOWS"
                      :key="w.hours"
                      class="btn btn-sm"
                      :style="windowHours === w.hours ? 'background: var(--raised); border-color: var(--dim)' : ''"
                      @click="windowHours = w.hours"
                    >
                      {{ w.label }}
                    </button>
                    <router-link v-if="base && quote" class="btn btn-sm" :to="`/?in=${aKey}&out=${bKey}`">
                      Trade this pair
                    </router-link>
                  </div>
                </template>
              </PairHeader>
            </div>
            <div class="border-t border-line px-2 pb-2">
              <PriceChart
                v-if="base && quote"
                :series="series"
                :base-symbol="base.symbol"
                :quote-symbol="quote.symbol"
                :last-trade-at="history?.lastTradeAt ?? null"
                :never-traded="history?.neverTraded ?? false"
                :status="history ? 'ready' : failed ? 'failed' : 'loading'"
                :height="200"
              />
            </div>
          </Panel>

          <Panel title="Recent trades">
            <template #actions>
              <span v-if="history" class="text-[12px] text-dim">
                blocks {{ number(history.fromBlock) }} to {{ number(history.toBlock) }}
              </span>
            </template>
            <TradeList v-if="base && quote" :trades="history?.trades ?? []" :base="base" :quote="quote" :loading="loading" />
          </Panel>
        </div>

        <div class="order-1 lg:order-2 grid gap-5">
          <Panel v-if="mine && base && quote" title="Your position">
            <dl class="p-4 grid gap-2 text-[13.5px]">
              <div class="flex justify-between gap-3">
                <dt class="text-dim">Share of the pool</dt>
                <dd class="mono" style="color: var(--znn-ink)">
                  {{ (mine.share * 100).toFixed(mine.share < 0.0001 ? 4 : 2) }}%
                </dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-dim">{{ baseName }}</dt>
                <dd class="mono">{{ units(mine.out0, base.decimals, 6) }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-dim">{{ quoteName }}</dt>
                <dd class="mono">{{ units(mine.out1, quote.decimals, 6) }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-dim">Pool tokens</dt>
                <dd class="mono">{{ units(balance, 18, 6) }}</dd>
              </div>
            </dl>
          </Panel>

          <section class="panel overflow-hidden">
            <header class="flex items-center gap-1 px-3 py-2.5 border-b border-line">
              <button class="tab" :class="tab === 'add' ? 'tab-on' : ''" @click="tab = 'add'">Add liquidity</button>
              <button
                class="tab"
                :class="tab === 'remove' ? 'tab-on' : ''"
                :disabled="balance === 0n"
                :style="balance === 0n ? 'opacity:.45;cursor:not-allowed' : ''"
                @click="balance > 0n && (tab = 'remove')"
              >
                Withdraw
              </button>
            </header>
            <LiquidityForm v-if="tab === 'add'" v-model:a-key="aKey" v-model:b-key="bKey" locked />
            <RemoveLiquidity v-else :pool="pool" :balance="balance" />
          </section>

          <p v-if="!wallet.address" class="text-[13px] text-dim px-1">
            Connect a wallet to deposit into this pool or withdraw from it.
          </p>
        </div>
      </div>
    </template>
  </div>
</template>
