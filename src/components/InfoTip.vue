<script setup lang="ts">
// An info mark that explains a heading without putting a paragraph under it.
//
// It opens on hover and on keyboard focus, and a tap toggles it, because a
// phone has no hover and a tooltip that only hovers is invisible there. The
// text is also the button's accessible description, so a screen reader hears
// it on focus without the bubble having to be open.
import {computed, nextTick, ref, useId, watch} from 'vue'
import Icon from './Icon.vue'

withDefaults(defineProps<{label?: string}>(), {label: 'About this'})

const id = useId()
const pinned = ref(false)
const hovered = ref(false)
const open = computed(() => pinned.value || hovered.value)

// The bubble hangs from the mark, so a mark near the right edge of a phone
// would push it off screen. It is nudged left by whatever it overhangs.
const body = ref<HTMLElement | null>(null)
const shift = ref(0)
watch(open, async (isOpen) => {
  if (!isOpen) return
  shift.value = 0
  await nextTick()
  const r = body.value?.getBoundingClientRect()
  if (r) shift.value = Math.min(0, window.innerWidth - 16 - r.right)
})

function dismiss(event: KeyboardEvent) {
  pinned.value = false
  hovered.value = false
  ;(event.currentTarget as HTMLElement).blur()
}
</script>

<template>
  <span class="tip relative inline-flex align-middle" @mouseenter="hovered = true" @mouseleave="hovered = false">
    <button
      type="button"
      class="tip-mark"
      :aria-label="label"
      :aria-describedby="id"
      :class="{on: open}"
      @click="pinned = !pinned"
      @blur="pinned = false"
      @keydown.esc="dismiss"
    >
      <Icon name="info" :size="15" />
    </button>
    <span
      :id="id"
      ref="body"
      role="tooltip"
      class="tip-body pop"
      :class="{open}"
      :style="{marginLeft: `${shift}px`}"
    >
      <slot />
    </span>
  </span>
</template>

<style scoped>
.tip-mark {
  display: inline-flex;
  padding: 3px;
  border-radius: 999px;
  color: var(--dim);
  transition: color 0.15s;
}
.tip-mark:hover,
.tip-mark:focus-visible,
.tip-mark.on {
  color: var(--fg);
}

.tip-body {
  position: absolute;
  top: calc(100% + 6px);
  left: -8px;
  z-index: 40;
  width: max-content;
  max-width: min(340px, calc(100vw - 32px));
  padding: 10px 12px;
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.5;
  letter-spacing: 0;
  text-transform: none;
  color: var(--soft);
  white-space: normal;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-3px);
  transition:
    opacity 0.14s,
    transform 0.14s,
    visibility 0s linear 0.14s;
  pointer-events: none;
}
/* Keyboard focus opens it too, which is what makes it reachable without a mouse. */
.tip-body.open,
.tip:has(.tip-mark:focus-visible) .tip-body {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition:
    opacity 0.14s,
    transform 0.14s;
  pointer-events: auto;
}
</style>
