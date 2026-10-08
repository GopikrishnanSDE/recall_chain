import Web3, { type ContractAbi } from 'web3'
import { SupplyChainArtifact } from './contracts'
import deployments from '../deployments.json'

/** Minimal EIP-1193 provider shape (MetaMask). */
export interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>
  on: (event: string, handler: (...args: never[]) => void) => void
  removeListener: (event: string, handler: (...args: never[]) => void) => void
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
    web3?: Web3
  }
}

export const loadWeb3 = async (): Promise<boolean> => {
  try {
    if (window.ethereum) {
      window.web3 = new Web3(window.ethereum)
      await window.ethereum.request({ method: 'eth_requestAccounts' })
      return true
    } else if (window.web3) {
      window.web3 = new Web3(window.web3.currentProvider)
      return true
    } else {
      return false
    }
  } catch (error) {
    console.error('Failed to initialize Web3:', error)
    return false
  }
}

const hasWeb3Api = (web3: Web3 | undefined): web3 is Web3 =>
  Boolean(web3?.eth && typeof web3.eth.getChainId === 'function')

let web3Initialization: Promise<boolean> | null = null

const ensureWeb3 = async (): Promise<boolean> => {
  if (hasWeb3Api(window.web3)) return true
  web3Initialization ??= loadWeb3().finally(() => {
    web3Initialization = null
  })
  return web3Initialization
}

export const getActiveAccount = async (): Promise<string> => {
  if (!window.ethereum) {
    throw new Error('MetaMask is not installed')
  }

  // First try without prompting the user.
  const existing = (await window.ethereum.request({ method: 'eth_accounts' })) as string[]
  if (existing && existing.length > 0) return existing[0]

  // If not connected yet, request access (prompts MetaMask).
  const requested = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[]
  if (requested && requested.length > 0) return requested[0]

  throw new Error('No active account found. Please connect MetaMask.')
}

export const getContract = async () => {
  if (!hasWeb3Api(window.web3)) {
    const initialized = await ensureWeb3()
    if (!initialized) {
      throw new Error('MetaMask is not installed or connected. Please install MetaMask, then refresh the page and try again.')
    }
  }

  const web3 = window.web3
  if (!hasWeb3Api(web3)) {
    throw new Error('Web3 is not available. Please connect MetaMask, then refresh the page and try again.')
  }
  // Use EIP-155 chainId (NOT "network id") to match deployments.json keys.
  // Ganache commonly reports network id 5777 while chainId is 1337 (or vice versa).
  const chainId = await web3.eth.getChainId()
  const chainIdStr = chainId.toString()
  const networkData = deployments.networks[chainIdStr as keyof typeof deployments.networks]

  if (networkData && networkData.SupplyChain && networkData.SupplyChain.address) {
    const contract = new web3.eth.Contract(SupplyChainArtifact.abi as ContractAbi, networkData.SupplyChain.address)
    return { contract, web3 }
  } else {
    // Get available networks from deployments
    const availableNetworks = Object.keys(deployments.networks).join(', ')
    throw new Error(
      `Contract not found on chainId ${chainIdStr}.\n\n` +
      `Available networks: ${availableNetworks}\n` +
      `Please switch MetaMask to one of these networks or deploy the contract to chainId ${chainIdStr}.\n\n` +
      `To deploy: npx hardhat run scripts/deploy.ts --network <network>`
    )
  }
}

// chainId 1337 is used by both `npx hardhat node` (localhost, port 8545) and Ganache
// (port 7545) in this project's hardhat.config.ts, so it cannot be inferred from the
// chainId alone. NEXT_PUBLIC_RPC_URL overrides the default for whichever one you run.
const RPC_URLS_BY_CHAIN: Record<number, string> = {
  1337: process.env.NEXT_PUBLIC_RPC_URL || 'http://127.0.0.1:8545',
  5777: 'http://127.0.0.1:7545',
}

export const switchToNetwork = async (chainId: string | number) => {
  if (!window.ethereum) {
    throw new Error('MetaMask is not installed')
  }

  const chainIdNum = Number(chainId)
  const chainIdHex = `0x${chainIdNum.toString(16)}`
  const rpcUrl = RPC_URLS_BY_CHAIN[chainIdNum] || 'http://127.0.0.1:8545'

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }],
    })
  } catch (switchError: unknown) {
    // This error code indicates that the chain has not been added to MetaMask
    if ((switchError as { code?: number })?.code === 4902) {
      // Try to add the network
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chainIdHex,
              chainName: chainIdNum === 5777 ? 'Ganache Local' : 'Hardhat Local',
              nativeCurrency: {
                name: 'ETH',
                symbol: 'ETH',
                decimals: 18,
              },
              rpcUrls: [rpcUrl],
            },
          ],
        })
      } catch {
        throw new Error('Failed to add network to MetaMask')
      }
    } else {
      throw switchError
    }
  }
}

