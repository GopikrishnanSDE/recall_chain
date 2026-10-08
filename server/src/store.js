// JSON-file storage for batch leaf lists. Secrets are never stored here — only leaf hashes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = process.env.DATA_DIR || path.resolve(here, '../data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const treeCache = new Map()

function fileFor(chainId, contract, productId) {
  return path.join(DATA_DIR, `batch-${chainId}-${contract.toLowerCase()}-${productId}.json`)
}

export function hasBatch(chainId, contract, productId) {
  return fs.existsSync(fileFor(chainId, contract, productId))
}

/** Saves leaves in serial order (index 0 = serial 1). Writes atomically. */
export function saveBatch(chainId, contract, productId, leaves, root) {
  const file = fileFor(chainId, contract, productId)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ productId, root, leaves, savedAt: new Date().toISOString() }))
  fs.renameSync(tmp, file)
  treeCache.delete(file)
}

/** Returns { root, leaves, tree } or null when the batch was never uploaded. */
export function loadBatch(chainId, contract, productId) {
  const file = fileFor(chainId, contract, productId)
  if (treeCache.has(file)) return treeCache.get(file)
  if (!fs.existsSync(file)) return null
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const tree = SimpleMerkleTree.of(data.leaves)
  const batch = { root: data.root, leaves: data.leaves, tree }
  treeCache.set(file, batch)
  return batch
}

export function buildRoot(leaves) {
  return SimpleMerkleTree.of(leaves).root
}
