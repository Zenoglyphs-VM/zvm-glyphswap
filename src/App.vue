<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {endpoint, check} from './core/endpoint'
import {chain, startChainPolling} from './core/chain'
import {startDex} from './core/dex'
import {startPrices} from './core/prices'
import {restoreWallet, wallet} from './core/wallet'
import {number} from './core/format'
import MomentumPulse from './components/MomentumPulse.vue'
import LatticeBackground from '@zvm/web/components/LatticeBackground.vue'
import GlyphswapMark from './components/GlyphswapMark.vue'
import ConnectButton from './components/ConnectButton.vue'
import NodePicker from './components/NodePicker.vue'
import PendingSwaps from './components/PendingSwaps.vue'
import Icon from './components/Icon.vue'

const nav = [
  {to: '/', label: 'Swap'},
  {to: '/explore', label: 'Explore'},
  {to: '/pool', label: 'Pool'},
  {to: '/bridge', label: 'Bridge'},
  {to: '/faucet', label: 'Faucet'},
]

const menuOpen = ref(false)

const theme = ref(document.documentElement.getAttribute('data-theme') ?? 'dark')
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
  try {
    localStorage.setItem('glyphswap.theme', theme.value)
  } catch {
    /* storage can be blocked; the theme still applies for this tab */
  }
}

const offline = computed(() => endpoint.health === 'error')

onMounted(async () => {
  await check()
  startChainPolling()
  startDex()
  // Dollars are optional here: an endpoint with no node in front of it has no
  // /api/prices, and the store simply holds nothing. See core/prices.ts.
  startPrices()
  await restoreWallet()
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <LatticeBackground />

    <header class="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
      <div class="mx-auto max-w-[1180px] px-4 py-2.5 flex items-center gap-3">
        <router-link to="/" class="flex items-center gap-2.5 shrink-0" title="Glyphswap">
          <GlyphswapMark :size="26" />
          <span class="font-semibold tracking-[-0.02em] text-[15.5px] hidden sm:block">Glyphswap</span>
        </router-link>

        <nav class="hidden md:flex items-center gap-1 ml-2">
          <router-link v-for="item in nav" :key="item.to" :to="item.to" class="tab" active-class="tab-on" :exact="item.to === '/'">
            {{ item.label }}
          </router-link>
        </nav>

        <span class="grow" />

        <router-link to="/about" class="btn btn-sm btn-quiet px-2" title="How trading here works">
          <Icon name="info" :size="15" />
          <span class="sr-only">How trading here works</span>
        </router-link>

        <button class="btn btn-sm btn-quiet px-2" :title="`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`" @click="toggleTheme">
          <Icon :name="theme === 'dark' ? 'sun' : 'moon'" :size="15" />
          <span class="sr-only">Switch theme</span>
        </button>

        <div class="hidden sm:block"><NodePicker /></div>
        <ConnectButton />

        <button class="btn btn-sm btn-quiet px-2 md:hidden" title="Menu" @click="menuOpen = !menuOpen">
          <Icon :name="menuOpen ? 'x' : 'menu'" :size="16" />
          <span class="sr-only">Menu</span>
        </button>
      </div>

      <!-- The chain's beat. One momentum orders one block, and this fills across
           the gap between them. -->
      <MomentumPulse />

      <div v-if="menuOpen" class="md:hidden border-t border-line px-4 py-3 grid gap-3 bg-surface">
        <div class="grid gap-1">
          <router-link
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="px-3 py-2 rounded text-[14px] text-dim hover:bg-raised transition-colors"
            active-class="!text-fg bg-raised"
            @click="menuOpen = false"
          >
            {{ item.label }}
          </router-link>
        </div>
        <div class="sm:hidden"><NodePicker /></div>
      </div>
    </header>

    <!-- One banner, not one per failed read: when the node is unreachable,
         every page below is empty for the same reason. -->
    <div
      v-if="offline"
      class="border-b"
      style="border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 9%, transparent)"
    >
      <div class="mx-auto max-w-[1180px] px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Icon name="alert" :size="15" style="color: var(--danger)" />
        <span>{{ endpoint.error }}</span>
        <span v-if="endpoint.hint" class="text-dim">{{ endpoint.hint }}</span>
        <button class="btn btn-sm ml-auto" @click="check()"><Icon name="refresh" :size="13" /> Try again</button>
      </div>
    </div>

    <main class="mx-auto w-full max-w-[1180px] px-4 py-5 flex-1">
      <p v-if="wallet.error" class="card px-4 py-2.5 mb-4 text-[13px]" style="color: var(--danger)">{{ wallet.error }}</p>
      <router-view />
    </main>

    <!-- One line. It says what the page is reading and nothing the header
         already says louder. -->
    <footer class="border-t border-line mt-8 bg-bg/85 backdrop-blur-md">
      <div class="mx-auto max-w-[1180px] px-4 py-3.5 flex flex-wrap items-center gap-x-5 gap-y-1 mono text-[12px] text-dim">
        <span class="break-all">{{ endpoint.rpc }}</span>
        <span v-if="endpoint.chainId !== null">chain {{ endpoint.chainId }}</span>
        <span v-if="chain.head !== null" class="sm:ml-auto">block {{ number(chain.head) }}</span>
      </div>
    </footer>

    <!-- Swaps in flight. Outside the router view so they survive navigation. -->
    <PendingSwaps />
  </div>
</template>
