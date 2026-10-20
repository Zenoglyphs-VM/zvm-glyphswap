<script setup lang="ts">
// Every trade this pair has seen inside the window, newest first.
//
// Buy and sell are named from the base token's side, and carry a word as well
// as a colour, so the column is readable without the legend.
import {computed} from 'vue'
import {endpoint} from '../core/endpoint'
import {wallet} from '../core/wallet'
import {sideSymbol} from '../core/dex'
import type {Trade} from '../core/history'
import type {Token} from '../core/uniswap'
import {ago, price as fmtPrice, units} from '../core/format'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{trades: Trade[]; base: Token; quote: Token; limit?: number; loading?: boolean}>(),
  {limit: 12},
)

const rows = computed(() => props.trades.slice(0, props.limit))
const baseName = computed(() => sideSymbol(props.base.address) || props.base.symbol)
const quoteName = computed(() => sideSymbol(props.quote.address) || props.quote.symbol)
const txUrl = (hash: string) => (endpoint.apiBase ? `${endpoint.apiBase}/tx/${hash}` : null)
const isMine = (t: Trade) => !!wallet.address && t.taker.toLowerCase() === wallet.address.toLowerCase()
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full border-collapse">
      <thead>
        <tr>
          <th class="th">Side</th>
          <th class="th">{{ baseName }}</th>
          <th class="th">{{ quoteName }}</th>
          <th class="th">Price</th>
          <th class="th hidden sm:table-cell">Block</th>
          <th class="th text-right">When</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in rows" :key="t.hash + t.block">
          <td class="td">
            <span
              class="flex items-center gap-1.5 text-[13px]"
              :style="{color: t.side === 'buy' ? 'var(--znn-ink)' : 'var(--danger)'}"
            >
              <span class="dot" :style="{background: 'currentColor'}" />
              {{ t.side === 'buy' ? 'Bought' : 'Sold' }}
            </span>
          </td>
          <td class="td mono text-[13px]">{{ units(t.baseAmount, base.decimals, 4) }}</td>
          <td class="td mono text-[13px]">{{ units(t.quoteAmount, quote.decimals, 4) }}</td>
          <td class="td mono text-[13px]">{{ fmtPrice(t.price) }}</td>
          <td class="td mono text-[13px] text-dim hidden sm:table-cell">{{ t.block }}</td>
          <td class="td text-right whitespace-nowrap">
            <span class="text-[12.5px] text-dim">{{ ago(t.time) }}</span>
            <span v-if="isMine(t)" class="ml-2 text-[11px]" style="color: var(--new-ink)">you</span>
            <a
              v-if="txUrl(t.hash)"
              class="link ml-2 inline-block align-middle"
              :href="txUrl(t.hash)!"
              target="_blank"
              rel="noreferrer noopener"
              :title="t.hash"
              ><Icon name="external" :size="13"
            /></a>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="!rows.length && !loading" class="px-4 py-8 text-[13px] text-dim text-center">
      No trades in the window read from this node. The first one will appear here about a momentum after it is
      sent.
    </p>
    <p v-else-if="!rows.length" class="px-4 py-8 text-[13px] text-dim text-center">Reading the pair's logs</p>
  </div>
</template>
