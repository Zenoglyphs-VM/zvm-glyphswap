<script setup lang="ts">
// A token's mark.
//
// Two are real marks; everything else wears its own initials. There is no logo
// registry on a devnet and nothing is fetched at runtime, so a token the chain
// has never heard of still gets something stable to look at: a hue derived from
// its address, the same on every machine and in every session, with no list for
// anyone to maintain.
import {computed} from 'vue'
import {tokenColor} from '../core/format'

const props = withDefaults(defineProps<{symbol: string; address?: string; size?: number}>(), {size: 24})

interface Mark {
  viewBox: string
  /**
   * Height as a share of the chip. Tuned so the two carry the same weight, and
   * so both sit inside the ring with a little air rather than touching it.
   */
  scale: number
  paths: {d: string; rule?: 'evenodd' | 'nonzero'}[]
}

/**
 * ZN is Zenon's own monogram, taken from the brand file unchanged, winding and
 * all, which is why its one path keeps `nonzero`.
 *
 * Q is traced from the QSR mark rather than invented. Measured off that file:
 * an outer diameter of 61px with a 7px wall, so the ring is about a ninth of
 * its own width, and a short stub at the lower right that leaves the ring at
 * roughly 60 degrees below horizontal and reaches only a third of a radius past
 * it. The source raster is stretched sideways, 61 across for 49 down on what
 * has to be a circle, so the proportions here come from the wall and the stub
 * rather than from the two axes.
 *
 * The ring and the stub are separate paths on purpose. As one path they
 * cancelled where they overlap, which left the stub floating clear of the ring
 * and read as a magnifying glass rather than a letter.
 */
const MARKS: Record<string, Mark> = {
  ZNN: {
    viewBox: '0 0 55 88',
    scale: 0.62,
    paths: [
      {
        rule: 'nonzero',
        d: 'M54.9222065,0 L0,0 L0,10.7961165 L35.3182461,10.7961165 L0,32.6990291 L0,34.1747573 L0,44.8932039 L0,88 L9.56859972,88 L9.56859972,60.4271845 L45.1980198,88 L55,88 L55,81.5533981 L55,34.1747573 L18.0480905,34.1747573 L54.9222065,10.6407767 L54.9222065,0 Z M46,45 L46,74 L10,45.0783784 L10,45.0783784 L46,45.0783784 L46,45 Z',
      },
    ],
  },
  QSR: {
    viewBox: '0 0 64 64',
    // The drawing does not fill its box the way ZN does, so it is set larger to
    // carry the same weight beside it.
    scale: 0.69,
    paths: [
      {
        rule: 'evenodd',
        d: 'M32,3 A26,26 0 1,0 32,55 A26,26 0 1,0 32,3 Z M32,9.5 A19.5,19.5 0 1,1 32,48.5 A19.5,19.5 0 1,1 32,9.5 Z',
      },
      {d: 'M39.6,50.1 L45.7,60.7 L52.6,56.7 L46.5,46.1 Z'},
    ],
  },
}

/** Wrapped ZNN is ZNN, and wrapped QSR is QSR. Both wear the same mark. */
const ALIASES: Record<string, string> = {ZNN: 'ZNN', WZNN: 'ZNN', QSR: 'QSR', WQSR: 'QSR'}

const mark = computed<Mark | undefined>(() => MARKS[ALIASES[props.symbol.toUpperCase()] ?? ''])

const initials = computed(() => props.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?')

const color = computed(() => {
  const brand = tokenColor(props.symbol)
  if (brand) return brand
  const seed = (props.address ?? props.symbol).toLowerCase()
  let h = 0
  for (let i = 2; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return `hsl(${h} 58% 62%)`
})
</script>

<template>
  <span
    class="token-logo"
    :style="{
      width: `${size}px`,
      height: `${size}px`,
      fontSize: `${Math.round(size * 0.4)}px`,
      color: color,
      background: `color-mix(in srgb, ${color} 16%, var(--raised))`,
      borderColor: `color-mix(in srgb, ${color} 38%, transparent)`,
    }"
    :title="symbol"
    aria-hidden="true"
  >
    <svg
      v-if="mark"
      :viewBox="mark.viewBox"
      :style="{height: `${Math.round(size * mark.scale)}px`}"
      fill="currentColor"
      preserveAspectRatio="xMidYMid meet"
    >
      <path v-for="(p, i) in mark.paths" :key="i" :d="p.d" :fill-rule="p.rule" />
    </svg>
    <template v-else>{{ initials }}</template>
  </span>
</template>

<style scoped>
.token-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 99px;
  border: 1px solid;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
  overflow: hidden;
}

.token-logo svg {
  display: block;
  width: auto;
}
</style>
