// A buy and a sell of a token that taxes its own transfers, through the real
// swap card in headless Chrome.
//
//   node scripts/verify-taxed.mjs <token> [rpc, default $ZVM_RPC] [http://localhost:47200/zvm-glyphswap/]
//
// BULLET, Bullet Game's token, takes 5% of every transfer into or out of its
// pair. With the router's plain swap functions a sell reverts on the pair's K
// check, and a buy quotes 5% more than arrives. This checks that the card
// quotes what actually arrives, and that a sell, approval included, lands.
// Same stand-in wallet as verify.mjs: a throwaway key the faucet funds.

import {existsSync} from 'node:fs'
import puppeteer from 'puppeteer-core'
import {createPublicClient, createWalletClient, defineChain, http, parseAbi} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const token = process.argv[2]
if (!token) throw new Error('usage: node scripts/verify-taxed.mjs <token address> [rpc] [app]')
const rpc = process.argv[3] ?? process.env.ZVM_RPC
if (!rpc) throw new Error("pass the node's JSON-RPC, or set ZVM_RPC")
const app = process.argv[4] ?? 'http://localhost:47200/zvm-glyphswap/'
const apiBase = rpc.replace(/\/rpc$/, '')

const started = Date.now()
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${msg}`)

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p))
if (!chromePath) throw new Error('no Chrome found')

const info = await (await fetch(`${apiBase}/api/info`)).json()
const chain = defineChain({
  id: info.l2.chainId,
  name: 'ZVM',
  nativeCurrency: {name: 'Zenon', symbol: 'ZNN', decimals: 18},
  rpcUrls: {default: {http: [rpc]}},
})
const client = createPublicClient({chain, transport: http(rpc)})
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function buyTaxBps() view returns (uint)',
  'function sellTaxBps() view returns (uint)',
])
const account = privateKeyToAccount(generatePrivateKey())
const signer = createWalletClient({account, chain, transport: http(rpc)})
const read = (functionName, args = []) => client.readContract({address: token, abi: erc20, functionName, args})
const [symbol, decimals, buyTax, sellTax] = await Promise.all([read('symbol'), read('decimals'), read('buyTaxBps'), read('sellTaxBps')])
log(`${symbol} at ${token}: ${Number(buyTax) / 100}% on buys, ${Number(sellTax) / 100}% on sells`)
log(`trading as ${account.address}`)

async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const res = await fetch(`${apiBase}/api/faucet`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({address: account.address}),
})
if (!res.ok) throw new Error(`faucet: ${await res.text()}`)
await until(async () => (await client.getBalance({address: account.address})) > 0n, 180_000, 'faucet ZNN')
log(`funded with ${Number(await client.getBalance({address: account.address})) / 1e18} ZNN`)

async function evmRequest(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [account.address]
    case 'eth_chainId':
      return `0x${chain.id.toString(16)}`
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
    case 'wallet_watchAsset':
      return null
    case 'eth_sendTransaction': {
      const [tx] = params
      return signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
      })
    }
    default:
      return client.request({method, params})
  }
}

const browser = await puppeteer.launch({executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu']})
const page = await browser.newPage()
await page.setViewport({width: 1360, height: 1100, deviceScaleFactor: 1})
const problems = []
page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
await page.exposeFunction('__evm', evmRequest)
await page.evaluateOnNewDocument(() => {
  const provider = {request: ({method, params}) => window.__evm(method, params ?? []), on() {}, removeListener() {}}
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({info: {uuid: 'glyphswap-verify', name: 'Test wallet', icon: '', rdns: 'test.glyphswap'}, provider}),
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
})

const visibleButton = (text, selector) =>
  [...document.querySelectorAll(selector)]
    .filter((el) => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null))
    .find((b) => b.textContent.trim().startsWith(text) && !b.disabled)

async function click(text, selector = 'button') {
  await page.waitForFunction(`(${visibleButton})(${JSON.stringify(text)}, ${JSON.stringify(selector)})`, {timeout: 30_000})
  await page.evaluate(`(${visibleButton})(${JSON.stringify(text)}, ${JSON.stringify(selector)}).click()`)
}

async function typeInto(selector, value) {
  await page.click(selector)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
}

async function press(label) {
  const primary = `(${visibleButton})(${JSON.stringify(label)}, 'button.btn-plasma')`
  await page.waitForFunction(primary, {timeout: 40_000}).catch(async () => {
    const reads = await page.evaluate(
      `[...document.querySelectorAll('button.btn-plasma')].filter((el) => el.checkVisibility()).map((b) => b.textContent.trim())`,
    )
    throw new Error(`the action never read "${label}"; the page offers ${JSON.stringify(reads)}`)
  })
  await page.evaluate(`${primary}.click()`)
}

/** Types an amount and returns the card's quote, as a number. */
async function quote(amount) {
  await typeInto('input[aria-label="Amount to pay"]', amount)
  await page.waitForFunction(() => {
    const out = document.querySelector('output.amount')
    return out && out.textContent.trim() !== '0' && out.textContent.trim() !== ''
  }, {timeout: 30_000})
  return Number((await page.$eval('output.amount', (o) => o.textContent.trim())).replace(/,/g, ''))
}

/** Fails on any step the bubble marks failed, so a revert is not mistaken for slowness. */
async function noFailedStep() {
  const failed = await page.$$eval('[data-pending-swaps] li[data-state="failed"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  if (failed.length) throw new Error(`a step failed: ${failed.join(' | ')}`)
  return true
}

const tokenBalance = () => read('balanceOf', [account.address])
const unit = 10 ** Number(decimals)
let failed = false
try {
  // Buy: ZNN in, the taxed token out.
  await page.goto(`${app}?rpc=${encodeURIComponent(rpc)}&in=znn&out=${token.toLowerCase()}`, {waitUntil: 'networkidle2', timeout: 60_000})
  await page.waitForSelector('input[aria-label="Amount to pay"]', {timeout: 60_000})
  await page.evaluate(`(${visibleButton})('Connect wallet', 'button.btn-plasma').click()`)
  await click('Test wallet')
  await page.waitForFunction(() => document.body.textContent.includes('0x'), {timeout: 20_000})
  log('wallet connected')

  const quotedBuy = await quote('1')
  log(`quoted ${quotedBuy} ${symbol} for 1 ZNN`)
  const tax = await page.evaluate(() => [...document.querySelectorAll('dt')].some((d) => d.textContent.includes("Token's own tax")))
  const before = await tokenBalance()
  await press('Swap')
  await until(async () => (await noFailedStep()) && (await tokenBalance()) > before, 400_000, `${symbol} to arrive`)
  const bought = Number((await tokenBalance()) - before) / unit
  const gap = Math.abs(bought - quotedBuy) / quotedBuy
  log(`received ${bought} ${symbol}; the quote was off by ${(gap * 100).toFixed(3)}%`)
  // Untaxed, the quote would be buyTax too high; allow the 0.5% slippage band.
  if (gap > 0.005) throw new Error(`the card quoted ${quotedBuy} and ${bought} arrived: it is not accounting for the tax`)
  log(tax ? 'the details list the token tax' : 'the details were not opened; tax row not checked')

  // Sell half of it back: an approval, then the fee-on-transfer swap.
  const sell = Math.floor((bought / 2) * 1e4) / 1e4
  await page.goto(`${app}?rpc=${encodeURIComponent(rpc)}&in=${token.toLowerCase()}&out=znn`, {waitUntil: 'networkidle2', timeout: 60_000})
  await page.waitForSelector('input[aria-label="Amount to pay"]', {timeout: 60_000})
  await page.waitForFunction(() => document.body.textContent.includes('0x'), {timeout: 20_000})
  const quotedSell = await quote(String(sell))
  log(`quoted ${quotedSell} ZNN for ${sell} ${symbol}`)
  const znnBefore = await client.getBalance({address: account.address})
  const tokBefore = await tokenBalance()
  await press('Approve')
  await until(async () => (await noFailedStep()) && (await tokenBalance()) < tokBefore, 600_000, `the ${symbol} sell to land`)
  await until(async () => (await client.getBalance({address: account.address})) > znnBefore, 60_000, 'ZNN from the sell')
  const got = Number((await client.getBalance({address: account.address})) - znnBefore) / 1e18
  log(`sold ${Number(tokBefore - (await tokenBalance())) / unit} ${symbol}; ZNN balance up ${got} after gas (quote ${quotedSell})`)
  if (got < quotedSell * 0.9) throw new Error(`the sell paid ${got} ZNN against a quote of ${quotedSell}`)
} catch (err) {
  failed = true
  console.error(`\nFAILED: ${err.message}`)
} finally {
  await browser.close()
}

if (problems.length) {
  console.error('\nBrowser problems:')
  for (const p of [...new Set(problems)]) console.error(`  ${p}`)
}
if (failed || problems.length) process.exit(1)
log('taxed buy and sell both landed, quoted after tax')
