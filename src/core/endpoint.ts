// Which ZVM node this interface trades against.
//
// There is no backend here: this is a static bundle, so the node is a setting.
// Everything the app reads comes from one JSON-RPC endpoint, which means a
// plain op-reth URL works as well as a zvm node's `/rpc`. When the endpoint is
// a zvm node, its sibling `/api/info` is asked once for the deployment
// addresses, which saves the person pasting a router address.
//
// The zvm node answers with `Access-Control-Allow-Origin: *`
// (internal/api/api.go), so a cross-origin read needs nothing from whoever
// runs it.

import {reactive, computed} from 'vue'

import {isLoopback, mixedContentBlocked} from '@zvm/web/url'

// Both shared with the explorer: what a browser treats as trustworthy, and what
// it refuses before the request is made, are facts about browsers.
export {isLoopback, mixedContentBlocked}

const KEY = 'glyphswap.rpc'

export interface Preset {
  label: string
  url: string
  note: string
}

// The node this build reads, and any others its picker offers, come from the
// environment (see .env.example), so no node is written into the source.
// VITE_ZVM_NODE is a ZVM node's base URL, its JSON-RPC at /rpc; a local
// zvm-devnet's is http://localhost:47080/zvm. VITE_ZVM_PRESETS
// adds more to the picker, as comma-separated `label=url` pairs.
const NODE = (import.meta.env.VITE_ZVM_NODE as string).replace(/\/+$/, '')

export const DEFAULT_RPC = `${NODE}/rpc`

/** Somewhere to start. Any of them can be replaced with a pasted URL. */
export const PRESETS: Preset[] = [
  {label: 'This build\'s node', url: DEFAULT_RPC, note: new URL(DEFAULT_RPC).host},
  ...((import.meta.env.VITE_ZVM_PRESETS as string | undefined) ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=')
      const url = i < 0 ? p : p.slice(i + 1).trim()
      return {label: i < 0 ? url : p.slice(0, i).trim(), url, note: url}
    }),
]

export type Health = 'idle' | 'checking' | 'ok' | 'error'

export interface EndpointState {
  /** The RPC the app talks to. Resolved, so it is what actually answered. */
  rpc: string
  health: Health
  /** What went wrong, written for the person who has to fix it. */
  error: string | null
  /** A second line naming the fix, when there is a specific one. */
  hint: string | null
  /** Round trip to eth_chainId, in ms. */
  latency: number | null
  chainId: number | null
  /** The node's own pages, when the RPC looks like a zvm node. Used for links. */
  apiBase: string | null
}

export const endpoint = reactive<EndpointState>({
  rpc: initial(),
  health: 'idle',
  error: null,
  hint: null,
  latency: null,
  chainId: null,
  apiBase: null,
})

/** Accepts what people paste: a bare host, a host:port, or a full RPC URL. */
export function normalize(input: string): string {
  let s = input.trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return ''
  }
}

function initial(): string {
  // A link can carry the node, so a pair can be shared: ?rpc=http://host:49000
  try {
    const q = new URLSearchParams(location.search)
    const fromQuery = q.get('rpc') ?? q.get('node') ?? q.get('endpoint')
    if (fromQuery) {
      const url = normalize(fromQuery)
      if (url) {
        save(url)
        return url
      }
    }
  } catch {
    /* no query, or no location */
  }
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return saved
  } catch {
    /* storage can be blocked */
  }
  return DEFAULT_RPC
}

function save(url: string) {
  try {
    localStorage.setItem(KEY, url)
  } catch {
    /* storage can be blocked; the endpoint still works for this tab */
  }
}

export const rpcUrl = () => endpoint.rpc

/** Points the app at a different node and re-checks it. */
export async function setEndpoint(input: string): Promise<boolean> {
  const url = normalize(input)
  if (!url) {
    endpoint.error = 'That is not a URL.'
    endpoint.hint = `Try ${DEFAULT_RPC}`
    endpoint.health = 'error'
    return false
  }
  endpoint.rpc = url
  save(url)
  return check()
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`${status} ${statusText}`)
  }
}

async function chainIdOf(url: string, timeoutMs: number): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: []}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new HttpError(res.status, res.statusText)
  const body = await res.json()
  const id = Number(body?.result)
  if (!Number.isFinite(id) || id <= 0) throw new Error('not an EVM RPC')
  return id
}

let checking: Promise<boolean> | null = null

/** Asks the node for its chain id, and classifies the failure when it does not answer. */
export function check(): Promise<boolean> {
  if (checking) return checking
  checking = run().finally(() => {
    checking = null
  })
  return checking
}

async function run(): Promise<boolean> {
  const url = endpoint.rpc
  endpoint.health = 'checking'
  endpoint.error = null
  endpoint.hint = null

  if (mixedContentBlocked(url)) {
    fail(
      `This page is served over HTTPS and cannot reach ${hostOf(url)} over plain HTTP.`,
      'Use an HTTPS address, or http://localhost, which browsers allow from an HTTPS page.',
    )
    return false
  }

  // A zvm node serves its RPC at /rpc; op-reth and most other nodes serve it at
  // the root. Someone who pasted a host and no path meant one of the two, so
  // try both rather than making them guess which.
  const bare = new URL(url).pathname.replace(/\/+$/, '') === ''
  const candidates = bare ? [url, `${url}/rpc`] : [url]
  const started = performance.now()
  let last: unknown = null
  for (const candidate of candidates) {
    try {
      const chainId = await chainIdOf(candidate, 8000)
      endpoint.rpc = candidate
      save(candidate)
      endpoint.chainId = chainId
      endpoint.latency = Math.round(performance.now() - started)
      endpoint.apiBase = /\/rpc$/.test(candidate) ? candidate.replace(/\/rpc$/, '') : null
      endpoint.health = 'ok'
      endpoint.error = null
      endpoint.hint = null
      return true
    } catch (err) {
      last = err
    }
  }
  describe(last, url)
  return false
}

function describe(err: any, url: string) {
  if (err?.name === 'TimeoutError') {
    fail(`${hostOf(url)} did not answer within 8 seconds.`, 'The node may be starting up, or the port may be firewalled.')
    return
  }
  if (err instanceof HttpError) {
    fail(`${hostOf(url)} answered ${err.status} ${err.statusText}.`, 'Check the path. A ZVM node serves JSON-RPC at /rpc on its explorer port.')
    return
  }
  if (err?.message === 'not an EVM RPC') {
    fail(`${hostOf(url)} answered, but not like an EVM node.`, 'Point this at the ZVM RPC rather than the NoM RPC.')
    return
  }
  // A cross-origin failure is opaque by design: the browser will not say
  // whether it was DNS, a refused connection, CORS, or Chrome's local network
  // check. Naming the likely causes beats repeating "failed to fetch".
  fail(
    `Could not reach ${hostOf(url)}.`,
    isLoopback(url)
      ? 'Start the node, or check the port. If it is running, your browser may be asking you to allow access to local network devices.'
      : 'Check the node is running and reachable, and that it allows requests from this page.',
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function fail(error: string, hint: string | null) {
  endpoint.health = 'error'
  endpoint.error = error
  endpoint.hint = hint
  endpoint.latency = null
  endpoint.chainId = null
  endpoint.apiBase = null
}

export const reachable = computed(() => endpoint.health === 'ok')
