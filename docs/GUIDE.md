# zvm-glyphswap guide

A standalone trading interface for **Uniswap V2 on the ZVM**, the EVM that
Zenon's Network of Momentum orders. It is a static bundle with no backend of its
own: every number on screen is read by your browser, over ordinary JSON-RPC,
from a node you choose.

Point it at a devnet on your laptop, a colleague's node, or a public one. The
endpoint is a control in the header and a `?rpc=` query parameter, so a link can
carry the node it was read from.

```sh
npm install
npm run dev        # http://localhost:47200/zvm-glyphswap/
npm run build      # static files in dist/
npm run typecheck
npm run verify     # drives the real pages against a running node, in headless Chrome
```

## What it does

| Page | |
|---|---|
| `/` | Swap, with the pair's price, chart and recent trades beside it |
| `/explore` | Every pool the factory has made, and every token they hold |
| `/pool` | Your positions, priced as the two amounts they would pay out |
| `/pool/:pair` | One pool: chart, trades, your share, deposit and withdraw |
| `/pool/new` | Open a position, or create a pool that does not exist yet |
| `/about` | How trading on this chain differs from trading on any other |

Swap covers what a Uniswap V2 interface is expected to cover: quotes computed
locally from reserves and re-quoted on chain before signing, slippage and
deadline settings, price impact with a refusal above five percent, minimum
received, two hop routing through wrapped ZNN or QSR, the 0.3% fee shown per
trade, ZNN wrap and unwrap, token search and import by address, `Max` and `Half`,
exact or unlimited approvals, and a record of what this browser has sent.

**ZNN and QSR is the pair it opens on.** ZNN is the chain's native coin and pays
for gas; QSR is an ERC-20 predeploy at
`0x4200000000000000000000000000000000000101` with eight decimals, not eighteen.

## Two things the chain changes

A trade here is **ordered before it is executed**. Your wallet signs an ordinary
EIP-1559 transaction, a relayer posts it to Zenon, and the momentum carrying it
is derived into exactly one ZVM block. So a transaction has a state between
"sent" and "confirmed" that other chains do not, the swap button names it, and
an approval followed by a swap is two momentums rather than two blocks in the
same second. The hairline under the header is that beat, filling across the gap
and resetting when a block lands.

Fees are filled in from the node rather than left to the wallet. The relayer
accepts a transaction on its effective tip, `min(tipCap, feeCap - baseFee)`, and
its floor is 50 gwei. Every sender in the `zvm` tree offers double that on
purpose, and this one does too, because a wallet guessing from stale chain data
signs transactions the relayer will not take.

## Where the contract addresses come from

Three sources, in order of trust:

1. What you typed into the node dialog, kept per chain id.
2. The node's own `/api/info`, when the RPC is a zvm node. This survives a devnet
   being re-genesised, because the node reads its deployment file at startup.
3. A small built-in table (`src/core/chains.ts`), so the app still works against
   a bare op-reth URL with no explorer API in front of it.

Multicall3 is at its canonical address, and wrapped QSR is a predeploy, so
neither is ever configured.

## Reaching a node on localhost

GitHub Pages is HTTPS-only, and an HTTPS page may not load plain HTTP, **except
from loopback**, which the Secure Contexts spec treats as trustworthy. So the
deployed page can read `http://localhost:49000`, and Chrome, Edge and Firefox all
honour that. A plain-HTTP LAN address such as `http://192.168.1.20:49000` is
blocked, and the node dialog says so before making a request that was never going
to succeed.

On the node's side, `zvm` already answers with `Access-Control-Allow-Origin: *`,
so a cross-origin read needs nothing from whoever runs it.

Nothing is proxied: your browser talks to your node, and the host serving this
page never sees the traffic.

## Wallets

Anything speaking **EIP-6963**: MetaMask, Rabby, Phantom, and the rest. The app
adds the chain to the wallet if it does not know it, switches to it, and offers
tokens to the wallet's own list with `wallet_watchAsset`. A wallet you connected
before reconnects on load without a prompt, because `eth_accounts` answers with
what this origin was already granted.

