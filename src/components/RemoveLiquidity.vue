<script setup lang="ts">
// Withdrawing from a pool.
//
// A share, not an amount: nobody thinks in LP tokens, and the two payouts are
// shown in the tokens they will actually arrive as. A pool with wrapped ZNN on
// one side pays that side out as ZNN unless you ask for the wrapped form.
import {computed, ref} from 'vue'
import {dex, refreshPools, tokenByAddress} from '../core/dex'
import {endpoint} from '../core/endpoint'
import {publicClient} from '../core/evm'
import {askToConnect, wallet, wrongChain} from '../core/wallet'
import {settings} from '../core/settings'
import {runCalls, type Step} from '../core/tx'
import {units} from '../core/format'
import {afterTax, approvePairCall, burnAmounts, deadlineIn, hasTax, MAX_UINT, pairAbi, removeLiquidityCall, same, type Call, type Pool} from '../core/uniswap'
import StepRail from './StepRail.vue'
import TokenLogo from './TokenLogo.vue'

const props = defineProps<{pool: Pool; balance: bigint}>()

const pct = ref(50)
const busy = ref(false)
const error = ref('')
const steps = ref<Step[]>([])
const asNative = ref(true)

const token0 = computed(() => tokenByAddress(props.pool.token0))
const token1 = computed(() => tokenByAddress(props.pool.token1))
const hasWznn = computed(() => !!dex.weth && (same(props.pool.token0, dex.weth) || same(props.pool.token1, dex.weth)))

const liquidity = computed(() => (props.balance * BigInt(pct.value)) / 100n)
// A taxed token pays its buy tax on the way out of the pair.
const payout = computed(() => {
  const [a, b] = burnAmounts(props.pool, liquidity.value)
  const t0 = token0.value?.tax, t1 = token1.value?.tax
  return [t0 ? afterTax(a, t0.buyBps) : a, t1 ? afterTax(b, t1.buyBps) : b] as [bigint, bigint]
})

const label0 = computed(() => (asNative.value && dex.weth && same(props.pool.token0, dex.weth) ? 'ZNN' : token0.value?.symbol ?? ''))
const label1 = computed(() => (asNative.value && dex.weth && same(props.pool.token1, dex.weth) ? 'ZNN' : token1.value?.symbol ?? ''))

const action = computed(() => {
  if (!wallet.address) return {label: 'Connect wallet', ok: false, connect: true}
  if (wrongChain.value) return {label: 'Switch your wallet to this chain', ok: false}
  if (props.balance === 0n) return {label: 'You have nothing in this pool', ok: false}
  if (liquidity.value === 0n) return {label: 'Choose how much to withdraw', ok: false}
  if (busy.value) return {label: 'Working', ok: false}
  return {label: `Withdraw ${pct.value}%`, ok: true}
})

async function submit() {
  error.value = ''
  steps.value = []
  const owner = wallet.address
  if (!owner || !dex.router || !dex.weth || endpoint.chainId === null) return
  busy.value = true
  try {
    const client = publicClient(endpoint.chainId)
    const calls: Call[] = []
    const current = (await client
      .readContract({address: props.pool.pair, abi: pairAbi, functionName: 'allowance', args: [owner, dex.router]})
      .catch(() => 0n)) as bigint
    if (current < liquidity.value) {
      calls.push(
        approvePairCall(
          props.pool.pair,
          dex.router,
          settings.exactApproval ? liquidity.value : MAX_UINT,
          'Approve the pool token',
        ),
      )
    }
    calls.push(
      removeLiquidityCall(
        dex.router,
        dex.weth,
        props.pool,
        `Withdraw from ${label0.value} and ${label1.value}`,
        liquidity.value,
        settings.slippageBps,
        owner,
        deadlineIn(settings.deadlineMin),
        asNative.value,
        hasTax(token0.value) || hasTax(token1.value),
      ),
    )
    await runCalls(calls, (s) => (steps.value = s))
    await refreshPools()
  } catch (err: any) {
    error.value = err?.shortMessage ?? err?.message ?? String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="p-4 grid gap-4">
    <div class="grid gap-2">
      <div class="flex items-baseline justify-between gap-3">
        <span class="ledger">How much to withdraw</span>
        <span class="num text-[26px] leading-none">{{ pct }}%</span>
      </div>
      <input
        v-model.number="pct"
        type="range"
        min="1"
        max="100"
        step="1"
        class="w-full accent-[var(--znn)]"
        aria-label="Percent of your position to withdraw"
      />
      <div class="flex gap-1.5">
        <button v-for="p in [25, 50, 75, 100]" :key="p" class="btn btn-sm grow" :style="pct === p ? 'background: var(--raised); border-color: var(--dim)' : ''" @click="pct = p">
          {{ p }}%
        </button>
      </div>
    </div>

    <dl class="grid gap-2 rounded p-3 text-[13px]" style="background: var(--sunk)">
      <div class="flex items-center justify-between gap-3">
        <dt class="flex items-center gap-2 text-dim">
          <TokenLogo v-if="token0" :symbol="label0" :address="token0.address" :size="20" />
          {{ label0 }}
        </dt>
        <dd class="mono">{{ units(payout[0], token0?.decimals ?? 18, 6) }}</dd>
      </div>
      <div class="flex items-center justify-between gap-3">
        <dt class="flex items-center gap-2 text-dim">
          <TokenLogo v-if="token1" :symbol="label1" :address="token1.address" :size="20" />
          {{ label1 }}
        </dt>
        <dd class="mono">{{ units(payout[1], token1?.decimals ?? 18, 6) }}</dd>
      </div>
    </dl>

    <label v-if="hasWznn" class="flex items-center gap-2.5 text-[13px] cursor-pointer">
      <input v-model="asNative" type="checkbox" class="accent-[var(--znn)]" />
      Receive ZNN rather than wrapped ZNN
    </label>

    <button
      class="btn justify-center py-3 text-[15px]"
      :class="action.ok || action.connect ? 'btn-plasma' : ''"
      :disabled="!action.ok && !action.connect"
      @click="action.connect ? askToConnect() : submit()"
    >
      {{ action.label }}
    </button>

    <p v-if="error" class="text-[13px] break-words" style="color: var(--danger)">{{ error }}</p>
    <StepRail :steps="steps" />
  </div>
</template>
