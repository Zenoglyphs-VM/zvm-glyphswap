import {createRouter, createWebHistory} from 'vue-router'

// Real paths, not hashes: a pool page is the thing people share, and
// /pool/0xabc… reads as an address rather than a fragment. GitHub Pages has no
// SPA rewrite, so the build leaves a copy of index.html at 404.html
// (vite.config.ts) and unmatched paths boot the app with the URL intact.
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: (to, from, saved) => saved ?? (to.path === from.path ? false : {top: 0}),
  routes: [
    {path: '/', name: 'swap', component: () => import('./pages/SwapPage.vue')},
    {path: '/explore', name: 'explore', component: () => import('./pages/ExplorePage.vue')},
    {path: '/pool', name: 'pool', component: () => import('./pages/PoolPage.vue')},
    {path: '/pool/new', name: 'pool-new', component: () => import('./pages/NewPositionPage.vue')},
    {path: '/pool/:pair', name: 'pool-detail', component: () => import('./pages/PoolDetailPage.vue')},
    {path: '/bridge', name: 'bridge', component: () => import('./pages/BridgePage.vue')},
    {path: '/faucet', name: 'faucet', component: () => import('./pages/FaucetPage.vue')},
    {path: '/about', name: 'about', component: () => import('./pages/AboutPage.vue')},
    {path: '/:pathMatch(.*)*', name: 'notfound', component: () => import('./pages/NotFoundPage.vue')},
  ],
})
