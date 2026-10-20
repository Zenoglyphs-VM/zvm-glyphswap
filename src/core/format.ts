// Every number a person reads comes from @zvm/web, so that this app and the
// explorer round, group and truncate identically.
//
// What stays here is the placeholder. The explorer prints `-` for a value it
// does not have; a trading interface prints `0`, because a dash in an amount
// field reads as a broken input — and `''` where the value is a phrase rather
// than a number. Each wrapper below pins the one this app wants, so a change to
// the shared arithmetic can never quietly change what an empty field says.

import * as base from '@zvm/web/format'

export {compact, plain, tokenColor} from '@zvm/web/format'

export const units = (value: string | bigint | number | null | undefined, decimals: number, maxFrac = 6) =>
  base.units(value, decimals, maxFrac, '0')

export const znn = (wei: string | bigint | null | undefined, maxFrac = 6) => base.znn(wei, maxFrac, '0')

export const amount = (v: number | null | undefined, opts: {dash?: string} = {}) =>
  base.amount(v, {dash: opts.dash ?? '0'})

export const price = (v: number | null | undefined) => base.price(v, '0')

export const number = (n: number | string | null | undefined) => base.number(n, '0')

export const short = (id: string | null | undefined, head = 6, tail = 4) => base.short(id, head, tail, '')

export const ago = (timestamp: number | null | undefined) => base.ago(timestamp, '')

export const percent = (share: number | null | undefined) => base.percent(share, '0%')

export const gwei = (wei: bigint | null | undefined) => base.gwei(wei, '0')

export const duration = (seconds: number | null | undefined) => base.duration(seconds, '')
