<script setup lang="ts">
// Glyphswap's mark: a G drawn by the Rune Z's rules. It has the same 24-unit
// grid, one 2.6 stroke with mitred joins, and the same plasma gradient. Its
// corners are cut at 45 degrees, the angle of the Z's diagonal (chosen as G4,
// 2026-09-21).
//
// The gradient is pinned to the grid in user space, as Karum's mark is, so the
// family shares one vertical light whatever the shape of each letter.
withDefaults(defineProps<{size?: number}>(), {size: 24})
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="shrink-0">
    <defs>
      <linearGradient id="glyphswap-rune-plasma" gradientUnits="userSpaceOnUse" x1="0" y1="4" x2="0" y2="20">
        <stop offset="0%" stop-color="hsl(120 86% 63%)" />
        <stop offset="100%" stop-color="hsl(145 100% 38%)" />
      </linearGradient>
    </defs>
    <path
      d="M18.7,5.3H9.6L5.3,9.6V14.4L9.6,18.7H18.7V12H12"
      stroke="url(#glyphswap-rune-plasma)"
      stroke-width="2.6"
      stroke-linecap="square"
      stroke-linejoin="miter"
    />
  </svg>
</template>
