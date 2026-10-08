/**
 * Customer-side storage on this device (Feature 9). Holds the customer's own key and the packs
 * they claimed, so the app can warn them if a claimed pack's batch is recalled.
 * All access is wrapped: private browsing or blocked storage simply means nothing is remembered.
 */
import { type CustomerKey, createCustomerKey } from './batchCodes'

const KEY_STORAGE = 'medchain.customerKey'
const CLAIMS_STORAGE = 'medchain.claims'

export type ClaimRecord = {
  productId: number
  serial: number
  name: string
  claimedAt: string
  txHash: string
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage unavailable — the claim still exists on-chain
  }
}

/** Returns this device's customer key, creating one on first use. */
export function getOrCreateCustomerKey(): CustomerKey {
  const existing = read<CustomerKey>(KEY_STORAGE)
  if (existing?.address && existing?.privateKey) return existing
  const key = createCustomerKey()
  write(KEY_STORAGE, key)
  return key
}

export function getCustomerAddress(): string | null {
  return read<CustomerKey>(KEY_STORAGE)?.address ?? null
}

export function getClaims(): ClaimRecord[] {
  const claims = read<ClaimRecord[]>(CLAIMS_STORAGE)
  return Array.isArray(claims) ? claims : []
}

export function addClaim(claim: ClaimRecord): ClaimRecord[] {
  const claims = getClaims().filter((c) => !(c.productId === claim.productId && c.serial === claim.serial))
  const next = [claim, ...claims]
  write(CLAIMS_STORAGE, next)
  return next
}

export function removeClaim(productId: number, serial: number): ClaimRecord[] {
  const next = getClaims().filter((c) => !(c.productId === productId && c.serial === serial))
  write(CLAIMS_STORAGE, next)
  return next
}
