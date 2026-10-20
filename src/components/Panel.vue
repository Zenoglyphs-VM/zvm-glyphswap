<script setup lang="ts">
defineProps<{title?: string; subtitle?: string}>()
</script>

<template>
  <section class="panel overflow-hidden">
    <header
      v-if="title || $slots.actions"
      class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-b border-line"
    >
      <div class="min-w-0">
        <h2 class="ledger">{{ title }}</h2>
        <p v-if="subtitle" class="text-[12.5px] text-dim mt-0.5">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>
