<script setup lang="ts">
// What a submitted trade is doing, one line per transaction.
//
// The states are the chain's own, not a generic spinner: a transaction is
// signed, then ordered by a momentum, then executed by the ZVM. Blue while it
// is ordered and green once it has executed, which is the colour rule the rest
// of the app uses, so the wait is legible rather than mysterious.
import {computed} from 'vue'
import {endpoint} from '../core/endpoint'
import {STEP_WORD, type Step} from '../core/tx'
import {short} from '../core/format'
import Icon from './Icon.vue'
import Chip from '@zvm/web/components/Chip.vue'

const props = defineProps<{steps: Step[]}>()

const tone = {queued: 'plain', signing: 'warn', ordered: 'l1', done: 'l2', failed: 'bad'} as const

const txUrl = (hash: string) => (endpoint.apiBase ? `${endpoint.apiBase}/tx/${hash}` : null)

const anyRunning = computed(() => props.steps.some((s) => s.state === 'signing' || s.state === 'ordered'))
</script>

<template>
  <ol v-if="steps.length" class="grid gap-2.5 text-[13px]">
    <li v-for="(s, i) in steps" :key="i" class="grid gap-1" :data-state="s.state">
      <div class="flex items-center justify-between gap-2">
        <span class="min-w-0 flex items-center gap-2">
          <Icon
            v-if="s.state === 'signing' || s.state === 'ordered'"
            name="refresh"
            :size="13"
            class="spin text-dim"
          />
          <Icon v-else-if="s.state === 'done'" name="check" :size="13" style="color: var(--znn-ink)" />
          <Icon v-else-if="s.state === 'failed'" name="x" :size="13" style="color: var(--danger)" />
          <Icon v-else name="clock" :size="13" class="text-dim" />
          <span class="truncate">{{ s.label }}</span>
        </span>
        <Chip :tone="tone[s.state]" :dot="s.state === 'ordered' || s.state === 'done'">{{ STEP_WORD[s.state] }}</Chip>
      </div>
      <div v-if="s.hash" class="text-[12px] text-dim pl-[21px]">
        <a v-if="txUrl(s.hash)" class="link mono" :href="txUrl(s.hash)!" target="_blank" rel="noreferrer noopener">
          {{ short(s.hash, 10, 6) }}
        </a>
        <span v-else class="mono">{{ short(s.hash, 10, 6) }}</span>
      </div>
      <p v-if="s.detail" class="text-[12.5px] pl-[21px] break-words" :style="s.state === 'failed' ? 'color: var(--danger)' : ''">
        {{ s.detail }}
      </p>
    </li>
    <li v-if="anyRunning" class="text-[12px] text-dim">
      Zenon orders this into a momentum first, then the ZVM executes it. That is normally two momentums, about
      thirty seconds.
    </li>
  </ol>
</template>
