<script setup lang="ts">
import {endpoint} from '../core/endpoint'
import {dex} from '../core/dex'
import {chain} from '../core/chain'
import {chainName} from '../core/chains'
import {number, short} from '../core/format'
</script>

<template>
  <div class="panel mx-auto w-full max-w-[74ch] p-5 sm:p-6 grid gap-6">
    <div>
      <h1 class="text-[24px] font-semibold tracking-[-0.02em] mb-2">How trading here works</h1>
      <p class="text-[14.5px] text-soft">
        Glyphswap is Uniswap V2, deployed unchanged, on the ZVM. Only the chain underneath is different.
      </p>
    </div>

    <section class="grid gap-2">
      <h2 class="text-[16px] font-semibold">Ordered first, then executed</h2>
      <p class="text-[14px] text-soft">
        Zenon orders your transaction, and each momentum becomes one ZVM block, about every
        <span class="mono">{{ chain.interval.toFixed(1) }}</span> seconds. That is why a trade shows "ordered by NoM"
        before "executed". An approval and a swap are two transactions, so they take two momentums.
      </p>
    </section>

    <section class="grid gap-2">
      <h2 class="text-[16px] font-semibold">ZNN and QSR</h2>
      <p class="text-[14px] text-soft">
        ZNN is the native coin and pays for gas, so Max keeps a little back. It is wrapped to WZNN on the way
        through the router, and ZNN to WZNN is a wrap with no fee. QSR is an ERC-20 predeploy at
        <span class="mono">{{ short('0x4200000000000000000000000000000000000101', 10, 6) }}</span> with 8 decimals.
      </p>
    </section>

    <section class="grid gap-2">
      <h2 class="text-[16px] font-semibold">No backend</h2>
      <p class="text-[14px] text-soft">
        Your browser reads everything from the node you chose. Charts come from the pair's own logs, not an indexer.
        Switch nodes from the header, or with a link:
        <span class="mono whitespace-nowrap">?rpc=https://host/rpc</span>
      </p>
    </section>

    <section class="grid gap-2">
      <h2 class="text-[16px] font-semibold">Before you trade</h2>
      <p class="text-[14px] text-soft">
        Anyone can create a pool for any token, including one that copies a known symbol, so check token addresses.
        A small pool moves a long way on a small trade; the price impact figure shows how far.
      </p>
    </section>

    <section class="grid gap-2">
      <h2 class="text-[16px] font-semibold">Reading now</h2>
      <dl class="grid gap-2 text-[13.5px] rounded p-3" style="background: var(--sunk)">
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Node</dt>
          <dd class="mono break-all text-right">{{ endpoint.rpc }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Chain</dt>
          <dd class="mono">{{ chainName(endpoint.chainId) }} ({{ endpoint.chainId ?? 'unknown' }})</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Block</dt>
          <dd class="mono">{{ chain.head === null ? 'not read yet' : number(chain.head) }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Router</dt>
          <dd class="mono break-all text-right">{{ dex.router ?? 'not found' }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Factory</dt>
          <dd class="mono break-all text-right">{{ dex.factory ?? 'not found' }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Wrapped ZNN</dt>
          <dd class="mono break-all text-right">{{ dex.weth ?? 'not found' }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Addresses from</dt>
          <dd>{{ dex.source === 'none' ? 'nowhere yet' : dex.source }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>
