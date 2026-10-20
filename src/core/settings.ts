// Trading preferences. Small, persisted, and shared by every form that sends a
// transaction, so slippage set on the swap card also governs a deposit.

import {reactive, watch} from 'vue'

const KEY = 'glyphswap.settings'

export interface Settings {
  /** Basis points. 50 is half a percent, which is Uniswap's own default. */
  slippageBps: number
  /** Minutes before the router refuses the trade. */
  deadlineMin: number
  /**
   * Allows a trade whose price impact is above the refusal line, and skips the
   * confirmation that normally stands in front of it. Off by default, and
   * announced in plain words rather than as "expert mode".
   */
  allowHighImpact: boolean
  /**
   * Approve exactly what the trade needs, rather than an unlimited allowance.
   * On costs a second transaction each time; off leaves the router able to
   * move that token until the approval is revoked.
   */
  exactApproval: boolean
}

const DEFAULTS: Settings = {slippageBps: 50, deadlineMin: 20, allowHighImpact: false, exactApproval: true}

function load(): Settings {
  try {
    return {...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}')}
  } catch {
    return {...DEFAULTS}
  }
}

export const settings = reactive<Settings>(load())

watch(
  settings,
  (s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {
      /* storage can be blocked; the settings still hold for this tab */
    }
  },
  {deep: true},
)

export function resetSettings() {
  Object.assign(settings, DEFAULTS)
}

/** Above this, a trade is refused unless the person has said to allow it. */
export const HIGH_IMPACT = 0.05
/** Above this, the trade is shown as expensive but still goes through. */
export const WARN_IMPACT = 0.01
