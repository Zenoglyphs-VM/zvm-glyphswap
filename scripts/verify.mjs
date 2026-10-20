// Drives the real pages against a running ZVM node, in headless Chrome.
//
//   node scripts/verify.mjs [rpc, default $ZVM_RPC] [http://localhost:47200/zvm-glyphswap/]
//
// A stand-in EIP-6963 wallet signs with a throwaway key the node's faucet
// funds, exactly as MetaMask would. Nothing under the wallet is mocked: Zenon
// orders the transaction, the deriver derives it, op-reth runs it. Set
// GLYPHSWAP_SHOTS to a directory to keep screenshots. GLYPHSWAP_OTHER_RPC is a
// node of a second ZVM chain, which the node-switch check moves the page to.

import {existsSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createPublicClient, createWalletClient, defineChain, http, parseAbi} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const rpc = process.argv[2] ?? process.env.ZVM_RPC
if (!rpc) throw new Error("pass the node's JSON-RPC, or set ZVM_RPC")
const app = process.argv[3] ?? 'http://localhost:47200/zvm-glyphswap/'
const apiBase = rpc.replace(/\/rpc$/, '')
const shots = process.env.GLYPHSWAP_SHOTS
if (shots) mkdirSync(shots, {recursive: true})

const started = Date.now()
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${msg}`)
const E18 = 10n ** 18n

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
const erc20 = parseAbi(['function balanceOf(address) view returns (uint)', 'function decimals() view returns (uint8)'])
const QSR = '0x4200000000000000000000000000000000000101'

const account = privateKeyToAccount(generatePrivateKey())
const signer = createWalletClient({account, chain, transport: http(rpc)})
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

// --- the stand-in wallet ----------------------------------------------------

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

const shot = async (name) => shots && page.screenshot({path: join(shots, `${name}.png`), fullPage: true})

// A closed <dialog> keeps its buttons in the DOM, so every lookup here is
// scoped to what a person could actually see and press.
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

/** Presses the primary action, without waiting for what it starts. */
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

/** Waits for every step under `scope` to settle, and fails if any did not
 *  execute. Swaps report in the bubble, liquidity in its own form. */
async function settle(label, scope, count = 1) {
  const sel = `${scope} li[data-state]`
  await page.waitForFunction(
    (sel, count) => {
      const s = [...document.querySelectorAll(sel)]
      return s.length >= count && s.every((li) => li.dataset.state === 'done' || li.dataset.state === 'failed')
    },
    {timeout: 400_000, polling: 1000},
    sel,
    count,
  )
  const steps = await page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].map((li) => ({
        state: li.dataset.state,
        text: li.textContent.replace(/\s+/g, ' ').trim(),
      })),
    sel,
  )
  for (const s of steps) log(`   ${s.state === 'done' ? 'ok  ' : 'FAIL'} ${s.text}`)
  if (steps.some((s) => s.state !== 'done')) throw new Error(`${label}: a step failed`)
}

/** Presses the primary action and waits for every step to settle. */
async function act(label, scope = 'main') {
  await press(label)
  await settle(label, scope)
}

const qsrBalance = () => client.readContract({address: QSR, abi: erc20, functionName: 'balanceOf', args: [account.address]})

let failed = false
try {
  await page.goto(`${app}?rpc=${encodeURIComponent(rpc)}`, {waitUntil: 'networkidle2', timeout: 60_000})
  await page.waitForSelector('input[aria-label="Amount to pay"]', {timeout: 60_000})
  log('swap page loaded')

  // The pair opens on ZNN and QSR without anyone choosing it. Dialogs are in
  // the DOM while closed, so only headings that are actually visible count.
  const headings = await page.$$eval('h2', (els) =>
    els.filter((e) => e.checkVisibility?.() ?? e.offsetParent !== null).map((e) => e.textContent.trim()),
  )
  if (!headings.includes('ZNN and QSR')) throw new Error(`the page opened on ${JSON.stringify(headings)} rather than ZNN and QSR`)
  log('opens on ZNN and QSR')
  await shot('01-swap-disconnected')

  // A button that names an action has to perform it. The card's own "Connect
  // wallet" was dead once, which no page load would have caught.
  await page.evaluate(`(${visibleButton})('Connect wallet', 'button.btn-plasma').click()`)
  await page.waitForFunction(`!!document.querySelector('dialog[open]')`, {timeout: 10_000}).catch(() => {
    throw new Error('the swap card Connect wallet button did not open the wallet list')
  })
  await click('Test wallet')
  await page.waitForFunction(() => document.body.textContent.includes('0x'), {timeout: 20_000})
  log('wallet connected')

  // The token list puts the chain's own three at the top, in their own order,
  // and ticks them. The tick is matched on the address, so this also fails if
  // it ever starts trusting a symbol.
  await page.evaluate(`(${visibleButton})('', '.pill').click()`)
  await page.waitForSelector('dialog[open]', {timeout: 10_000})
  const tokens = await page.evaluate(() => {
    const dlg = document.querySelector('dialog[open]')
    return [...dlg.querySelectorAll('button')]
      .filter((b) => b.querySelector('span > span'))
      .map((b) => ({
        symbol: b.querySelector('span > span').textContent.trim().split(String.fromCharCode(10))[0].trim(),
        tick: !!b.querySelector('[title="Verified"]'),
      }))
  })
  // QSR is on the other side of the trade, so the list leaves it out here.
  const wanted = ['ZNN', 'WZNN']
  const got = tokens.slice(0, 2).map((t) => t.symbol)
  if (String(got) !== String(wanted)) throw new Error(`the token list starts ${JSON.stringify(got)}, not ${JSON.stringify(wanted)}`)
  const untickedOwn = tokens.filter((t) => wanted.includes(t.symbol) && !t.tick)
  const tickedOther = tokens.filter((t) => !wanted.includes(t.symbol) && t.tick)
  if (untickedOwn.length) throw new Error(`no tick on ${JSON.stringify(untickedOwn.map((t) => t.symbol))}`)
  if (tickedOther.length) throw new Error(`a tick on ${JSON.stringify(tickedOther.map((t) => t.symbol))}, which the chain does not ship`)
  log(`token list: ${tokens.map((t) => t.symbol + (t.tick ? ' [verified]' : '')).join(', ')}`)
  await page.keyboard.press('Escape')
  await page.waitForFunction(`!document.querySelector('dialog[open]')`, {timeout: 10_000})

  const before = await qsrBalance()
  await typeInto('input[aria-label="Amount to pay"]', '0.5')
  await page.waitForFunction(() => {
    const out = document.querySelector('output.amount')
    return out && out.textContent.trim() !== '0' && out.textContent.trim() !== ''
  }, {timeout: 30_000})
  const quoted = await page.$eval('output.amount', (o) => o.textContent.trim())
  log(`quoted ${quoted} QSR for 0.5 ZNN`)
  await shot('02-swap-quoted')

  // A pending swap must not hold the card. The first one is pressed and not
  // waited for; the card has to clear and offer itself again while that swap
  // is still in flight, and take a second one on top of it.
  const bubble = '[data-pending-swaps]'
  await press('Swap')
  await page.waitForFunction(
    (bubble) =>
      document.querySelector('input[aria-label="Amount to pay"]').value === '' &&
      document.querySelector(`${bubble} li[data-status="running"]`),
    {timeout: 30_000},
    bubble,
  ).catch(() => {
    throw new Error('the card did not clear with the first swap shown as in flight')
  })
  await typeInto('input[aria-label="Amount to pay"]', '0.3')
  await page.waitForFunction(() => {
    const out = document.querySelector('output.amount')
    return out && out.textContent.trim() !== '0' && out.textContent.trim() !== ''
  }, {timeout: 30_000})
  const firstStillRunning = await page.$(`${bubble} li[data-status="running"]`)
  if (!firstStillRunning) throw new Error('the first swap settled before the second could be offered; the check proved nothing')
  await press('Swap')
  log('second swap submitted while the first was in flight')
  await page.waitForFunction((bubble) => document.querySelectorAll(`${bubble} li[data-status]`).length === 2, {timeout: 30_000}, bubble)
  await shot('03a-swap-two-in-flight')
  await settle('Swap', bubble, 2)
  const after = await qsrBalance()
  if (after <= before) throw new Error(`QSR balance did not move: ${before} to ${after}`)
  log(`QSR received over two swaps: ${Number(after - before) / 1e8}`)
  await shot('03b-swap-done')

  // The pages that read but do not write.
  for (const [path, name, wait] of [
    ['explore', '04-explore', 'table'],
    ['pool', '05-pool', 'h1'],
    ['pool/new', '06-pool-new', 'input[aria-label="First amount"]'],
    ['about', '07-about', 'h1'],
  ]) {
    await page.goto(`${app}${path}`, {waitUntil: 'networkidle2', timeout: 60_000})
    await page.waitForSelector(wait, {timeout: 30_000})
    await shot(name)
    log(`${path} rendered`)
    // CSS layers are easy to get wrong in a way nothing else notices: an
    // unlayered `a { color: inherit }` silently beat `.link` once already.
    const linkColour = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a.link')].find((el) => el.checkVisibility())
      return a ? getComputedStyle(a).color : null
    })
    if (linkColour && !/^rgb\(9[0-9], 16[0-9], 25[0-9]\)$/.test(linkColour) && !/^rgb\(0, 82, 201\)$/.test(linkColour)) {
      throw new Error(`a link on /${path} renders ${linkColour} rather than the link colour`)
    }
  }

  // The pool the swap just traded through.
  await page.goto(`${app}explore`, {waitUntil: 'networkidle2', timeout: 60_000})
  const poolHref = await page.$eval('a[href*="/pool/0x"]', (a) => a.getAttribute('href'))
  await page.goto(new URL(poolHref, app).toString(), {waitUntil: 'networkidle2', timeout: 60_000})
  await page.waitForSelector('h2', {timeout: 30_000})
  await shot('08-pool-detail')
  log(`pool page rendered: ${poolHref}`)

  // Depositing into the official pool, for real. A pool holds wrapped ZNN and
  // almost nobody has any, so the form has to offer the native side; this fails
  // if it ever goes back to asking for WZNN, because the balance would be zero.
  // The official pair specifically, not whichever pool the explore table listed
  // first: this is the one with ZNN on a side, which is the case that broke.
  const pairAddress = info.apps?.znnQsrPair
  if (!pairAddress) throw new Error('this node publishes no ZNN and QSR pair to deposit into')
  await page.goto(`${app}pool/${pairAddress}`, {waitUntil: 'networkidle2', timeout: 60_000})
  const lpAbi = parseAbi(['function balanceOf(address) view returns (uint)'])
  const lpBefore = await client.readContract({address: pairAddress, abi: lpAbi, functionName: 'balanceOf', args: [account.address]})
  await page.waitForSelector('input[aria-label="First amount"]', {timeout: 30_000})
  const labels = await page.evaluate(() => [...document.querySelectorAll('.field .ledger')].map((e) => e.textContent.trim()))
  if (!labels.includes('Deposit ZNN')) throw new Error(`the deposit form asks for ${JSON.stringify(labels)}, not ZNN`)
  const znnField = labels.indexOf('Deposit ZNN') === 0 ? 'First amount' : 'Second amount'
  await typeInto(`input[aria-label="${znnField}"]`, '0.2')
  await page.waitForFunction(
    (other) => {
      const el = document.querySelector(`input[aria-label="${other}"]`)
      return el && el.value && el.value !== '0'
    },
    {timeout: 20_000},
    znnField === 'First amount' ? 'Second amount' : 'First amount',
  )
  await act('Add liquidity')
  const lpAfter = await client.readContract({address: pairAddress, abi: lpAbi, functionName: 'balanceOf', args: [account.address]})
  if (lpAfter <= lpBefore) throw new Error(`the deposit minted nothing: ${lpBefore} to ${lpAfter}`)
  log(`deposited, pool tokens ${Number(lpAfter - lpBefore) / 1e18}`)
  await shot('09-deposited')

  // The pair is named for what people call it, not for the contract a pool
  // holds. WZNN belongs in the token list and on a pill you can change, and
  // nowhere else.
  const named = await page.evaluate(() => ({
    heading: [...document.querySelectorAll('h2')].filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()),
    captions: [...document.querySelectorAll('.ledger')].filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()),
    columns: [...document.querySelectorAll('.th')].filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()),
  }))
  const namedWznn = [...named.heading, ...named.captions, ...named.columns].filter((t) => /WZNN/.test(t))
  if (namedWznn.length) throw new Error(`a pool side is still called WZNN: ${JSON.stringify(namedWznn)}`)
  log(`pool page names the pair ${JSON.stringify(named.heading[0])}`)

  // All time, which reaches past whatever the timed windows cover.
  const captionBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.ledger')].map((e) => e.textContent.trim()).find((t) => t.startsWith('Trades,')),
  )
  await click('All')
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.ledger')].some((e) => e.textContent.trim() === 'Trades, all time'),
    {timeout: 60_000},
  ).catch(() => {
    throw new Error('the All window never took effect')
  })
  const allTrades = await page.evaluate(() => {
    const dt = [...document.querySelectorAll('.ledger')].find((e) => e.textContent.trim() === 'Trades, all time')
    return dt?.parentElement.querySelector('dd')?.textContent.trim()
  })
  log(`window captions went from ${JSON.stringify(captionBefore)} to "Trades, all time" (${allTrades} trades)`)
  await shot('10-all-time')

  // The footer is one line now, with no eyebrow labels in it.
  const footer = await page.evaluate(() => {
    const f = document.querySelector('footer')
    return {
      text: f.innerText.replace(/\s+/g, ' ').trim(),
      labels: f.querySelectorAll('.ledger').length,
      rows: f.innerText.trim().split(/\n+/).length,
    }
  })
  if (footer.labels) throw new Error(`the footer still carries ${footer.labels} eyebrow labels`)
  log(`footer: ${JSON.stringify(footer.text)}`)

  // Switching nodes is the headline setting, so it is driven rather than
  // trusted: a second node serves a different chain, and its pools must replace
  // the first one's rather than sit alongside them.
  const other = process.env.GLYPHSWAP_OTHER_RPC
  if (!other) throw new Error('set GLYPHSWAP_OTHER_RPC to a node of another ZVM chain')
  await page.goto(app, {waitUntil: 'networkidle2', timeout: 60_000})
  await page.waitForSelector('input[aria-label="Amount to pay"]', {timeout: 30_000})
  await click('', 'button[title^="http"]')
  await page.waitForSelector('#rpc-url', {timeout: 10_000})
  await page.evaluate((v) => {
    const el = document.querySelector('#rpc-url')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', {bubbles: true}))
  }, other)
  await click('Use')
  await page.waitForFunction(
    (want) => document.body.textContent.includes(want),
    {timeout: 60_000},
    'ZVM devnet',
  ).catch(() => {
    throw new Error(`the app never said it was on the other node (${other})`)
  })
  const stillOpen = await page.evaluate(`!!document.querySelector('dialog[open]')`)
  if (stillOpen) throw new Error('the node dialog stayed open after a node that answered')
  await shot('11-other-node')
  log(`switched to ${other}`)

  // The light theme is part of the design system, so it has to render too.
  await page.evaluate(() => document.querySelector('button[title*="light theme"]')?.click())
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', {timeout: 5000})
  await shot('11-light')
  log('light theme rendered')
  await page.evaluate(() => document.querySelector('button[title*="dark theme"]')?.click())

  // Narrow, to catch a layout that only works on a desktop.
  await page.setViewport({width: 400, height: 900})
  await page.goto(`${app}?rpc=${encodeURIComponent(rpc)}`, {waitUntil: 'networkidle2', timeout: 60_000})
  await page.waitForSelector('input[aria-label="Amount to pay"]', {timeout: 30_000})
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  if (overflow) throw new Error('the page scrolls sideways at 400px wide')
  await shot('12-narrow')
  log('narrow layout has no sideways scroll')
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
log('all checks passed')
