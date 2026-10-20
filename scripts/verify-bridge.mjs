// Drives the bridge page both ways against a running ZVM node, in headless Chrome.
//
//   node scripts/verify-bridge.mjs [rpc] [app] [rollup config]
//
// rpc defaults to $ZVM_RPC, and the rollup config to chain 69's in the
// zvm-core submodule. It runs the zvm CLI, built from that submodule with
// `go build -o zvm ./zvm-core/cmd/zvm` (ZVM_CLI names another), against the
// chain's NoM node ($NOM_NODE) and execution client ($ZVM_ETH, default rpc).
//
// In: a stand-in window.zenon takes the account block the page builds, checks
// it names the vault, the token, the amount and the chain, and publishes its
// data verbatim from a dev key with `zvm deposit -message` — which decodes the
// call and refuses a malformed one. The page must then see the deposit credited.
//
// Out: a stand-in EIP-6963 wallet signs with a throwaway key the faucet funds.
// The page must see its withdrawal paid on Zenon by the committee, which is the
// real committee: nothing under either wallet is mocked.

import {execFile} from 'node:child_process'
import {existsSync, mkdirSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import puppeteer from 'puppeteer-core'
import {createPublicClient, createWalletClient, defineChain, http} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const rpc = process.argv[2] ?? process.env.ZVM_RPC
if (!rpc) throw new Error("pass the node's JSON-RPC, or set ZVM_RPC")
const app = (process.argv[3] ?? 'http://localhost:47300/').replace(/\/?$/, '/')
const rollupConfig = resolve(process.argv[4] ?? 'zvm-core/chains/l2-69/rollup.json')
const zvmCli = resolve(process.env.ZVM_CLI ?? (process.platform === 'win32' ? 'zvm.exe' : 'zvm'))
const l1 = process.env.NOM_NODE
if (!l1) throw new Error("set NOM_NODE to the chain's NoM node JSON-RPC")
const eth = process.env.ZVM_ETH ?? rpc
const devIndex = process.env.ZVM_DEV_INDEX ?? '1'
const apiBase = rpc.replace(/\/rpc$/, '')
const shots = process.env.GLYPHSWAP_SHOTS
if (shots) mkdirSync(shots, {recursive: true})

const started = Date.now()
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${msg}`)
const run = promisify(execFile)

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
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
const account = privateKeyToAccount(generatePrivateKey())
const signer = createWalletClient({account, chain, transport: http(rpc)})

// The dev key that signs the deposit, and is paid the withdrawal.
const {stdout: who} = await run(zvmCli, ['balance', '-config', rollupConfig, '-l1', l1, '-eth', eth, '-index', devIndex])
const zenonAddress = who.match(/= (z1[0-9a-z]+)/)?.[1]
if (!zenonAddress) throw new Error(`could not read the dev address from:\n${who}`)
log(`EVM ${account.address}, Zenon ${zenonAddress}, vault ${info.l1.vault}`)

async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Gas for the withdrawal. The faucet is the ZVM half only for a 0x address.
const res = await fetch(`${apiBase}/api/faucet`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({address: account.address}),
})
if (!res.ok) throw new Error(`faucet: ${await res.text()}`)
await until(async () => (await client.getBalance({address: account.address})) > 0n, 180_000, 'faucet ZNN')
log(`funded with ${Number(await client.getBalance({address: account.address})) / 1e18} ZNN`)

// --- the stand-in wallets -----------------------------------------------------

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

const DEPOSIT = '1'
let captured = null

async function zenonSend(template) {
  captured = template
  const data = Buffer.from(template.data, 'base64')
  const want = {toAddress: info.l1.vault, tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', amount: String(BigInt(DEPOSIT) * 10n ** 8n), chainIdentifier: info.l1.chainId}
  for (const [k, v] of Object.entries(want)) {
    if (String(template[k]) !== String(v)) throw new Error(`the page built ${k} = ${template[k]}, want ${v}`)
  }
  if (data[0] !== 0x01) throw new Error(`the deposit data is not a call message: 0x${data.toString('hex')}`)
  const {stdout} = await run(zvmCli, [
    'deposit', '-config', rollupConfig, '-l1', l1, '-eth', eth, '-index', devIndex,
    '-amount', DEPOSIT, '-token', 'ZNN', '-message', `0x${data.toString('hex')}`, '-wait', '0',
  ])
  const hash = stdout.match(/NoM block\s+([0-9a-f]{64})/)?.[1]
  if (!hash) throw new Error(`zvm deposit printed no NoM block:\n${stdout}`)
  log(`   published ${data.length} bytes of call data as NoM block ${hash.slice(0, 12)}…`)
  return {hash}
}

const browser = await puppeteer.launch({executablePath: chromePath, headless: 'new', args: ['--no-sandbox', '--disable-gpu']})
const page = await browser.newPage()
await page.setViewport({width: 1360, height: 1100, deviceScaleFactor: 1})

const problems = []
page.on('pageerror', (err) => problems.push(`page error: ${err.message}`))
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))

await page.exposeFunction('__evm', evmRequest)
await page.exposeFunction('__zenonSend', zenonSend)
await page.evaluateOnNewDocument(
  (rpc, zenonAddress, nomChainId) => {
    try {
      localStorage.setItem('glyphswap.rpc', rpc)
      localStorage.setItem('glyphswap.wallet', 'Test wallet')
    } catch {}
    const provider = {request: ({method, params}) => window.__evm(method, params ?? []), on() {}, removeListener() {}}
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: Object.freeze({info: {uuid: 'glyphswap-verify', name: 'Test wallet', icon: '', rdns: 'test.glyphswap'}, provider}),
        }),
      )
    window.addEventListener('eip6963:requestProvider', announce)
    let connected = false
    window.zenon = {
      isSyriusExtension: true,
      connect: async () => ((connected = true), true),
      disconnect: async () => ((connected = false), true),
      getAccounts: async () => (connected ? [zenonAddress] : []),
      getChainId: async () => nomChainId,
      getNodeUrl: async () => 'ws://stand-in',
      sendAccountBlock: (block) => window.__zenonSend(block),
      on() {},
      removeListener() {},
    }
  },
  rpc,
  zenonAddress,
  info.l1.chainId,
)

const shot = async (name) => shots && page.screenshot({path: join(shots, `${name}.png`), fullPage: true})
const visible = (text) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.checkVisibility() && b.textContent.trim().startsWith(text) && !b.disabled,
  )
async function click(text) {
  await page.waitForFunction(`(${visible})(${JSON.stringify(text)})`, {timeout: 40_000}).catch(async () => {
    const reads = await page.evaluate(`[...document.querySelectorAll('button.btn')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim())`)
    throw new Error(`no enabled "${text}" button; the page offers ${JSON.stringify(reads)}`)
  })
  await page.evaluate(`(${visible})(${JSON.stringify(text)}).click()`)
}
async function typeInto(selector, value) {
  await page.click(selector, {clickCount: 3})
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
}
const textOf = () => page.evaluate(() => document.body.innerText)

let failed = false
try {
  // --- status -----------------------------------------------------------------
  await page.goto(`${app}bridge`, {waitUntil: 'networkidle0'})
  await page.waitForFunction(() => /Deposits in\s+(Working|Slow|Stopped)/i.test(document.body.innerText), {timeout: 30_000})
  const status = (await textOf()).match(/Deposits in\s+(\w+)\s+Withdrawals out\s+(\w+)/i)
  log(`status: deposits ${status?.[1]}, withdrawals ${status?.[2]}`)
  await shot('bridge-status')

  // --- in -----------------------------------------------------------------------
  log('deposit: 1 ZNN from Zenon to the connected EVM wallet')
  const before = await client.getBalance({address: account.address})
  await click('Connect Syrius')
  await page.waitForFunction(() => document.body.innerText.includes('Signing as'), {timeout: 15_000})
  await typeInto('input[aria-label="Amount to deposit"]', DEPOSIT)
  const to = await page.$eval('input[aria-label="EVM address to credit"]', (el) => el.value)
  if (to.toLowerCase() !== account.address.toLowerCase()) throw new Error(`the recipient auto-filled as ${to}, not the connected wallet`)
  await click('Deposit ZNN')
  await page.waitForFunction(() => document.body.innerText.includes('Waiting for a momentum') || document.body.innerText.includes('Credited'), {timeout: 60_000})
  await page.waitForFunction(() => document.body.innerText.includes('Credited'), {timeout: 180_000, polling: 1000})
  const after = await client.getBalance({address: account.address})
  const credited = after - before
  if (credited !== 10n ** 18n) throw new Error(`the ZVM credited ${credited} wei, want 1 ZNN`)
  log(`   ok   credited exactly 1 ZNN; the page reads Credited (data ${Buffer.from(captured.data, 'base64').length} bytes)`)
  await shot('bridge-deposit')

  // --- out ------------------------------------------------------------------------
  log(`withdraw: 1 ZNN from the ZVM to ${zenonAddress}`)
  await click('Withdraw to Zenon')
  await typeInto('input[aria-label="Amount to withdraw"]', '1')
  const payee = await page.$eval('input[aria-label="Zenon address to pay"]', (el) => el.value)
  if (payee !== zenonAddress) throw new Error(`the payee auto-filled as ${payee}, not the Syrius account`)
  await page.waitForFunction(() => document.body.innerText.includes('Arrives on Zenon'), {timeout: 20_000})
  await click('Withdraw ZNN')
  await page.waitForFunction(() => /Withdrawal #\d+/.test(document.body.innerText) || document.querySelector('li[data-state="failed"]'), {timeout: 240_000, polling: 1000})
  if (await page.$('li[data-state="failed"]')) throw new Error(`the withdrawal failed: ${await page.$eval('li[data-state="failed"]', (el) => el.textContent)}`)
  const id = (await textOf()).match(/Withdrawal #(\d+)/)[1]
  log(`   ok   withdrawal #${id} executed on the ZVM; waiting for the committee`)
  await shot('bridge-withdraw-pending')
  await page.waitForFunction(() => document.body.innerText.includes('Paid on Zenon'), {timeout: 600_000, polling: 2000})
  log(`   ok   withdrawal #${id} paid on Zenon, derived back into the bridge contract`)
  await shot('bridge-withdraw-paid')

  // --- the movements panel is this wallet's and nobody else's ------------------
  // A fresh key has exactly one withdrawal, so any other row is someone else's.
  const rows = () => page.$$eval('table tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()))
  await page.waitForFunction((id) => [...document.querySelectorAll('table tbody tr')].some((tr) => tr.innerText.includes(`#${id}`) && tr.innerText.includes('Paid on Zenon')), {timeout: 60_000}, id)
  const out = await rows()
  if (out.length !== 1) throw new Error(`the withdrawals tab shows ${out.length} rows, want only #${id}: ${JSON.stringify(out)}`)
  log(`   ok   withdrawals tab: ${out[0]}`)
  await click('Deposits')
  await page.waitForFunction(() => [...document.querySelectorAll('table tbody tr')].some((tr) => /credited/.test(tr.innerText)), {timeout: 60_000})
  const ins = await rows()
  // Dev key 1 signs every run's deposit, so its earlier ones are rightly here too;
  // what must hold is that each row is one of its deposits and this run's is first.
  if (!ins[0]?.includes('1 ZNN')) throw new Error(`the deposits tab does not lead with this run's 1 ZNN: ${JSON.stringify(ins.slice(0, 3))}`)
  log(`   ok   deposits tab: ${ins.length} of the signer's deposits, newest ${ins[0]}`)
  await shot('bridge-mine')
} catch (err) {
  failed = true
  log(`FAIL ${err.message}`)
  await shot('bridge-failure')
} finally {
  await browser.close()
}

for (const p of problems) log(`   ${p}`)
if (failed || problems.length) process.exit(1)
log('bridge verified both ways')
