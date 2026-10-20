<script setup lang="ts">
import {useRoute} from 'vue-router'
const route = useRoute()
</script>

<template>
  <div class="mx-auto max-w-[60ch] py-16 text-center grid gap-3">
    <h1 class="text-[20px] font-semibold tracking-[-0.02em]">Nothing at this address</h1>
    <p class="text-[14px] text-dim mono break-all">{{ route.fullPath }}</p>
    <div class="flex justify-center gap-2 pt-2">
      <router-link class="btn btn-plasma" to="/">Go to the swap</router-link>
      <router-link class="btn" to="/explore">See the pools</router-link>
    </div>
  </div>
</template>
