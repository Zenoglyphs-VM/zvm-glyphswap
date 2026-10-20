// The Syrius browser extension, for the bridge page's deposit form.
//
// Copied from zvm/web/ui/src/core/syrius.ts, the original bridge page's, which
// was ported from zenoglyphs' web/ui/src/wallet/syrius.ts (itself adapted from
// zenon-faucet's), which is where the awkward parts were learned. Kept close
// to it deliberately: the method aliases, the structured-clone round trip and
// the result-shape handling below are all workarounds for real extension
// behaviour, and rewriting them from first principles would mean
// rediscovering the same things through someone else's browser.
//
// What this page asks of the extension is narrow. The extension is a signer:
// it supplies the account, the public key, the chain position, the plasma or
// proof of work, and the signature. The caller decides the block's
// toAddress, amount, token and data.

import {reactive} from 'vue'

export interface ZenonProvider {
  version?: string
  isSyriusExtension?: boolean
  connect(): Promise<unknown>
  disconnect(): Promise<unknown>
  getAccounts(): Promise<string[]>
  getChainId(): Promise<number | string>
  getNodeUrl(): Promise<string>
  sendAccountBlock(block: unknown): Promise<SendAccountBlockResult>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

/**
 * v0.2.0 changed this from `{signedTransaction}` to `{hash, block}`, and the
 * legacy shim forwards the new shape under the old name — so it is not a
 * faithful shim for this one call, and the failure lands after the block is
 * published. All three are read, and the hash is taken from whichever arrived.
 */
export interface SendAccountBlockResult {
  hash?: string
  block?: {hash?: string}
  signedTransaction?: {hash?: string}
}

// window.zenon is declared in env.d.ts, alongside window.ethereum.

export class WalletError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'WalletError'
  }
}

/**
 * Distinct from the JSON-RPC codes on purpose: `provider()` throws this itself,
 * before any request reaches the extension, and it must survive `translate()`
 * unchanged — otherwise "no wallet found, install Syrius" gets overwritten with
 * "Syrius did not answer", which is exactly backwards for someone who does not
 * have it installed.
 */
export const WALLET_NOT_FOUND_CODE = -1

/**
 * Rejections arrive as `{code, message}` — a plain object, not an Error — so
 * they are translated into something with a stack and a readable sentence.
 */
function translate(err: unknown): WalletError {
  const raw = err as {code?: number; message?: string} | undefined
  const code = typeof raw?.code === 'number' ? raw.code : 0
  const detail = raw?.message ?? String(err)
  switch (code) {
    case 4001:
      return new WalletError(code, 'you declined the request in Syrius')
    case 4100:
      return new WalletError(code, 'Syrius is not connected to this page')
    case 4200:
      return new WalletError(code, 'this version of Syrius does not support that request')
    case 4900:
      return new WalletError(code, 'Syrius did not answer')
    default:
      return new WalletError(code, detail)
  }
}

/**
 * Presence is advisory, never required.
 *
 * The honest test of whether a wallet is there is to ask it and see whether it
 * answers, so nothing here is gated on a detection flag — the flag only decides
 * what the page *says*. Older extension builds announced themselves by
 * appending a script element, which a strict CSP silently refuses, making the
 * wallet undetectable on exactly the sites that take their own security
 * seriously.
 */
export function providerPresent(): boolean {
  return typeof window.zenon?.sendAccountBlock === 'function'
}

function provider(): ZenonProvider {
  const p = window.zenon
  if (!p) {
    throw new WalletError(
      WALLET_NOT_FOUND_CODE,
      'no Zenon wallet was found in this browser. Install the Syrius extension and reload.',
    )
  }
  return p
}

/**
 * The names a call accepts, most current first. The extension carries no
 * version the page can rely on — `version` is optional and older builds omit it
 * — so a call is resolved by asking what is actually there.
 */
const CONNECT = ['connect', 'enable'] as const

/** Resolves a provider method, bound to the provider, naming what is missing. */
function method(p: ZenonProvider, names: readonly string[]): (...args: unknown[]) => Promise<unknown> {
  const holder = p as unknown as Record<string, unknown>
  for (const name of names) {
    const fn = holder[name]
    if (typeof fn === 'function') return (fn as (...a: unknown[]) => Promise<unknown>).bind(p)
  }
  throw new WalletError(
    4200,
    `this version of Syrius has no ${names[0]}() — it offers ${callables(p)}. Update the extension.`,
  )
}

/** Every callable the provider exposes, own and inherited, for that message. */
function callables(p: ZenonProvider): string {
  const found = new Set<string>()
  const holder = p as unknown as Record<string, unknown>
  for (let o: object | null = p; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) {
      if (name === 'constructor') continue
      // A property can be an accessor that throws; one that will not answer
      // what it is is not a method worth naming.
      try {
        if (typeof holder[name] === 'function') found.add(name)
      } catch {
        continue
      }
    }
  }
  return found.size === 0 ? 'no callable methods at all' : [...found].sort().join(', ')
}

/**
 * Calls a provider method for a value the page can do without.
 *
 * The absence is thrown by `method()` *synchronously*, which is why this is a
 * wrapper and not a trailing `.catch()`: `p.getAccounts().catch(...)` never
 * reaches its own catch when `getAccounts` is not there, because the TypeError
 * lands while the argument is being built.
 */
async function ask<T>(p: ZenonProvider, names: readonly string[], whenMissing: T): Promise<T> {
  try {
    return (await method(p, names)()) as T
  } catch {
    return whenMissing
  }
}