The ZVM's other lane, where a Zenon key publishes an account block directly,
belongs to Syrius and is not driven from here.

## Deploying

Push to `main`. The workflow in `.github/workflows/pages.yml` builds and
publishes to Pages with the organisation's `ZVM_NODE` and `ZVM_GATEWAY` Actions
variables, setting `BASE_PATH` from the repository name, or to `/` if
`public/CNAME` exists, for a custom domain.

GitHub Pages has no SPA rewrite, so the build leaves a copy of `index.html` at
`404.html`. A deep link like `/pool/0xabc...` boots the app with the URL intact.

No node is built in. A build reads `VITE_ZVM_NODE` (and stops without it), so a
copy served anywhere names its own default node; `.env.example` has
a local [zvm-devnet](https://github.com/Zenoglyphs-VM/zvm-devnet)'s.
The node picker offers that node first, then any `VITE_ZVM_PRESETS` names.

## Verifying

`npm run verify` runs the pages in headless Chrome against a live node. A
stand-in EIP-6963 wallet signs with a throwaway key the node's faucet funds, and
the script makes a **real swap**: Zenon orders it, the deriver derives it,
op-reth runs it, and the script checks the QSR balance moved. It then loads every
other page, opens the pool the trade went through, and checks the layout does not
scroll sideways at 400px wide. Set `GLYPHSWAP_SHOTS` to a directory to keep
screenshots.

```sh
ZVM_RPC=<the node's /rpc> node scripts/verify.mjs [rpc] [app]
```

## Design

Follows the Zenon design system as
[`zvm-explorer`](https://github.com/Zenoglyphs-VM/zvm-explorer) transcribes it, so the two surfaces read as one
product: Space Grotesk for interface, JetBrains Mono for every figure, tokens
transcribed rather than imported, nothing fetched from a CDN at runtime.

Token marks are inlined SVG paths, like everything else here. ZNN wears Zenon's
own **ZN** monogram from the brand file, unchanged. QSR wears its **Q**, traced
from the mark rather than redrawn by eye: the wall is about a ninth of the
ring's width and the stub leaves it at roughly 60 degrees, both measured off the
source raster, which is stretched sideways and so cannot be scaled straight.
Every other token wears its initials over a hue derived from its address, which
is stable everywhere and needs no list.

Colour is structural and means the same thing on both: **blue is NoM**, what was
ordered; **green is the ZVM**, what was executed; **pink is new**. On a DEX that
is not decoration, because a trade here really is ordered before it executes, and
the swap button's progress uses exactly those two colours to say which it is.

## Built from

The swap and pool logic is ported from the node-embedded UI in
the original zvm prototype (`web/ui`, not published) rather than rewritten, because those files are
where the awkward parts were already learned: the relayer's tip floor, the
re-quote before signing, the gas reserve a native `Max` has to leave behind.
What changed is that every request is built from a configured endpoint instead of
the page's own origin, and the surface is trading only.

## Licence

MIT (LICENSE).

## Shared code

The bech32 encoding, the number formatting, the viem chain definition and the
relayer's fee policy come from **@zvm/web**, in
[`zvm-core/web`](https://github.com/Zenoglyphs-VM/zvm-core/tree/main/web), so that this app and
[`zvm-explorer`](https://github.com/Zenoglyphs-VM/zvm-explorer) cannot drift on any of them. It is resolved
from the zvm-core submodule through a Vite alias and a tsconfig path — the same
arrangement as the Go modules' `replace ./zvm-core` — so clone this repo with
`--recurse-submodules`.

This app's own placeholder survives the move: where the explorer prints `-` for
a value it does not have, a trading interface prints `0`, because a dash in an
amount field reads as a broken input. `src/core/format.ts` pins that per
function rather than inheriting it.
