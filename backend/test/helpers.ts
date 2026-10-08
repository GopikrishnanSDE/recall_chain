import { ethers } from 'hardhat'
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree'

/** Same formula as SupplyChain.unitLeaf(serial, secret). */
export function unitLeaf(serial: number | bigint, secret: string): string {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'bytes32'], [serial, secret]),
  )
  return ethers.keccak256(inner)
}

/** Builds a batch of `quantity` packs with random scratch secrets (serials are 1..quantity). */
export function makeBatch(quantity: number) {
  const secrets = Array.from({ length: quantity }, () => ethers.hexlify(ethers.randomBytes(32)))
  const leaves = secrets.map((secret, i) => unitLeaf(i + 1, secret))
  const tree = SimpleMerkleTree.of(leaves)
  return {
    secrets,
    leaves,
    root: tree.root,
    secret: (serial: number) => secrets[serial - 1],
    proof: (serial: number) => tree.getProof(leaves[serial - 1]),
  }
}

export const UnitStatus = { Invalid: 0n, Genuine: 1n, AlreadyClaimed: 2n, Recalled: 3n } as const
export const HolderStatus = { None: 0n, Pending: 1n, Acknowledged: 2n, Escalated: 3n } as const
