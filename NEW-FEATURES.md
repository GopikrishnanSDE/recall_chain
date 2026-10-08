# New features: scratch-code verification, claims and accountable recalls

This document explains the five features added to the project, how they use the blockchain, how to demo them, and what they cannot do. It uses one running example: a batch of **insulin pens** made in Hyderabad, moved by a Chennai distributor, and sold by a Madurai pharmacy to a patient, Ravi.

---

## The idea in one paragraph

A manufacturer registers each batch on the blockchain with **one fingerprint (a Merkle root)** covering every pack in it. Each pack carries a serial number and a secret code under a scratch panel. A patient can check the code against the batch fingerprint. The first valid check **claims** the pack for a key made on the patient's phone. If the batch is recalled, everyone who handled it must **confirm on-chain before a deadline**, the patient's app shows a recall alert, and a **closure report** shows how many packs were pulled back, how many are with reachable customers, and how many are unaccounted for.

## Batch vs unit

- **Batch**: one production run (e.g. 100,000 pens with the same batch number and expiry). In the contract a "product" *is* a batch.
- **Unit / pack**: one individual pen with its own serial number (1 to quantity).

Recalls happen per batch. Fakes and cloned codes happen per unit. The design stores one root per batch on-chain and checks units against it.

---

## Feature 1: Contract foundation

| Change | Why |
|---|---|
| `addProduct(name, description, quantity, merkleRoot)` | A batch now has a pack count and a fingerprint |
| `producerId` is recorded when the batch is created | Previously it stayed 0 until processing, so nobody knew who made it |
| Only that manufacturer can `processProduct` its batch | Another producer could process someone else's batch before |
| `listForSale` requires `sellerId == 0` | A second seller could silently overwrite the first one |
| `mapping(address => mapping(ROLE => id))` | Role checks are O(1) instead of looping over every actor |
| Registering the same wallet twice in one role reverts | A wallet can still hold several roles (useful for demos) |
| Every stage function reverts with `Batch recalled` after a recall | A recalled batch is frozen |

## Feature 3: Scratch-code verification

**Creating a batch (Order Materials page, producer wallet)**

1. The browser generates one random 32-byte secret per pack.
2. For each pack it computes the leaf `keccak256(keccak256(abi.encode(serial, secret)))`.
3. It builds a Merkle tree and sends only the **root** to `addProduct`.
4. It uploads the **leaves** (not the secrets) to the server. The server only accepts them if they rebuild the root that is on-chain.
5. The producer downloads a CSV of `serial, scratch code` for the printer. The secrets exist nowhere else.

**Checking a pack (Verify a Pack page, no wallet)**

The patient enters batch ID, serial and scratch code. The server finds the Merkle proof for that serial and calls the contract's free `unitStatus(...)` view, which recomputes the leaf from the secret and checks it against the on-chain root. Result: **Genuine**, **AlreadyClaimed**, **Recalled** or **Invalid**.

Because the contract checks the proof against the on-chain root, the server cannot make a fake code look genuine.

## Feature 9: Unit claim

- The first time a genuine pack is checked, the patient can press **Claim this pack**.
- The phone creates its own key pair (stored in the browser), signs a message saying "I claim batch X, serial Y", and the server **relays** the claim (`claimUnitFor`) and pays the gas.
- The contract verifies the code, the proof **and** the signature, then stores `claimant = phone key`. No name, phone number or email goes on-chain.
- Anyone who checks the same code later sees **"already used"** — the warning sign of a copied code.
- If a pack is claimed **before the batch reached a seller**, it is flagged (`claimedBeforeSale`) as possible theft or diversion.

## Feature 5: Recall with confirmation

