<script setup lang="ts">
// The swaps still in flight, in a bubble in the bottom right corner.
//
// One line per swap: what it trades and where it has got to. A line opens onto
// the same step rail the card used to show, with the transaction hashes, so
// nothing the card said about a swap is lost by moving it here. It sits outside
// the router view so it stays put while the person moves between pages, which
// is the point of not holding them on the swap card.
import {computed, ref} from 'vue'
import {dismiss, pending, type PendingSwap} from '../core/pending'
import {STEP_WORD} from '../core/tx'
import Icon from './Icon.vue'
import StepRail from './StepRail.vue'

const open = ref(new Set<number>())

function toggle(id: number) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

/** Where a swap has got to, in the chain's own words. */
function where(p: PendingSwap): string {
  if (p.status === 'done') return 'Executed'
  const step = p.steps.find((s) => s.state !== 'done')
  if (!step) return STEP_WORD.done
  // An approval ahead of the swap is said, so "Ordered by NoM" is not read as
  // the swap itself having been ordered.
  const which = p.steps.length > 1 && step === p.steps[0] ? 'Approval: ' : ''
  return which + STEP_WORD[step.state]
}

const running = computed(() => pending.items.filter((p) => p.status === 'running').length)
</script>

<template>
  <aside v-if="pending.items.length" class="bubble" aria-live="polite" data-pending-swaps>
    <header class="flex items-center justify-between gap-3 px-3.5 pt-2.5 pb-1.5">
      <span class="ledger">{{ running ? `${running} swap${running === 1 ? '' : 's'} in flight` : 'Swaps' }}</span>
    </header>

    <TransitionGroup name="swap-row" tag="ul" class="grid">
      <li v-for="p in pending.items" :key="p.id" class="row" :data-status="p.status">
        <div class="flex items-center gap-2.5 px-3.5 py-2">
          <button class="flex items-center gap-2.5 min-w-0 flex-1 text-left" :aria-expanded="open.has(p.id)" @click="toggle(p.id)">
            <Icon v-if="p.status === 'running'" name="refresh" :size="14" class="spin text-dim shrink-0" />
            <Icon v-else-if="p.status === 'done'" name="check" :size="14" class="shrink-0" style="color: var(--znn-ink)" />
            <Icon v-else name="x" :size="14" class="shrink-0" style="color: var(--danger)" />
            <span class="min-w-0 grid">
              <span class="mono text-[12.5px] truncate">{{ p.summary }}</span>
              <span
                class="text-[12px]"
                :style="p.status === 'failed' ? 'color: var(--danger)' : p.status === 'done' ? 'color: var(--znn-ink)' : 'color: var(--nom-ink)'"
                >{{ where(p) }}</span
              >
            </span>
            <Icon name="down" :size="13" class="text-dim shrink-0 ml-auto" :style="open.has(p.id) ? 'transform: rotate(180deg)' : ''" />
          </button>
          <button
            v-if="p.status !== 'running'"
            class="btn btn-sm btn-quiet px-1.5 shrink-0"
            title="Dismiss"
            @click="dismiss(p.id)"
          >
            <Icon name="x" :size="13" />
            <span class="sr-only">Dismiss</span>
          </button>
        </div>
        <!-- v-show, not v-if: the rail stays in the document while closed, which
             is what scripts/verify.mjs reads a swap's progress from. -->
        <div v-show="open.has(p.id)" class="px-3.5 pb-3">
          <StepRail :steps="p.steps" />
        </div>
      </li>
    </TransitionGroup>
  </aside>
</template>

<style scoped>
.bubble {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 40;
  width: min(340px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  overflow-y: auto;
  border-radius: calc(var(--radius) * 2);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  box-shadow: var(--shadow-pop);
  animation: bubble-in 260ms var(--ease);
}

.row + .row {
  border-top: 1px solid var(--line);
}

.row[data-status='failed'] {
  background: color-mix(in srgb, var(--danger) 6%, transparent);
}

@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
}

/* A new swap slides in; a finished one folds away rather than vanishing, so
   the eye sees which line left. */
.swap-row-enter-active,
.swap-row-leave-active {
  transition: opacity 220ms var(--ease), transform 220ms var(--ease);
}
.swap-row-enter-from,
.swap-row-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
</style>
