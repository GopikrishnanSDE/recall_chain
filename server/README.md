# MedChain server

A small Express service that supports scratch-code verification (Feature 3) and customer claims (Feature 9).

It **never sees or stores scratch secrets at rest**. It stores only the leaf hashes of each batch, in `data/batch-<chainId>-<contract>-<batchId>.json`, and only accepts them if they rebuild the Merkle root recorded on-chain.

## Run

```bash
npm install
npm start            # http://localhost:4000
```

The contract must be compiled and deployed first (from `backend/`), because the server reads the ABI from `client/src/artifacts` and the address from `client/src/deployments.json`.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `RPC_URL` | `http://127.0.0.1:7545` | Blockchain RPC (Ganache). Use `http://127.0.0.1:8545` for `npx hardhat node` |
| `RELAYER_ACCOUNT_INDEX` | `9` | Which unlocked node account pays gas for relayed customer claims |
| `RELAYER_PRIVATE_KEY` | — | Use this key instead of an unlocked account (needed on a testnet) |
| `CONTRACT_ADDRESS` | from `deployments.json` | Override the contract address |
| `DATA_DIR` | `./data` | Where batch fingerprint files are stored |

PowerShell example: `$env:RPC_URL="http://127.0.0.1:8545"; npm start`

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Chain ID, contract and relayer address |
| POST | `/api/batches/:id/leaves` | Manufacturer uploads leaf hashes `{ leaves: [...] }` (serial order) |
| GET | `/api/batches/:id` | Batch info and whether codes were uploaded |
| GET | `/api/batches/:id/proof/:serial` | Merkle proof for one pack |
| POST | `/api/verify` | `{ productId, serial, secret }` → Genuine / AlreadyClaimed / Recalled / Invalid (read-only) |
| GET | `/api/units/:id/:serial` | Public pack status (claimed? recalled?) without the scratch code |
| GET | `/api/claim-digest?productId&serial&claimant` | Message the customer's key signs |
| POST | `/api/claim` | `{ productId, serial, secret, claimant, signature }` → relays `claimUnitFor` |

## Trust notes

- The contract checks every proof against the on-chain root, so the server cannot make a fake code look genuine. If the server is down, verification is unavailable but nothing false can be shown.
- When relaying a claim the server sees the scratch code. A dishonest server could claim the pack for itself instead. Customers who want to avoid this can call `claimUnit` from their own wallet.
- If you restart Ganache and redeploy, re-create batches. Old fingerprint files are ignored automatically when they no longer match the on-chain root.
