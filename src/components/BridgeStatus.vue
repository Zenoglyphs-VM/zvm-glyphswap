<script setup lang="ts">
// Whether bridging works right now, judged per direction, with the numbers the
// judgement rests on. The two directions fail for different reasons — a deposit
// needs only derivation, a withdrawal also needs the committee — so one green
// dot for "the bridge" would be wrong half the time it mattered.
import {computed, ref} from 'vue'
import Chip from '@zvm/web/components/Chip.vue'
import {bridge, health, NOM_DECIMALS, type Health} from '../core/bridge'
import {ago, short, units, znn} from '../core/format'
import {endpoint} from '../core/endpoint'
import Panel from './Panel.vue'
import Icon from './Icon.vue'

const h = computed(() => health())

const WORD: Record<Health, string> = {operational: 'Working', degraded: 'Slow', down: 'Stopped', unknown: 'Checking'}
const TONE = {operational: 'l2', degraded: 'warn', down: 'bad', unknown: 'plain'} as const

const nom = (v: string | null | undefined) => (v == null ? '—' : units(v, NOM_DECIMALS, 2))

const c = computed(() => bridge.committee)
const lastSweep = computed(() => (c.value?.lastOkAt ? ago(Math.floor(Date.parse(c.value.lastOkAt) / 1000)) : null))
const paid = computed(() => c.value?.payouts?.paid ?? 0)

// Addresses are shortened to fit the column, so copying is the way to get the
// whole of one. The tick stays until another is copied.
const copied = ref('')
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = value
  } catch {
    /* the full address is still in the title, to select by hand */
  }
}
</script>

<template>
  <Panel title="Bridge status">
    <template #actions>
      <span v-if="bridge.checkedAt" class="text-[11.5px] text-dim">updates every 6 s</span>
    </template>

    <div v-if="bridge.error && !bridge.checkedAt" class="px-4 py-4 text-[13px] flex items-start gap-2" style="color: var(--danger)">
      <Icon name="alert" :size="15" class="mt-0.5" />
      <span>{{ bridge.error }}</span>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 border-b border-line">
        <div class="px-4 py-3 border-r border-line">
          <div class="ledger mb-1.5">Deposits in</div>
          <Chip :tone="TONE[h.deposits]" dot>{{ WORD[h.deposits] }}</Chip>
        </div>
        <div class="px-4 py-3">
          <div class="ledger mb-1.5">Withdrawals out</div>
          <Chip :tone="TONE[h.withdrawals]" dot>{{ WORD[h.withdrawals] }}</Chip>
        </div>
      </div>

      <ul v-if="h.why.length" class="px-4 py-3 border-b border-line grid gap-1.5 text-[12.5px]">
        <li v-for="w in h.why" :key="w" class="flex items-start gap-2">
          <Icon name="alert" :size="13" class="mt-0.5 shrink-0" style="color: var(--warn)" />
          <span>{{ w }}</span>
        </li>
      </ul>

      <dl class="px-4 py-3 grid gap-2 text-[13px]">
        <div class="flex justify-between items-center gap-3">
          <dt class="text-dim">Vault address</dt>
          <dd class="mono flex items-center gap-1" :title="bridge.vault || undefined">
            <template v-if="bridge.vault">
              {{ short(bridge.vault, 8, 6) }}
              <button class="copy" aria-label="Copy the vault address" @click="copy(bridge.vault)">
                <Icon :name="copied === bridge.vault ? 'check' : 'copy'" :size="13" />
              </button>
            </template>
            <template v-else>unknown</template>
          </dd>
        </div>
        <div class="flex justify-between items-center gap-3">
          <dt class="text-dim">Bridge contract</dt>
          <dd class="mono flex items-center gap-1" :title="bridge.bridge">
            <a
              v-if="endpoint.apiBase"
              class="link"
              :href="`${endpoint.apiBase}/address/${bridge.bridge}`"
              target="_blank"
              rel="noreferrer noopener"
              >{{ short(bridge.bridge, 8, 6) }}</a
            >
            <template v-else>{{ short(bridge.bridge, 8, 6) }}</template>
            <button class="copy" aria-label="Copy the bridge contract address" @click="copy(bridge.bridge)">
              <Icon :name="copied === bridge.bridge ? 'check' : 'copy'" :size="13" />
            </button>
          </dd>
        </div>
        <div class="flex justify-between gap-3 border-t border-line pt-2 mt-1">
          <dt class="text-dim">Vault on Zenon</dt>
          <dd class="mono text-right">{{ nom(bridge.vaultZnn) }} ZNN · {{ nom(bridge.vaultQsr) }} QSR</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Locked on the ZVM</dt>
          <dd class="mono">{{ bridge.lockedOnZVM == null ? '—' : znn(bridge.lockedOnZVM, 2) }} ZNN</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Waiting to be paid</dt>
          <dd class="mono text-right">{{ nom(c?.pendingZNN) }} ZNN · {{ nom(c?.pendingQSR) }} QSR</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Payouts made</dt>
          <dd class="mono">{{ paid }}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-dim">Committee last swept</dt>
          <dd class="mono">{{ lastSweep ?? 'never' }}</dd>
        </div>
        <div v-if="bridge.derivation" class="flex justify-between gap-3">
          <dt class="text-dim">Derivation behind Zenon</dt>
          <dd class="mono">{{ bridge.derivation.lag }} momentum{{ bridge.derivation.lag === 1 ? '' : 's' }}</dd>
        </div>
      </dl>

      <p v-if="bridge.error" class="px-4 pb-3 text-[12px]" style="color: var(--danger)">
        Last refresh failed: {{ bridge.error }}. Showing the last good copy.
      </p>
    </template>
  </Panel>
</template>

<style scoped>
.copy {
  display: inline-flex;
  padding: 3px;
  border-radius: 6px;
  color: var(--dim);
  transition: color 0.15s;
}
.copy:hover,
.copy:focus-visible {
  color: var(--fg);
}
</style>
