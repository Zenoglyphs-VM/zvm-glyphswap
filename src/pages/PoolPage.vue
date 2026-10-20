<script setup lang="ts">
// What you have put into pools.
//
// A position is shown as the two token amounts it would pay out right now,
// because that is what it is. The LP token balance is there too, but small: it
// is an implementation detail of the position, not the position.
import {computed} from 'vue'
import {dex, sideSymbol, tokenByAddress} from '../core/dex'
import {wallet} from '../core/wallet'
import {burnAmounts} from '../core/uniswap'
import {short, units} from '../core/format'
import TokenLogo from '../components/TokenLogo.vue'
import Icon from '../components/Icon.vue'
import InfoTip from '../components/InfoTip.vue'

const positions = computed(() =>
  dex.pools
    .map((pool, i) => ({pool, balance: dex.lp[i] ?? 0n}))
    .filter((p) => p.balance > 0n)
    .map(({pool, balance}) => {
      const [out0, out1] = burnAmounts(pool, balance)
      return {
        pool,
        balance,
        out0,
        out1,
        token0: tokenByAddress(pool.token0),
        token1: tokenByAddress(pool.token1),
        name0: sideSymbol(pool.token0),
        name1: sideSymbol(pool.token1),
        share: pool.totalSupply > 0n ? Number(balance) / Number(pool.totalSupply) : 0,
      }
    })
    .sort((a, b) => b.share - a.share),
)
</script>

<template>
  <div class="grid gap-4">
    <div class="panel px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-[18px] font-semibold tracking-[-0.02em] flex items-center gap-1.5">
        Your positions
        <InfoTip label="About positions">
          A position earns 0.3% of every trade that passes through its pool, in proportion to your share.
        </InfoTip>
      </h1>
      <router-link class="btn btn-plasma" to="/pool/new"><Icon name="plus" :size="15" /> New position</router-link>
    </div>

    <div v-if="!wallet.address" class="panel px-4 py-10 text-center">
      <p class="text-[14px]">Connect a wallet to see what you hold.</p>
      <p class="text-[13px] text-dim mt-1">
        Nothing is read from your wallet until you do, and no position exists until you make one.
      </p>
    </div>

    <div v-else-if="!positions.length" class="panel px-4 py-10 text-center">
      <p class="text-[14px]">You are not in any pool yet.</p>
      <p class="text-[13px] text-dim mt-1 mb-4">
        Deposit both sides of a pair and you take a share of the fees it earns.
      </p>
      <router-link class="btn btn-plasma" to="/pool/new">Open your first position</router-link>
    </div>

    <div v-else class="grid gap-3 sm:grid-cols-2">
      <router-link
        v-for="p in positions"
        :key="p.pool.pair"
        class="panel p-4 grid gap-3 transition-colors hover:border-[var(--line-strong)]"
        :to="`/pool/${p.pool.pair}`"
      >
        <div class="flex items-center justify-between gap-3">
          <span class="flex items-center gap-2.5">
            <span class="flex -space-x-2">
              <TokenLogo :symbol="p.name0 || '?'" :address="p.pool.token0" :size="24" />
              <TokenLogo :symbol="p.name1 || '?'" :address="p.pool.token1" :size="24" />
            </span>
            <span class="text-[14px]">{{ p.name0 }} and {{ p.name1 }}</span>
          </span>
          <span class="mono text-[13px]" style="color: var(--znn-ink)">{{ (p.share * 100).toFixed(p.share < 0.0001 ? 4 : 2) }}%</span>
        </div>

        <dl class="grid gap-1.5 text-[13px] rounded p-3" style="background: var(--sunk)">
          <div class="flex justify-between gap-3">
            <dt class="text-dim">{{ p.name0 }}</dt>
            <dd class="mono">{{ units(p.out0, p.token0?.decimals ?? 18, 6) }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">{{ p.name1 }}</dt>
            <dd class="mono">{{ units(p.out1, p.token1?.decimals ?? 18, 6) }}</dd>
          </div>
        </dl>

        <div class="flex items-center justify-between text-[12px] text-dim">
          <span class="mono">{{ short(p.pool.pair, 10, 6) }}</span>
          <span class="mono">{{ units(p.balance, 18, 6) }} pool tokens</span>
        </div>
      </router-link>
    </div>
  </div>
</template>
