<script setup lang="ts">
// Slippage, deadline and the two approval choices. A popover rather than a
// page, because these are adjustments to the trade in front of you.
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {settings, resetSettings} from '../core/settings'
import Icon from './Icon.vue'

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const PRESETS = [10, 50, 100]

const custom = computed({
  get: () => (settings.slippageBps / 100).toString(),
  set: (v: string) => {
    const pct = Number(v)
    if (!isFinite(pct)) return
    settings.slippageBps = Math.max(1, Math.min(5000, Math.round(pct * 100)))
  },
})

/** Loud slippage is how a trade gets taken apart, so the number says so itself. */
const slippageWarning = computed(() => {
  if (settings.slippageBps > 500) return 'A trade can lose more than five percent at this setting.'
  if (settings.slippageBps < 10) return 'This is tight enough that a busy pool will reject the trade.'
  return ''
})

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="root" class="relative">
    <button
      class="btn btn-sm btn-quiet px-2"
      :title="`Slippage ${(settings.slippageBps / 100).toFixed(2)}%, deadline ${settings.deadlineMin} minutes`"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Icon name="sliders" :size="15" />
      <span class="mono text-[11.5px]">{{ (settings.slippageBps / 100).toFixed(2) }}%</span>
    </button>

    <div v-if="open" class="absolute right-0 mt-2 z-40 pop p-3.5 w-[300px] grid gap-3.5">
      <div class="grid gap-2">
        <label class="ledger" for="slip">Maximum slippage</label>
        <div class="flex gap-1.5">
          <button
            v-for="b in PRESETS"
            :key="b"
            class="btn btn-sm grow"
            :style="settings.slippageBps === b ? 'background: var(--raised); border-color: var(--dim)' : ''"
            @click="settings.slippageBps = b"
          >
            {{ b / 100 }}%
          </button>
          <div class="relative w-[88px]">
            <input id="slip" v-model="custom" class="input pr-6 text-right" inputmode="decimal" aria-label="Custom slippage, percent" />
            <span class="absolute right-2 top-1/2 -translate-y-1/2 text-dim text-[12px]">%</span>
          </div>
        </div>
        <p class="text-[12px] text-dim">
          The trade is refused on chain if the price moves further than this before the momentum carrying it is
          derived.
        </p>
        <p v-if="slippageWarning" class="text-[12px]" style="color: var(--warn)">{{ slippageWarning }}</p>
      </div>

      <div class="grid gap-2 border-t border-line pt-3">
        <label class="ledger" for="deadline">Deadline</label>
        <div class="flex items-center gap-2">
          <input
            id="deadline"
            v-model.number="settings.deadlineMin"
            type="number"
            min="1"
            max="1440"
            class="input w-[86px]"
          />
          <span class="text-[13px] text-dim">minutes</span>
        </div>
      </div>

      <label class="flex items-start gap-2.5 border-t border-line pt-3 cursor-pointer">
        <input v-model="settings.exactApproval" type="checkbox" class="mt-1 accent-[var(--znn)]" />
        <span class="text-[13px]">
          Approve only this trade
          <span class="block text-[12px] text-dim">
            Off leaves the router able to move that token until you revoke it, and saves an approval on every
            later trade.
          </span>
        </span>
      </label>

      <label class="flex items-start gap-2.5 cursor-pointer">
        <input v-model="settings.allowHighImpact" type="checkbox" class="mt-1 accent-[var(--znn)]" />
        <span class="text-[13px]">
          Allow trades above five percent impact
          <span class="block text-[12px] text-dim">
            Normally a trade that moves the pool this far is refused here before your wallet ever sees it.
          </span>
        </span>
      </label>

      <div class="flex justify-end border-t border-line pt-3">
        <button class="btn btn-sm btn-quiet" @click="resetSettings">Reset to defaults</button>
      </div>
    </div>
  </div>
</template>
