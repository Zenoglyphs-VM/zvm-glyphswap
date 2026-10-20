<script setup lang="ts">
// The pair's price, drawn from its own trades.
//
// Hand drawn SVG rather than a charting library: the series is thinned to a
// few points per column, the only interaction is a crosshair, and a chart library
// would be the largest thing in the bundle by an order of magnitude.
//
// A step line, not a smoothed one. Price here changes when a trade executes and
// holds until the next one, so a curve between two trades would draw prices
// that never existed.
import {computed, ref} from 'vue'
import {ago, price as fmtPrice} from '../core/format'

const props = withDefaults(
  defineProps<{
    series: {time: number; price: number}[]
    quoteSymbol: string
    baseSymbol: string
    height?: number
    /** The most recent trade of any age, so an empty window can say how long it has been. */
    lastTradeAt?: number | null
    /** Set only when a scan back to genesis found no trade. See PairHistory. */
    neverTraded?: boolean
    /** Whether the trades have been read yet, or the read failed. */
    status?: 'loading' | 'ready' | 'failed'
  }>(),
  {height: 180, lastTradeAt: null, neverTraded: false, status: 'ready'},
)

const W = 640
const PAD = {top: 12, right: 8, bottom: 20, left: 8}
/** The narrowest the price axis is allowed to get, as a share of the price. */
const MIN_SPAN = 0.01

const hover = ref<number | null>(null)
const svg = ref<SVGSVGElement | null>(null)

/**
 * The series, thinned to what the chart can show.
 *
 * The fleet benchmark's pair trades tens of thousands of times a day, and a
 * path with a vertex per trade is megabytes of SVG and a pointer handler that
 * walks all of it on every move, to draw 640 columns. Each column keeps its
 * lowest, highest and last price in time order, so a spike survives thinning
 * and the line still ends where the column did.
 */
const points = computed(() => {
  const ps = props.series.filter((p) => p.time > 0 && isFinite(p.price) && p.price > 0)
  if (ps.length <= W * 2) return ps
  const t0 = ps[0].time
  const span = Math.max(1, ps[ps.length - 1].time - t0)
  const out: typeof ps = [ps[0]]
  let col = -1
  let bucket: typeof ps = []
  const flush = () => {
    if (!bucket.length) return
    let lo = bucket[0]
    let hi = bucket[0]
    for (const p of bucket) {
      if (p.price < lo.price) lo = p
      if (p.price > hi.price) hi = p
    }
    const last = bucket[bucket.length - 1]
    const keep = [...new Set([lo, hi, last])].sort((a, b) => a.time - b.time)
    out.push(...keep.filter((p) => p !== out[out.length - 1]))
  }
  for (let i = 1; i < ps.length; i++) {
    const c = Math.floor(((ps[i].time - t0) / span) * (W - 1))
    if (c !== col) {
      flush()
      bucket = []
      col = c
    }
    bucket.push(ps[i])
  }
  flush()
  return out
})

const bounds = computed(() => {
  const ps = points.value
  if (ps.length < 2) return null
  const t0 = ps[0].time
  const t1 = ps[ps.length - 1].time
  const prices = ps.map((p) => p.price)
  let lo = Math.min(...prices)
  let hi = Math.max(...prices)
  // Auto-scaling alone turns a two hundredth of a percent into a cliff that
  // fills the panel. The axis never spans less than a percent of the price, so
  // a quiet pair reads as quiet and a real move still reads as a move.
  const mid = (hi + lo) / 2
  const floor = mid * MIN_SPAN
  if (hi - lo < floor) {
    hi = mid + floor / 2
    lo = mid - floor / 2
  }
  const pad = (hi - lo) * 0.12
  return {t0, t1: t1 === t0 ? t0 + 1 : t1, lo: lo - pad, hi: hi + pad}
})

const H = computed(() => props.height)

const x = (t: number) => {
  const b = bounds.value!
  return PAD.left + ((t - b.t0) / (b.t1 - b.t0)) * (W - PAD.left - PAD.right)
}

const y = (p: number) => {
  const b = bounds.value!
  return PAD.top + (1 - (p - b.lo) / (b.hi - b.lo)) * (H.value - PAD.top - PAD.bottom)
}

const line = computed(() => {
  const ps = points.value
  if (!bounds.value || ps.length < 2) return ''
  let d = `M ${x(ps[0].time).toFixed(2)} ${y(ps[0].price).toFixed(2)}`
  for (let i = 1; i < ps.length; i++) {
    d += ` L ${x(ps[i].time).toFixed(2)} ${y(ps[i - 1].price).toFixed(2)}`
    d += ` L ${x(ps[i].time).toFixed(2)} ${y(ps[i].price).toFixed(2)}`
  }
  return d
})