/**
 * A Vue reactive object cannot cross `postMessage`: it is structured clone, and
 * a Proxy fails outright with "could not be cloned", naming no field. The round
 * trip happens here, at the transport boundary — the content script serialises
 * to JSON downstream anyway, so anything a round trip drops was never going to
 * reach the wallet, and this way the error names the request instead of
 * arriving in the approval window as a field quietly gone missing.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface WalletState {
  address: string | null
  chainId: number | null
  nodeUrl: string | null
}

export async function connect(): Promise<WalletState> {
  try {
    await method(provider(), CONNECT)()
  } catch (err) {
    throw err instanceof WalletError ? err : translate(err)
  }
  return readState()
}

export async function disconnect(): Promise<void> {
  try {
    await method(provider(), ['disconnect'])()
  } catch (err) {
    throw err instanceof WalletError ? err : translate(err)
  }
}

/**
 * Reads the wallet without prompting. Everything here is answered from the
 * extension's session state, which is what lets the page restore a connection
 * on load and re-read after an account switch without asking again.
 */
export async function readState(): Promise<WalletState> {
  const p = window.zenon
  if (!p) return {address: null, chainId: null, nodeUrl: null}
  const [accounts, chainId, nodeUrl] = await Promise.all([
    ask<string[]>(p, ['getAccounts'], []),
    ask<number | string | null>(p, ['getChainId'], null),
    ask<string | null>(p, ['getNodeUrl'], null),
  ])
  return {
    address: accounts?.[0] ?? null,
    chainId: chainId === null ? null : Number(chainId),
    nodeUrl: nodeUrl ?? null,
  }
}

const ZERO_HASH = '0'.repeat(64)
/** The all-zero address and ZTS, in the spellings the extension parses. */
const EMPTY_ADDRESS = 'z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f'
const ZERO_ZTS = 'zts1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

export interface WalletSendSpec {
  toAddress: string
  amount: bigint
  tokenStandard: string
  data: Uint8Array
}

/**
 * Hands a block to the extension to complete, sign and publish.
 *
 * The template carries every field with a zero value rather than being partial:
 * the extension's `AccountBlockTemplate.fromJson` runs `Hash.parse`,
 * `Address.parse` and `TokenStandard.parse` over whatever is there, so a
 * missing field is a parse error inside the wallet rather than a default.
 *
 * Note what is *not* set: fusedPlasma, difficulty and nonce are left at zero
 * for the extension to fill. Under dynamic plasma the price moves per momentum,
 * so a page that computed its own plasma would be computing it against a price
 * that may have changed by the time the user approves — the wallet asks the
 * node at signing time, which is the only moment the answer is current.
 */
export async function sendAccountBlock(spec: WalletSendSpec, chainId: number): Promise<string> {
  const template = {
    version: 1,
    chainIdentifier: chainId,
    blockType: 2, // user send
    hash: ZERO_HASH,
    previousHash: ZERO_HASH,
    height: 0,
    momentumAcknowledged: {hash: ZERO_HASH, height: 0},
    address: EMPTY_ADDRESS,
    toAddress: spec.toAddress,
    amount: spec.amount.toString(),
    tokenStandard: spec.tokenStandard || ZERO_ZTS,
    fromBlockHash: ZERO_HASH,
    descendantBlocks: [],
    data: toBase64(spec.data),
    fusedPlasma: 0,
    difficulty: 0,
    nonce: '',
    basePlasma: 0,
    usedPlasma: 0,
    changesHash: ZERO_HASH,
    publicKey: '',
    signature: '',
  }

  let result: SendAccountBlockResult
  try {
    result = (await method(provider(), ['sendAccountBlock'])(plain(template))) as SendAccountBlockResult
  } catch (err) {
    throw err instanceof WalletError ? err : translate(err)
  }

  const hash = result?.hash ?? result?.block?.hash ?? result?.signedTransaction?.hash
  if (!hash) {
    throw new WalletError(-32603, 'Syrius published the block but reported no hash for it')
  }
  return hash
}

function toBase64(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return btoa(s)
}

/** The extension announces these; the page discards prepared work on each. */
export function onWalletChange(handler: () => void): () => void {
  const events = ['accountsChanged', 'chainChanged', 'nodeChanged', 'disconnect']
  const p = window.zenon
  if (!p?.on) return () => {}
  for (const event of events) p.on(event, handler)
  return () => {
    for (const event of events) p.removeListener?.(event, handler)
  }
}

// --- the page's view of it -------------------------------------------------
//
// One store, so the deposit form and the withdraw form's "fill in my Zenon
// address" read the same connection, and the listeners are attached once.

export const zenon = reactive({
  present: false,
  address: null as string | null,
  chainId: null as number | null,
  connecting: false,
  error: '',
})

function apply(s: WalletState) {
  zenon.address = s.address
  zenon.chainId = s.chainId
}

export async function connectZenon() {
  zenon.error = ''
  zenon.connecting = true
  try {
    apply(await connect())
    zenon.present = true
  } catch (err: any) {
    zenon.error = err?.message ?? String(err)
    zenon.present = providerPresent()
  } finally {
    zenon.connecting = false
  }
}

let watching = false

/** Reads a connection the extension already granted this origin, without a prompt. */
export async function watchZenon() {
  zenon.present = providerPresent()
  if (!zenon.present || watching) return
  watching = true
  apply(await readState())
  onWalletChange(() => void readState().then(apply))
}
