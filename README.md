# zvm-glyphswap

A trading interface for Uniswap V2 on the ZVM, the EVM that Zenon's Network of
Momentum orders. A static bundle with no backend: the browser reads every
number over JSON-RPC from a node, the one the build names or one chosen in the
header or with `?rpc=`.

```sh
git clone --recurse-submodules https://github.com/Zenoglyphs-VM/zvm-glyphswap
npm install
cp .env.example .env
npm run dev        # http://localhost:47200/zvm-glyphswap/
npm run build      # dist/
npm run typecheck
npm run verify     # a real swap against a running node, in headless Chrome
```

No node is built in. `VITE_ZVM_NODE` names the node this build reads (the build
stops without it), `VITE_ZVM_PRESETS` adds more to the node picker, and the
scripts read `ZVM_RPC`; `.env.example` has
a local [zvm-devnet](https://github.com/Zenoglyphs-VM/zvm-devnet)'s. The shared code (`@zvm/web`) is compiled
from the [zvm-core](https://github.com/Zenoglyphs-VM/zvm-core) submodule.

A trade is ordered before it is executed: the wallet signs, a relayer posts it
to Zenon, and the momentum carrying it becomes one ZVM block. An approval and a
swap are two momentums.

## Deploy

Every push to `main` publishes to GitHub Pages (Settings, Pages, Source:
GitHub Actions), built with the organisation's `ZVM_NODE` and `ZVM_GATEWAY`
Actions variables. Add `public/CNAME` to serve from a domain's root.

MIT licence. The full guide, with how it works and why:
[docs/GUIDE.md](docs/GUIDE.md).
