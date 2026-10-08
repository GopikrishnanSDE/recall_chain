// MedChain server: stores batch fingerprints, serves Merkle proofs, verifies scratch codes
// and relays customer claims to the SupplyChain contract.
import express from 'express'
import cors from 'cors'
import { ethers } from 'ethers'
import { RPC_URL, getChain, resetChain, revertReason } from './chain.js'
import { DATA_DIR, buildRoot, hasBatch, loadBatch, saveBatch } from './store.js'

const PORT = Number(process.env.PORT || 4000)
const MAX_LEAVES = 1_000_000
const UNIT_STATUS = ['Invalid', 'Genuine', 'AlreadyClaimed', 'Recalled']
const UNIT_STATE = ['None', 'Claimed', 'Quarantined']
const STAGE_LABELS = ['Created', 'Processing', 'In Transit', 'For Sale', 'Sold']

const app = express()
app.use(cors())
app.use(express.json({ limit: '80mb' }))

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const isBytes32 = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)

function positiveInt(value, name) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive whole number`)
  return n
}

function normalizeSecret(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'secret is required')
  let s = value.trim().replace(/[\s-]/g, '')
  if (!s.startsWith('0x')) s = `0x${s}`
  if (!isBytes32(s)) throw new HttpError(400, 'secret must be 64 hexadecimal characters')
  return s.toLowerCase()
}

/** Wraps async route handlers so errors become JSON responses. */
const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res))
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    const isRevert = err?.code === 'CALL_EXCEPTION' || /revert/i.test(String(err?.message))
    if (isRevert) return res.status(400).json({ error: revertReason(err) })
    resetChain() // chain restarted or contract redeployed: reconnect on the next request
    console.error(err)
    return res.status(503).json({ error: `Blockchain unavailable: ${err?.shortMessage || err?.message || err}` })
  }
}

async function loadProduct(reader, productId) {
  const ctr = Number(await reader.productCtr())
  if (productId > ctr) throw new HttpError(404, `Batch ${productId} does not exist`)
  const p = await reader.ProductStock(productId)
  return { id: productId, name: p.name, description: p.description, quantity: Number(p.quantity), merkleRoot: p.merkleRoot }
}

function proofFor(batch, serial) {
  if (serial > batch.leaves.length) throw new HttpError(400, `Serial ${serial} is outside this batch`)
  return batch.tree.getProof(batch.leaves[serial - 1])
}

/** Loads the stored leaves and checks they still match the on-chain root (guards against a reset chain). */
function requireBatch(chain, product) {
  const batch = loadBatch(chain.chainId, chain.address, product.id)
  if (!batch || batch.root.toLowerCase() !== product.merkleRoot.toLowerCase()) {
    throw new HttpError(
      404,
      `Codes for batch ${product.id} were never uploaded to this server. Ask the manufacturer to upload them.`,
    )
  }
  return batch
}

function batchUploaded(chain, product) {
  if (!hasBatch(chain.chainId, chain.address, product.id)) return false
  const batch = loadBatch(chain.chainId, chain.address, product.id)
  return batch.root.toLowerCase() === product.merkleRoot.toLowerCase()
}

/** Must match SupplyChain.unitLeaf(serial, secret) and client/src/lib/batchCodes.ts. */
function unitLeaf(serial, secret) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [serial, secret])
  return ethers.keccak256(ethers.keccak256(encoded))
}

/**
 * Finds which serial in `batch` a scratch code belongs to, so patients only have to type the
 * code — no batch ID or serial number. No secrets are stored anywhere to do this: the server
 * already has every pack's public leaf hash for the batch, so it just tries each serial in turn
 * and checks which one the code reconstructs. O(quantity) hashes, done once per check.
 */
function findSerial(batch, secret) {
  for (let i = 0; i < batch.leaves.length; i++) {
    if (unitLeaf(i + 1, secret).toLowerCase() === batch.leaves[i].toLowerCase()) return i + 1
  }
  return null
}

/**
 * Resolves {productId, product, batch, serial} for a scratch code.
 * - productId given: looks only in that batch (fast path — this is what a QR-scanned link uses).
 * - productId omitted: searches every batch with uploaded codes, most recent first.
 * Returns null if the code doesn't belong to any known pack.
 */
async function resolveUnit(chain, secret, body) {
  if (body.productId != null) {
    const productId = positiveInt(body.productId, 'productId')
    const product = await loadProduct(chain.reader, productId)
    const batch = requireBatch(chain, product)
    const serial = body.serial != null ? positiveInt(body.serial, 'serial') : findSerial(batch, secret)
    return serial ? { productId, product, batch, serial } : null
  }

  const ctr = Number(await chain.reader.productCtr())
  for (let productId = ctr; productId >= 1; productId--) {
    if (!hasBatch(chain.chainId, chain.address, productId)) continue
    const product = await loadProduct(chain.reader, productId)
    if (!batchUploaded(chain, product)) continue
    const batch = loadBatch(chain.chainId, chain.address, productId)
    const serial = findSerial(batch, secret)
    if (serial) return { productId, product, batch, serial }
  }
  return null
}

// One relayed transaction at a time keeps nonces in order.
let sendQueue = Promise.resolve()
function enqueue(task) {
  const run = sendQueue.then(task, task)
  sendQueue = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get(
  '/api/health',
  route(async () => {
    const chain = await getChain()
    return { ok: true, chainId: chain.chainId, contract: chain.address, relayer: chain.relayer, rpcUrl: RPC_URL }
  }),
)

/** Manufacturer uploads leaf hashes (in serial order). Accepted only if they rebuild the on-chain root. */
app.post(
  '/api/batches/:productId/leaves',
  route(async (req) => {
    const productId = positiveInt(req.params.productId, 'productId')
    const { leaves } = req.body ?? {}
    if (!Array.isArray(leaves) || leaves.length === 0 || leaves.length > MAX_LEAVES) {
      throw new HttpError(400, 'leaves must be a non-empty array')
    }
    if (!leaves.every(isBytes32)) throw new HttpError(400, 'every leaf must be a 32-byte hex string')
    const normalized = leaves.map((l) => l.toLowerCase())
    if (new Set(normalized).size !== normalized.length) throw new HttpError(400, 'leaves contain duplicates')

    const chain = await getChain()
    const product = await loadProduct(chain.reader, productId)
    if (product.quantity !== normalized.length) {
      throw new HttpError(400, `Batch ${productId} has ${product.quantity} packs but ${normalized.length} leaves were sent`)
    }
    const root = buildRoot(normalized)
    if (root.toLowerCase() !== product.merkleRoot.toLowerCase()) {
      throw new HttpError(400, 'These leaves do not match the merkle root recorded on-chain for this batch')
    }
    const alreadyStored = batchUploaded(chain, product)
    saveBatch(chain.chainId, chain.address, productId, normalized, root)
    return { ok: true, productId, quantity: product.quantity, root, alreadyStored }
  }),
)

app.get(
  '/api/batches/:productId',
  route(async (req) => {
    const productId = positiveInt(req.params.productId, 'productId')
    const chain = await getChain()
    const product = await loadProduct(chain.reader, productId)
    return { ...product, codesUploaded: batchUploaded(chain, product) }
  }),
)

/** Public provenance: product details, every registered actor that handled it, and a timestamped
 *  stage-by-stage timeline reconstructed from on-chain events. No wallet or scratch code needed —
 *  this is what a QR code on the box links to. */
app.get(
  '/api/batches/:productId/provenance',
  route(async (req) => {
    const productId = positiveInt(req.params.productId, 'productId')
    const chain = await getChain()
    const ctr = Number(await chain.reader.productCtr())
    if (productId > ctr) throw new HttpError(404, `Batch ${productId} does not exist`)

    const p = await chain.reader.ProductStock(productId)
    const actorRefs = [
      ['supplier', 'SUPPLIERS', Number(p.supplierId)],
      ['producer', 'PRODUCERS', Number(p.producerId)],
      ['distributor', 'DISTRIBUTORS', Number(p.distributorId)],
      ['seller', 'SELLERS', Number(p.sellerId)],
    ]
    const actors = {}
    for (const [key, mapping, id] of actorRefs) {
      if (id === 0) {
        actors[key] = null
        continue
      }
      const a = await chain.reader[mapping](id)
      actors[key] = { id, name: a.name, place: a.place, address: a.addr }
    }

    const byAddress = Object.fromEntries(
      Object.entries(actors)
        .filter(([, v]) => v)
        .map(([key, v]) => [v.address.toLowerCase(), key[0].toUpperCase() + key.slice(1)]),
    )

    const [addedLogs, stageLogs] = await Promise.all([
      chain.reader.queryFilter(chain.reader.filters.ProductAdded(productId), 0, 'latest'),
      chain.reader.queryFilter(chain.reader.filters.ProductStageUpdated(productId), 0, 'latest'),
    ])

    const events = [...addedLogs, ...stageLogs].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
    )

    const timeline = await Promise.all(
      events.map(async (log) => {
        const [block, tx] = await Promise.all([log.getBlock(), log.getTransaction()])
        const actorLabel = byAddress[tx.from.toLowerCase()] ?? null
        const isCreation = log.fragment.name === 'ProductAdded'
        return {
          stage: isCreation ? 'Created' : STAGE_LABELS[Number(log.args.stage)],
          actor: actorLabel,
          actorAddress: tx.from,
          timestamp: block.timestamp,
          txHash: log.transactionHash,
        }
      }),
    )

    const recall = await chain.reader.recalls(productId)

    return {
      id: productId,
      name: p.name,
      description: p.description,
      quantity: Number(p.quantity),
      stage: Number(p.stage),
      stageLabel: STAGE_LABELS[Number(p.stage)],
      actors,
      timeline,
      recall: recall.active
        ? { active: true, reasonHash: recall.reasonHash, recalledAt: Number(recall.recalledAt), deadline: Number(recall.deadline) }
        : { active: false },
    }
  }),
)

app.get(
  '/api/batches/:productId/proof/:serial',
  route(async (req) => {
    const productId = positiveInt(req.params.productId, 'productId')
    const serial = positiveInt(req.params.serial, 'serial')
    const chain = await getChain()
    const product = await loadProduct(chain.reader, productId)
    return { productId, serial, proof: proofFor(requireBatch(chain, product), serial) }
  }),
)

/**
 * Customer check: is this scratch code genuine? (read-only, nothing is written)
 * `productId` is optional — when a QR link already supplies it, only `secret` is required and the
 * matching serial is found automatically (see findSerial). Without a productId, every batch with
 * uploaded codes is searched, so typing just the code works even without scanning a QR first.
 */
app.post(
  '/api/verify',
  route(async (req) => {
    const secret = normalizeSecret(req.body?.secret)
    const chain = await getChain()
    const resolved = await resolveUnit(chain, secret, req.body ?? {})

    if (!resolved) {
      return {
        productId: 0,
        serial: 0,
        status: 'Invalid',
        claimant: null,
        product: { name: '', description: '', quantity: 0 },
        stage: '',
        recalled: false,
      }
    }

    const { productId, product, batch, serial } = resolved
    const [s, c] = await chain.reader.unitStatus(productId, serial, secret, proofFor(batch, serial))
    const status = UNIT_STATUS[Number(s)]
    const claimant = c === ethers.ZeroAddress ? null : c
    const recall = await chain.reader.recalls(productId)
    return {
      productId,
      serial,
      status,
      claimant,
      product: { name: product.name, description: product.description, quantity: product.quantity },
      stage: await chain.reader.showStage(productId),
      recalled: recall.active,
    }
  }),
)

/** Public status of one pack by serial number (no scratch code needed). Used for recall alerts. */
app.get(
  '/api/units/:productId/:serial',
  route(async (req) => {
    const productId = positiveInt(req.params.productId, 'productId')
    const serial = positiveInt(req.params.serial, 'serial')
    const chain = await getChain()
    const product = await loadProduct(chain.reader, productId)
    if (serial > product.quantity) throw new HttpError(400, `Serial ${serial} is outside this batch`)
    const unit = await chain.reader.units(productId, serial)
    const recall = await chain.reader.recalls(productId)
    return {
      productId,
      serial,
      name: product.name,
      state: UNIT_STATE[Number(unit.state)],
      claimant: unit.claimant === ethers.ZeroAddress ? null : unit.claimant,
      recalled: recall.active,
      recalledAt: recall.active ? Number(recall.recalledAt) : null,
    }
  }),
)

/** The 32-byte message a customer's key signs to have a claim relayed. */
app.get(
  '/api/claim-digest',
  route(async (req) => {
    const productId = positiveInt(req.query.productId, 'productId')
    const serial = positiveInt(req.query.serial, 'serial')
    const claimant = String(req.query.claimant ?? '')
    if (!ethers.isAddress(claimant)) throw new HttpError(400, 'claimant must be an address')
    const chain = await getChain()
    return { digest: await chain.reader.claimDigest(productId, serial, claimant) }
  }),
)

/** Relays a claim. The contract checks the code, the proof and the customer's signature. */
app.post(
  '/api/claim',
  route(async (req) => {
    const productId = positiveInt(req.body?.productId, 'productId')
    const serial = positiveInt(req.body?.serial, 'serial')
    const secret = normalizeSecret(req.body?.secret)
    const { claimant, signature } = req.body ?? {}
    if (!ethers.isAddress(claimant)) throw new HttpError(400, 'claimant must be an address')
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new HttpError(400, 'signature must be a 65-byte hex string')
    }

    const chain = await getChain()
    const product = await loadProduct(chain.reader, productId)
    const batch = requireBatch(chain, product)
    const proof = proofFor(batch, serial)

    return enqueue(async () => {
      // Dry run first so the customer gets the contract's reason instead of a failed transaction.
      await chain.writer.claimUnitFor.staticCall(productId, serial, secret, proof, claimant, signature)
      const tx = await chain.writer.claimUnitFor(productId, serial, secret, proof, claimant, signature)
      const receipt = await tx.wait()
      return { ok: true, txHash: tx.hash, blockNumber: receipt?.blockNumber ?? null }
    })
  }),
)

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// Malformed JSON bodies and other middleware errors.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err?.status && err.status < 500 ? err.status : 500
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message })
})

app.listen(PORT, () => {
  console.log(`MedChain server listening on http://localhost:${PORT}`)
  console.log(`RPC: ${RPC_URL} | data: ${DATA_DIR}`)
  getChain()
    .then((c) => console.log(`Connected to chain ${c.chainId}, contract ${c.address}, relayer ${c.relayer}`))
    .catch((e) => console.warn(`Not connected yet: ${e.message}`))
})
