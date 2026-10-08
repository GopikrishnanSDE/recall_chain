// Blockchain access: provider, contract, relayer signer and revert-reason decoding.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from 'ethers'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSrc = path.resolve(here, '../../client/src')

export const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:7545'
const RELAYER_ACCOUNT_INDEX = Number(process.env.RELAYER_ACCOUNT_INDEX ?? 9)

function loadAbi() {
  const artifactPath = path.join(clientSrc, 'artifacts/contracts/SupplyChain.sol/SupplyChain.json')
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Contract artifact not found at ${artifactPath}. Run "npm run compile" in backend/ first.`)
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')).abi
}

function loadAddress(chainId) {
  if (process.env.CONTRACT_ADDRESS) return process.env.CONTRACT_ADDRESS
  const deploymentsPath = path.join(clientSrc, 'deployments.json')
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'))
  const address = deployments?.networks?.[String(chainId)]?.SupplyChain?.address
  if (!address) {
    throw new Error(`No SupplyChain address for chain ${chainId} in ${deploymentsPath}. Deploy the contract first.`)
  }
  return address
}

let cached = null

/** Connects once and reuses the connection. */
export async function getChain() {
  if (cached) return cached
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const network = await provider.getNetwork()
  const chainId = Number(network.chainId)
  const address = loadAddress(chainId)
  const code = await provider.getCode(address)
  if (code === '0x') {
    throw new Error(`No contract deployed at ${address} on chain ${chainId} (${RPC_URL}). Re-run the deploy script.`)
  }

  let signer
  if (process.env.RELAYER_PRIVATE_KEY) {
    signer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider)
  } else {
    // Ganache and Hardhat node expose unlocked, pre-funded accounts.
    signer = await provider.getSigner(RELAYER_ACCOUNT_INDEX)
  }

  const abi = loadAbi()
  const reader = new ethers.Contract(address, abi, provider)
  const writer = new ethers.Contract(address, abi, signer)
  cached = { provider, chainId, address, reader, writer, relayer: await signer.getAddress() }
  return cached
}

/** Forget the connection (used when the chain was restarted or the contract redeployed). */
export function resetChain() {
  cached = null
}

/** Pulls a readable revert reason out of an ethers error. */
export function revertReason(err) {
  const candidates = [err?.reason, err?.revert?.args?.[0], err?.info?.error?.message, err?.shortMessage, err?.message]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      const m = /reverted with reason string '([^']+)'/.exec(c) || /execution reverted: ?"?([^"]+)"?/.exec(c)
      return (m ? m[1] : c).trim()
    }
  }
  return 'Transaction failed'
}
