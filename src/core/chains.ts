// Where the Uniswap V2 deployment lives on each chain this interface knows.
//
// Two sources, in order of trust:
//
//   1. What the person typed into Settings, kept per chain id.
//   2. The node's own `/api/info`, when the RPC is a zvm node. This is the one
//      that keeps working after a devnet is re-genesised, because the node
//      reads its deployment file on every request.
//
// No deployment is written down here: every devnet deploys its own, and an
// address that is right on one is a stranger's contract, or nothing, on the
// next. A bare op-reth URL with no node in front of it needs Settings.

import type {Address} from 'viem'

export interface Deployment {
  factory: Address
  router: Address
  /** WETH9, which on the ZVM wraps ZNN. */
  weth: Address
  /** The pair this interface opens on. */
  officialPair?: Address
  /** Extra tokens to show even before a pool exists for them. */
  tokens?: Address[]
}

export interface KnownChain {
  name: string
  deployment?: Deployment
}

/** Multicall3, at its canonical address on every chain that has it. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address

/** Wrapped QSR is a predeploy, so it is the same address on every ZVM chain. */
export const WQSR = '0x4200000000000000000000000000000000000101' as Address

export const CHAINS: Record<number, KnownChain> = {
  7340469: {name: 'ZVM devnet'},
}

export function chainName(chainId: number | null): string {
  if (chainId === null) return 'Unknown chain'
  return CHAINS[chainId]?.name ?? `Chain ${chainId}`
}

// --- overrides the person set themselves ------------------------------------

const KEY = 'glyphswap.deployment'

type Overrides = Record<string, Partial<Deployment>>

function read(): Overrides {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function overrideFor(chainId: number): Partial<Deployment> | null {
  return read()[String(chainId)] ?? null
}

export function setOverride(chainId: number, value: Partial<Deployment> | null) {
  const all = read()
  if (value) all[String(chainId)] = value
  else delete all[String(chainId)]
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage can be blocked; the override still applies for this tab */
  }
}