- **Only the manufacturer that created the batch** can call `recall(batchId, reasonHash)`. Only a hash of the reason is stored.
- **Recalls are permanent.** There is no regulator role in this version, so nobody can safely lift one.
- Everyone who handled the batch (supplier, manufacturer, distributor, seller — a multi-role wallet counted once) becomes a **holder** with status *Pending*.
- Holders record the serials they pulled from stock with `quarantineUnits` (e.g. `1-20, 25`), then call `ackRecall`.
- After the deadline (`recallWindow`, default 24 hours, owner can shorten to 60 seconds for a demo), **anyone** can `escalate` a holder who did not confirm. The miss is counted in `missedRecalls[holder]` permanently. A late confirmation is still accepted and marked late.
- Recalled packs can no longer be claimed, and every scan shows **Recalled — do not use**.

## Feature 10: Recall closure report

`closureReport(batchId)` returns, for a batch:

| Field | Meaning |
|---|---|
| quantity | packs in the batch |
| quarantined | packs holders pulled from stock |
| claimed | packs with customers who can be alerted |
| claimedBeforeSale | of those, claimed before reaching a seller |
| unaccounted | quantity − quarantined − claimed |
| holdersTotal / Acknowledged / Escalated / Pending | who has and has not confirmed |

A pack is in exactly one state (none, claimed or quarantined), so the three counts always add up to the quantity. The Recalls page shows this as four numbers and a bar.

**Patients learn about a recall** on the Verify page: it remembers the packs claimed on that device, re-checks them every 30 seconds while open, and shows a red alert. A recall check by batch + serial (no scratch code needed) is also available.

---

## What lives where

| On-chain (contract) | Server (`server/data/*.json`) | Only in the browser / on paper |
|---|---|---|
| Batch root, quantity, manufacturer | Leaf hashes of each batch | Scratch secrets (CSV → printer) |
| Unit state and claimant key | | Customer private key (phone) |
| Recall state, deadline, holders, confirmations, escalations | | List of claimed packs (phone) |

---

## Demo script (about 10 minutes)

Use separate MetaMask accounts for the roles (or one account registered in several roles).

1. **Owner** → Register Roles: register a supplier, producer, distributor and seller.
2. **Owner** → Recalls: set the recall window to `60` seconds.
3. **Producer** → Order Materials: create "Insulin pen", 30 packs. Download the codes CSV. The badge shows *Fingerprints saved*.
4. Supply Materials: move batch 1 through supplier → producer → distributor → seller (each with its wallet).
5. **Patient** (any browser, no wallet) → Verify a Pack: enter batch 1, serial 5 and the code from the CSV → *Genuine* → **Claim this pack**.
6. Open Verify in a private window and check the same code → *already used* warning (cloned-code detection).
7. Enter a wrong code → *Not genuine*.
8. **Producer** → Recalls: recall batch 1 with a reason.
9. **Seller** → Recalls: quarantine `1-12, 20`, then *Confirm recall handled*. (Serial 5 is skipped — it is with the patient.)
10. **Patient** → Verify a Pack: the red *Recall alert* appears for serial 5.
11. Wait 60 seconds → any wallet → Recalls → **Escalate** a holder who did not confirm.
12. Show the closure report: 12 quarantined, 1 with a customer, 17 unaccounted, 1 holder escalated.

---

## Honest limitations (say these in the viva)

- **The chain records what people report.** A pharmacy can claim it quarantined packs without doing it. Spot checks and penalties are the real-world answer.
- **A cloned code verifies once.** The second checker is warned, but the system cannot tell which box is real.
- **A thief who scratches a genuine pack before sale owns the claim.** It is flagged as *claimed before sale*, and later checks show *already used*.
- **Customers who never claim cannot be alerted.** The closure report makes that number visible but cannot shrink it.
- **The relayer sees the scratch code** when it relays a claim, so customers must trust it not to claim the pack for itself. Customers can call `claimUnit` from their own wallet instead. A commit-reveal scheme would remove this trust.
- **Leaked secrets defeat Feature 3** for that batch. The CSV must be handled like a password list.
- **Gas.** Quarantining costs about 23,000 gas per pack (see RESULTS.md). That is free on Ganache but expensive on a public chain; a production design would batch serials into Merkle commitments.
- **Patients' phones cannot reach a local chain.** For a real mobile demo, deploy to a testnet and host the server.
