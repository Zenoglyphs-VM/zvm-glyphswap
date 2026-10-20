<script setup lang="ts">
// The pair, its price now, and the four numbers a trader checks before
// deciding the pool is deep enough to trade in.
//
// The price is the hero of this page, so it is set large and in mono: it is the
// one figure on screen that changes on its own, and tabular figures keep it
// from jittering as it does.
import {computed} from 'vue'
import {reservesFor, type Pool, type Token} from '../core/uniswap'
import {spotPrice} from '../core/history'
import {sideSymbol} from '../core/dex'
import {price as fmtPrice, units, number, percent} from '../core/format'
import TokenLogo from './TokenLogo.vue'
import Icon from './Icon.vue'

const props = defineProps<{
  pool: Pool | undefined
  base: Token | undefined
  quote: Token | undefined
  change24h: number | null
  volume24hBase: bigint
  trades24h: number
  /** The window those two figures were measured over, written out. */
  span?: string
  loading?: boolean
}>()

// A pool holds wrapped ZNN; the pair is still called ZNN.
const baseName = computed(() => sideSymbol(props.base?.address) || props.base?.symbol || '')
const quoteName = computed(() => sideSymbol(props.quote?.address) || props.quote?.symbol || '')

const spot = computed(() => (props.pool && props.base && props.quote ? spotPrice(props.pool, props.base, props.quote) : 0))

const reserves = computed(() => {
  if (!props.pool || !props.base) return null
  const [rBase, rQuote] = reservesFor(props.pool, props.base.address)
  return {rBase, rQuote}
})

const up = computed(() => (props.change24h ?? 0) >= 0)
</script>

<template>
  <div v-if="pool && base && quote" class="grid gap-3">
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="flex -space-x-2">
            <TokenLogo :symbol="baseName" :address="base.address" :size="26" />
            <TokenLogo :symbol="quoteName" :address="quote.address" :size="26" />
          </span>
          <h2 class="text-[15px] font-semibold tracking-[-0.01em]">{{ baseName }} and {{ quoteName }}</h2>
          <slot name="badge" />
        </div>
        <div class="flex items-baseline gap-2.5 flex-wrap">
          <span class="num text-[34px] leading-none tracking-[-0.02em]">{{ fmtPrice(spot) }}</span>
          <span class="text-[13.5px] text-dim">{{ quoteName }} per {{ baseName }}</span>
          <span
            v-if="change24h !== null"
            class="flex items-center gap-1 text-[13.5px] mono"
            :style="{color: up ? 'var(--znn-ink)' : 'var(--danger)'}"
          >
            <Icon :name="up ? 'up' : 'down'" :size="14" />
            {{ percent(Math.abs(change24h)) }}
          </span>
        </div>
      </div>
      <slot name="actions" />
    </div>

    <dl class="grid gap-x-6 gap-y-2.5 grid-cols-2 sm:grid-cols-4 border-t border-line pt-3">
      <div>
        <dt class="ledger">{{ baseName }} in the pool</dt>
        <dd class="mono text-[14px]">{{ units(reserves?.rBase, base.decimals, 2) }}</dd>
      </div>
      <div>
        <dt class="ledger">{{ quoteName }} in the pool</dt>
        <dd class="mono text-[14px]">{{ units(reserves?.rQuote, quote.decimals, 2) }}</dd>
      </div>
      <div>
        <dt class="ledger">Traded, {{ span ?? 'last 24 hours' }}</dt>
        <dd class="mono text-[14px]">
          {{ units(volume24hBase, base.decimals, 2) }} <span class="text-dim text-[12px]">{{ baseName }}</span>
        </dd>
      </div>
      <div>
        <dt class="ledger">Trades, {{ span ?? 'last 24 hours' }}</dt>
        <!-- Blank only before the first read. The chart reloads on every block,
             and a count that blinks empty each time reads as a fault. -->
        <dd class="mono text-[14px]">{{ loading && trades24h === 0 ? '' : number(trades24h) }}</dd>
      </div>
    </dl>
  </div>
</template>
