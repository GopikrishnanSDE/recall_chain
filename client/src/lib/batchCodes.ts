/**
 * Scratch-code helpers shared by the manufacturer page (creating codes) and the
 * customer verify page (claiming a pack). No wallet or network needed.
 *
 * Leaf formula must match SupplyChain.unitLeaf(serial, secret):
 *   keccak256(bytes.concat(keccak256(abi.encode(uint256 serial, bytes32 secret))))
 */
import Web3 from 'web3'
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree'

const web3 = new Web3()

export type BatchCodes = {
  /** secrets[i] is the scratch code for serial i + 1 (0x-prefixed, 32 bytes) */
  secrets: string[]
  /** leaves[i] is the fingerprint for serial i + 1 — safe to share, reveals nothing */
  leaves: string[]
  root: string
}

export const MAX_UI_BATCH = 10_000

export function randomSecret(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function unitLeaf(serial: number, secret: string): string {
  const encoded = web3.eth.abi.encodeParameters(['uint256', 'bytes32'], [serial, secret])
  return web3.utils.keccak256(web3.utils.keccak256(encoded))
}

/** Creates `quantity` random scratch codes and the Merkle root that goes on-chain. */
export function generateBatchCodes(quantity: number): BatchCodes {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Quantity must be at least 1')
  const secrets = Array.from({ length: quantity }, randomSecret)
  const leaves = secrets.map((secret, i) => unitLeaf(i + 1, secret))
  const root = SimpleMerkleTree.of(leaves).root
  return { secrets, leaves, root }
}

/** Short printable form of a secret: 64 hex chars in groups of 4. */
export function formatSecret(secret: string): string {
  return secret.replace(/^0x/, '').toUpperCase().match(/.{1,4}/g)?.join('-') ?? secret
}

/** Accepts the printed form (with dashes/spaces, any case) and returns 0x-prefixed hex, or null. */
export function parseSecret(input: string): string | null {
  const hex = input.trim().replace(/^0x/i, '').replace(/[\s-]/g, '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : null
}

/** CSV the manufacturer sends to the printer. Each row is one pack. */
export function codesToCsv(productId: string | number, name: string, secrets: string[]): string {
  const header = 'batch_id,product,serial,scratch_code'
  const safeName = `"${name.replace(/"/g, '""')}"`
  const rows = secrets.map((s, i) => `${productId},${safeName},${i + 1},${formatSecret(s)}`)
  return [header, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// Customer key (Feature 9): generated on the device, never leaves it.
// ---------------------------------------------------------------------------

export type CustomerKey = { address: string; privateKey: string }

export function createCustomerKey(): CustomerKey {
  const account = web3.eth.accounts.create()
  return { address: account.address, privateKey: account.privateKey }
}

/** EIP-191 personal signature over the 32-byte claim digest returned by the contract. */
export function signClaimDigest(digest: string, privateKey: string): string {
  return web3.eth.accounts.sign(digest, privateKey).signature
}
