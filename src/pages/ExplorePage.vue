<script setup lang="ts">
// Every pool the factory has made, and every token they hold.
//
// There is no price feed behind this page, so nothing here is quoted in
// dollars. Pools are ranked in ZNN instead, which this chain can work out on
// its own: a pool holding wrapped ZNN is worth twice its ZNN side, and any
// other token is worth what its own ZNN pool says it is.
import {computed, ref} from 'vue'
import {dex, liquidityInZnn, sideSymbol, tokenByAddress} from '../core/dex'
import {wallet} from '../core/wallet'
import {reservesFor, tokenKey, type Pool} from '../core/uniswap'
import {fmtUsd, znnUsd} from '../core/prices'
import {amount as fmtAmount, price as fmtPrice, short, units} from '../core/format'
import Panel from '../components/Panel.vue'
import TokenLogo from '../components/TokenLogo.vue'
import Icon from '../components/Icon.vue'

type Tab = 'pools' | 'tokens'

const tab = ref<Tab>('pools')
const query = ref('')

interface Row {
  pool: Pool
  symbol0: string
  symbol1: string
  price: number
  znn: number | null
  /** The ZNN size in dollars, or null when this node prices nothing. */
  usd: number | null
  mine: bigint
}

const rows = computed<Row[]>(() => {
  const q = query.value.trim().toLowerCase()
  return dex.pools
    .map((pool, i) => {
      const t0 = tokenByAddress(pool.token0)
      const t1 = tokenByAddress(pool.token1)
      const [r0, r1] = [pool.reserve0, pool.reserve1]
      const price =
        t0 && t1 && r0 > 0n ? (Number(r1) / 10 ** t1.decimals) / (Number(r0) / 10 ** t0.decimals) : 0
      const znn = liquidityInZnn(pool)
      const perZnn = znnUsd()
      return {
        pool,
        symbol0: sideSymbol(pool.token0) || short(pool.token0),
        symbol1: sideSymbol(pool.token1) || short(pool.token1),
        price,
        znn,
        // A pool with no ZNN route has no size in ZNN, so it has none in
        // dollars either. Both are left blank rather than counted as zero:
        // the pool is not empty, it is unpriced.
        usd: znn !== null && perZnn !== null ? znn * perZnn : null,
        mine: dex.lp[i] ?? 0n,
      }
    })
    .filter(
      (r) =>
        !q ||
        r.symbol0.toLowerCase().includes(q) ||
        r.symbol1.toLowerCase().includes(q) ||
        r.pool.pair.toLowerCase().includes(q),
    )
    .sort((a, b) => (b.znn ?? -1) - (a.znn ?? -1))
})

const tokenRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  return dex.tokens
    .filter((t) => !t.native)
    .map((t) => {
      const pools = dex.pools.filter(
        (p) => p.token0.toLowerCase() === t.address.toLowerCase() || p.token1.toLowerCase() === t.address.toLowerCase(),
      )
      const held = pools.reduce((sum, p) => sum + reservesFor(p, t.address)[0], 0n)
      return {token: t, pools: pools.length, held, balance: dex.balances[tokenKey(t)] ?? 0n}
    })
    .filter((r) => !q || r.token.symbol.toLowerCase().includes(q) || r.token.address.toLowerCase().includes(q))
    .sort((a, b) => b.pools - a.pools || a.token.symbol.localeCompare(b.token.symbol))
})
</script>

