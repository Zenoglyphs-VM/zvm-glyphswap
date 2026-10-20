<script setup lang="ts">
// Which node this interface trades against. It is a first class control rather
// than a buried setting, because on a devnet the node is the thing that changes
// most often, and pointing the app at your own is the normal case.
import {computed, ref, watch} from 'vue'
import {endpoint, setEndpoint, check, PRESETS, isLoopback, mixedContentBlocked, normalize} from '../core/endpoint'
import {chain} from '../core/chain'
import {chainName, overrideFor, setOverride} from '../core/chains'
import {dex, loadDex} from '../core/dex'
import {number, short} from '../core/format'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

const open = ref(false)
const draft = ref(endpoint.rpc)
const busy = ref(false)
const showAdvanced = ref(false)

const router = ref('')
const factory = ref('')
const weth = ref('')

watch(
  () => endpoint.rpc,
  (v) => (draft.value = v),
)

watch(open, (isOpen) => {
  if (!isOpen) return
  draft.value = endpoint.rpc
  const saved = endpoint.chainId !== null ? overrideFor(endpoint.chainId) : null
  router.value = saved?.router ?? ''
  factory.value = saved?.factory ?? ''
  weth.value = saved?.weth ?? ''
})

const tone = computed(() => {
  if (busy.value || endpoint.health === 'checking') return 'var(--warn)'
  if (endpoint.health === 'ok') return 'var(--znn-ink)'
  if (endpoint.health === 'error') return 'var(--danger)'
  return 'var(--dim)'
})

const label = computed(() => {
  if (endpoint.health === 'error') return 'No node'
  if (endpoint.chainId === null) return 'Connecting'
  return chainName(endpoint.chainId)
})

const willBlock = computed(() => mixedContentBlocked(normalize(draft.value)))
const dirty = computed(() => normalize(draft.value) !== endpoint.rpc)

async function use(url: string) {
  busy.value = true
  try {
    draft.value = url
    // A node that answered is the end of the errand, so the dialog gets out of
    // the way. One that did not stays open, with the reason under the field.
    if (await setEndpoint(url)) open.value = false
  } finally {
    busy.value = false
  }
}

async function retry() {
  busy.value = true
  try {
    await check()
  } finally {
    busy.value = false
  }
}

function saveAddresses() {
  if (endpoint.chainId === null) return
  const clean = (s: string) => s.trim()
  if (!clean(router.value) && !clean(factory.value) && !clean(weth.value)) {
    setOverride(endpoint.chainId, null)
  } else {
    setOverride(endpoint.chainId, {
      router: clean(router.value) as any,
      factory: clean(factory.value) as any,
      weth: clean(weth.value) as any,
    })
  }
  void loadDex()
}

function clearAddresses() {
  if (endpoint.chainId === null) return
  router.value = ''
  factory.value = ''
  weth.value = ''
  setOverride(endpoint.chainId, null)
  void loadDex()
}
</script>