const area = computed(() => {
  if (!line.value || !bounds.value) return ''
  const ps = points.value
  const floor = (H.value - PAD.bottom).toFixed(2)
  return `${line.value} L ${x(ps[ps.length - 1].time).toFixed(2)} ${floor} L ${x(ps[0].time).toFixed(2)} ${floor} Z`
})

/** Up over the window is green, down is the danger red. Never green for both. */
const rising = computed(() => {
  const ps = points.value
  return ps.length > 1 ? ps[ps.length - 1].price >= ps[0].price : true
})
const stroke = computed(() => (rising.value ? 'var(--znn-ink)' : 'var(--danger)'))

const marker = computed(() => {
  const i = hover.value
  const ps = points.value
  if (i === null || !ps[i] || !bounds.value) return null
  return {px: x(ps[i].time), py: y(ps[i].price), point: ps[i]}
})

function onMove(event: PointerEvent) {
  const el = svg.value
  const ps = points.value
  if (!el || !bounds.value || ps.length < 2) return
  const rect = el.getBoundingClientRect()
  const local = ((event.clientX - rect.left) / rect.width) * W
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < ps.length; i++) {
    const d = Math.abs(x(ps[i].time) - local)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  hover.value = best
}

const first = computed(() => points.value[0])
const last = computed(() => points.value[points.value.length - 1])
// A clock time alone is ambiguous once the chart spans a day: a 24 hour window
// read "08:37 PM" at both ends.
const withDate = computed(() => !!first.value && !!last.value && last.value.time - first.value.time > 20 * 3600)
const when = (t: number) =>
  new Date(t * 1000).toLocaleString('en-US', {
    ...(withDate.value ? {month: 'short', day: 'numeric'} : {}),
    hour: '2-digit',
    minute: '2-digit',
  })
</script>

<template>
  <div class="relative">
    <svg
      v-if="bounds"
      ref="svg"
      :viewBox="`0 0 ${W} ${H}`"
      :style="{height: `${H}px`}"
      class="w-full block touch-none"
      role="img"
      :aria-label="`${baseSymbol} priced in ${quoteSymbol}, ${series.length} points`"
      @pointermove="onMove"
      @pointerleave="hover = null"
    >
      <defs>
        <linearGradient :id="`fill-${baseSymbol}${quoteSymbol}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="stroke" stop-opacity="0.26" />
          <stop offset="100%" :stop-color="stroke" stop-opacity="0" />
        </linearGradient>
      </defs>

      <path :d="area" :fill="`url(#fill-${baseSymbol}${quoteSymbol})`" />
      <path :d="line" fill="none" :stroke="stroke" stroke-width="1.75" stroke-linejoin="round" vector-effect="non-scaling-stroke" />

      <g v-if="marker">
        <line
          :x1="marker.px"
          :y1="PAD.top"
          :x2="marker.px"
          :y2="H - PAD.bottom"
          stroke="var(--line-strong)"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />
        <circle :cx="marker.px" :cy="marker.py" r="3.5" :fill="stroke" stroke="var(--bg)" stroke-width="2" />
      </g>

      <text v-if="first" :x="PAD.left" :y="H - 6" class="axis">{{ when(first.time) }}</text>
      <text v-if="last" :x="W - PAD.right" :y="H - 6" text-anchor="end" class="axis">{{ when(last.time) }}</text>
    </svg>

    <!-- Each line claims only what the page knows. "Never traded" used to be the
         fallback for anything without a line, so a pair that traded yesterday
         said it had never traded in a one-hour window, and so did every pair
         while its trades were still being read. -->
    <p v-else class="text-[13px] text-dim px-1 py-10 text-center">
      <template v-if="status === 'loading'">Reading this pair's trades</template>
      <template v-else-if="status === 'failed'">The node did not return this pair's trades.</template>
      <template v-else-if="neverTraded">This pair has never traded. Make the first trade and the price will draw itself here.</template>
      <template v-else-if="lastTradeAt">Nothing traded in this window. The last trade was {{ ago(lastTradeAt) }}.</template>
      <template v-else>No trade in the blocks this page reads back to.</template>
    </p>

    <!-- The read-out sits in the corner rather than following the pointer, so
         it never covers the line a person is tracing. -->
    <div v-if="marker" class="absolute top-2 right-2 pop px-2.5 py-1.5 text-[12px] pointer-events-none">
      <span class="mono">{{ fmtPrice(marker.point.price) }}</span>
      <span class="text-dim"> {{ quoteSymbol }}</span>
      <span class="block text-dim">{{ when(marker.point.time) }}</span>
    </div>
  </div>
</template>

<style scoped>
.axis {
  font-family: var(--font-mono);
  font-size: 10px;
  fill: var(--dim);
}
</style>
