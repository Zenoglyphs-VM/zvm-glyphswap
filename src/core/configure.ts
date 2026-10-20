// What this app tells @zvm/web about itself. Imported first, before anything
// that reads a number or builds a client.

import {configure} from '@zvm/web'

import {chainName} from './chains'
import {rpcUrl} from './endpoint'

configure({
  // Zero, not a dash: a dash in an amount field reads as a broken input.
  empty: '0',
  rpcUrl,
  appUrl: () => (typeof window === 'undefined' ? '' : `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}`),
  chainName,
})
