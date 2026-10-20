<script setup lang="ts">
// Opening a position, with the pair still to be chosen.
import {computed, ref, watch} from 'vue'
import {useRoute} from 'vue-router'
import {dex, sideSymbol, tokenByAddress, tokenByKey} from '../core/dex'
import {WQSR} from '../core/chains'
import {poolFor, tokenKey} from '../core/uniswap'
import {price as fmtPrice, units} from '../core/format'
import Panel from '../components/Panel.vue'
import LiquidityForm from '../components/LiquidityForm.vue'
import Icon from '../components/Icon.vue'

const route = useRoute()

const aKey = ref('znn')
const bKey = ref(WQSR.toLowerCase())

// A link can name the pair: /pool/new?a=znn&b=0x…
watch(
  () => route.query,
  (q) => {
    if (typeof q.a === 'string') aKey.value = q.a.toLowerCase()
    if (typeof q.b === 'string') bKey.value = q.b.toLowerCase()
  },
  {immediate: true},
)

watch(
  () => dex.status,
  (s) => {
    if (s !== 'ready') return
    if (!tokenByKey(bKey.value)) {
      const first = dex.tokens.find((t) => !t.native && t.symbol !== 'WZNN')
      if (first) bKey.value = tokenKey(first)
    }
  },
  {immediate: true},
)

const tokenA = computed(() => tokenByKey(aKey.value))
const tokenB = computed(() => tokenByKey(bKey.value))

const pool = computed(() => (tokenA.value && tokenB.value ? poolFor(dex.pools, tokenA.value.address, tokenB.value.address) : undefined))

const rate = computed(() => {
  const p = pool.value
  if (!p) return null
  const t0 = tokenByAddress(p.token0)
  const t1 = tokenByAddress(p.token1)
  if (!t0 || !t1 || p.reserve0 === 0n) return null
  return {
    t0,
    t1,
    name0: sideSymbol(p.token0) || t0.symbol,
    name1: sideSymbol(p.token1) || t1.symbol,
    price: Number(p.reserve1) / 10 ** t1.decimals / (Number(p.reserve0) / 10 ** t0.decimals),
  }
})
</script>

<template>
  <div class="mx-auto w-full max-w-[520px] grid gap-4">
    <div class="flex items-center gap-2">
      <router-link class="btn btn-sm btn-quiet px-2" to="/pool" title="Back to your positions">
        <Icon name="left" :size="15" />
      </router-link>
      <h1 class="text-[18px] font-semibold tracking-[-0.02em]">New position</h1>
    </div>

    <Panel :title="pool ? 'Add to an existing pool' : 'Create a pool'">
      <LiquidityForm v-model:a-key="aKey" v-model:b-key="bKey" />
    </Panel>

    <div v-if="pool && rate" class="panel p-4 grid gap-2 text-[13px]">
      <div class="flex justify-between gap-3">
        <span class="text-dim">Pool price</span>
        <span class="mono">1 {{ rate.name0 }} = {{ fmtPrice(rate.price) }} {{ rate.name1 }}</span>
      </div>
      <div class="flex justify-between gap-3">
        <span class="text-dim">Pool holds</span>
        <span class="mono">
          {{ units(pool.reserve0, rate.t0.decimals, 2) }} {{ rate.name0 }} and
          {{ units(pool.reserve1, rate.t1.decimals, 2) }} {{ rate.name1 }}
        </span>
      </div>
      <router-link class="link justify-self-start" :to="`/pool/${pool.pair}`">Open this pool</router-link>
    </div>
  </div>
</template>