<template>
  <div class="grid gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-1">
        <button class="tab" :class="tab === 'pools' ? 'tab-on' : ''" @click="tab = 'pools'">Pools</button>
        <button class="tab" :class="tab === 'tokens' ? 'tab-on' : ''" @click="tab = 'tokens'">Tokens</button>
      </div>
      <span class="grow" />
      <input
        v-model="query"
        class="input w-[240px]"
        spellcheck="false"
        placeholder="Filter by symbol or address"
        aria-label="Filter"
      />
      <router-link class="btn btn-sm btn-plasma" to="/pool/new"><Icon name="plus" :size="14" /> New position</router-link>
    </div>

    <Panel v-if="tab === 'pools'" title="Pools" :subtitle="`${rows.length} on this chain, deepest first`">
      <div class="overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th class="th">Pair</th>
              <th class="th">Price</th>
              <th class="th">Holds</th>
              <th class="th">Size in ZNN</th>
              <th class="th">Your position</th>
              <th class="th"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.pool.pair">
              <td class="td">
                <router-link class="flex items-center gap-2.5" :to="`/pool/${r.pool.pair}`">
                  <span class="flex -space-x-2">
                    <TokenLogo :symbol="r.symbol0" :address="r.pool.token0" :size="22" />
                    <TokenLogo :symbol="r.symbol1" :address="r.pool.token1" :size="22" />
                  </span>
                  <span class="text-[13.5px]">{{ r.symbol0 }} and {{ r.symbol1 }}</span>
                </router-link>
              </td>
              <td class="td mono text-[13px]">
                {{ fmtPrice(r.price) }}
                <span class="text-dim text-[11.5px]">{{ r.symbol1 }}</span>
              </td>
              <td class="td mono text-[13px] whitespace-nowrap">
                {{ units(r.pool.reserve0, tokenByAddress(r.pool.token0)?.decimals ?? 18, 2) }}
                <span class="text-dim text-[11.5px]">{{ r.symbol0 }}</span>
                <span class="text-dim"> and </span>
                {{ units(r.pool.reserve1, tokenByAddress(r.pool.token1)?.decimals ?? 18, 2) }}
                <span class="text-dim text-[11.5px]">{{ r.symbol1 }}</span>
              </td>
              <td class="td mono text-[13px]">
                <template v-if="r.znn !== null">{{ fmtAmount(r.znn) }}</template>
                <span v-else class="text-dim">no ZNN route</span>
                <div v-if="r.usd !== null" class="text-dim text-[11.5px]">{{ fmtUsd(r.usd, {compact: true}) }}</div>
              </td>
              <td class="td mono text-[13px]">
                <span v-if="!wallet.address" class="text-dim">connect</span>
                <span v-else-if="r.mine === 0n" class="text-dim">none</span>
                <span v-else :style="{color: 'var(--znn-ink)'}">{{ units(r.mine, 18, 4) }}</span>
              </td>
              <td class="td text-right">
                <router-link class="btn btn-sm" :to="`/pool/${r.pool.pair}`">Open</router-link>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!rows.length" class="px-4 py-10 text-center text-[13px] text-dim">
          <template v-if="dex.status === 'ready'">
            No pool matches. <router-link class="link" to="/pool/new">Create the first one</router-link>.
          </template>
          <template v-else>Reading the factory</template>
        </p>
      </div>
    </Panel>

    <Panel v-else title="Tokens" subtitle="Everything the pools hold, plus anything you imported">
      <div class="overflow-x-auto">
        <table class="w-full border-collapse">
          <thead>
            <tr>
              <th class="th">Token</th>
              <th class="th">Address</th>
              <th class="th">Pools</th>
              <th class="th">Held by pools</th>
              <th class="th">Your balance</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in tokenRows" :key="r.token.address">
              <td class="td">
                <span class="flex items-center gap-2.5">
                  <TokenLogo :symbol="r.token.symbol" :address="r.token.address" :size="22" />
                  <span>
                    <span class="block text-[13.5px] leading-tight">{{ r.token.symbol }}</span>
                    <span class="block text-[12px] text-dim">{{ r.token.name }}</span>
                  </span>
                </span>
              </td>
              <td class="td mono text-[12.5px] text-dim">{{ short(r.token.address, 10, 6) }}</td>
              <td class="td mono text-[13px]">{{ r.pools }}</td>
              <td class="td mono text-[13px]">{{ units(r.held, r.token.decimals, 2) }}</td>
              <td class="td mono text-[13px]">
                <span v-if="!wallet.address" class="text-dim">connect</span>
                <span v-else>{{ units(r.balance, r.token.decimals, 4) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!tokenRows.length" class="px-4 py-10 text-center text-[13px] text-dim">No token matches.</p>
      </div>
    </Panel>
  </div>
</template>