<template>
  <div>
    <button class="btn btn-sm" :title="endpoint.rpc" @click="open = true">
      <span class="dot" :class="endpoint.health === 'checking' ? 'live-dot' : ''" :style="{background: tone}" />
      <span class="text-[12.5px]">{{ label }}</span>
      <Icon name="down" :size="13" class="text-dim" />
    </button>

    <Modal :open="open" title="Node" :width="460" @close="open = false">
      <div class="p-4 grid gap-4">
        <form class="grid gap-2" @submit.prevent="use(draft)">
          <label class="ledger" for="rpc-url">JSON-RPC endpoint</label>
          <div class="flex gap-2">
            <input
              id="rpc-url"
              v-model="draft"
              class="input"
              spellcheck="false"
              autocomplete="off"
              placeholder="https://host/rpc"
            />
            <button class="btn btn-plasma" type="submit" :disabled="busy || !dirty">Use</button>
          </div>
          <p class="text-[12px] text-dim">
            Paste any ZVM node. A host with no path is tried at the root and at
            <code class="mono">/rpc</code>, so either spelling works.
          </p>
        </form>

        <p
          v-if="willBlock"
          class="text-[12.5px] rounded p-2.5"
          style="background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn)"
        >
          Your browser will block this. An HTTPS page cannot reach plain HTTP, except on loopback, so
          <code class="mono">http://localhost</code> works and a LAN address does not.
        </p>

        <div class="grid gap-1.5">
          <span class="ledger">Saved nodes</span>
          <button
            v-for="p in PRESETS"
            :key="p.url"
            class="text-left px-3 py-2 rounded border transition-colors"
            :style="{
              borderColor: p.url === endpoint.rpc ? 'color-mix(in srgb, var(--znn) 45%, transparent)' : 'var(--line)',
              background: p.url === endpoint.rpc ? 'color-mix(in srgb, var(--znn) 8%, transparent)' : 'transparent',
            }"
            @click="use(p.url)"
          >
            <span class="flex items-center gap-2">
              <span class="text-[13.5px]">{{ p.label }}</span>
              <Icon v-if="p.url === endpoint.rpc" name="check" :size="13" style="color: var(--znn-ink)" />
            </span>
            <span class="block mono text-[11.5px] text-dim">{{ p.url }}</span>
          </button>
        </div>

        <dl class="grid gap-1.5 text-[13px] border-t border-line pt-3">
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Status</dt>
            <dd class="flex items-center gap-1.5">
              <span class="dot" :style="{background: tone}" />
              <span v-if="endpoint.health === 'ok'">Reachable</span>
              <span v-else-if="endpoint.health === 'checking' || busy">Checking</span>
              <span v-else-if="endpoint.health === 'error'" style="color: var(--danger)">Not reachable</span>
              <span v-else>Not checked</span>
            </dd>
          </div>
          <div v-if="endpoint.chainId !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Chain</dt>
            <dd class="mono">{{ endpoint.chainId }}</dd>
          </div>
          <div v-if="endpoint.latency !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Round trip</dt>
            <dd class="mono">{{ endpoint.latency }} ms</dd>
          </div>
          <div v-if="chain.head !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Block</dt>
            <dd class="mono">{{ number(chain.head) }}</dd>
          </div>
          <div v-if="chain.head !== null" class="flex justify-between gap-3">
            <dt class="text-dim">Momentum gap</dt>
            <dd class="mono">{{ chain.interval.toFixed(1) }} s</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-dim">Pool addresses from</dt>
            <dd>{{ dex.source === 'none' ? 'nowhere yet' : dex.source }}</dd>
          </div>
        </dl>

        <p v-if="endpoint.error" class="text-[13px]" style="color: var(--danger)">
          {{ endpoint.error }}
          <span v-if="endpoint.hint" class="block text-dim mt-1">{{ endpoint.hint }}</span>
        </p>

        <div class="flex flex-wrap items-center gap-2">
          <button class="btn btn-sm" :disabled="busy" @click="retry"><Icon name="refresh" :size="13" /> Check again</button>
          <a
            v-if="endpoint.apiBase"
            class="btn btn-sm btn-quiet"
            :href="endpoint.apiBase"
            target="_blank"
            rel="noreferrer noopener"
            ><Icon name="external" :size="13" /> Open this node</a
          >
          <span class="grow" />
          <button class="btn btn-sm btn-quiet" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? 'Hide contracts' : 'Contracts' }}
          </button>
        </div>

        <div v-if="showAdvanced" class="grid gap-2 border-t border-line pt-3">
          <p class="text-[12.5px] text-dim">
            Set these only when the node does not publish its own deployment, or when you are trading against a
            router this app does not know. Blank fields fall back to the node, then to the built in table.
          </p>
          <label class="ledger" for="addr-router">Router</label>
          <input id="addr-router" v-model="router" class="input" spellcheck="false" :placeholder="dex.router ?? '0x'" />
          <label class="ledger" for="addr-factory">Factory</label>
          <input id="addr-factory" v-model="factory" class="input" spellcheck="false" :placeholder="dex.factory ?? '0x'" />
          <label class="ledger" for="addr-weth">Wrapped ZNN</label>
          <input id="addr-weth" v-model="weth" class="input" spellcheck="false" :placeholder="dex.weth ?? '0x'" />
          <div class="flex gap-2 pt-1">
            <button class="btn btn-sm btn-plasma" @click="saveAddresses">Save contracts</button>
            <button class="btn btn-sm btn-quiet" @click="clearAddresses">Clear</button>
          </div>
        </div>

        <p v-if="isLoopback(endpoint.rpc)" class="text-[12px] text-dim border-t border-line pt-3">
          Your browser talks to {{ short(endpoint.rpc, 30, 8) }} directly. Nothing is proxied, and whoever serves
          this page never sees the traffic.
        </p>
      </div>
    </Modal>
  </div>
</template>
