import { expect } from 'chai'
import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { HolderStatus, UnitStatus, makeBatch, unitLeaf } from './helpers'

describe('SupplyChain', () => {
  async function deployFixture() {
    const [owner, supplier, producer, distributor, seller, other, customer, relayer, producer2, seller2] =
      await ethers.getSigners()
    const SupplyChain = await ethers.getContractFactory('SupplyChain')
    const supplyChain = await SupplyChain.deploy()
    await supplyChain.waitForDeployment()

    return { supplyChain, owner, supplier, producer, distributor, seller, other, customer, relayer, producer2, seller2 }
  }

  async function registeredFixture() {
    const f = await deployFixture()
    const { supplyChain, owner, supplier, producer, distributor, seller } = f
    await supplyChain.connect(owner).addSupplier(supplier.address, 'Acme Supply', 'City')
    await supplyChain.connect(owner).addProducer(producer.address, 'Fab Inc', 'City')
    await supplyChain.connect(owner).addDistributor(distributor.address, 'LogiCo', 'City')
    await supplyChain.connect(owner).addSeller(seller.address, 'Retail One', 'City')
    return f
  }

  /** Registered roles plus one batch of `quantity` packs created by `producer`. */
  async function batchFixture(quantity = 10) {
    const f = await registeredFixture()
    const batch = makeBatch(quantity)
    await f.supplyChain.connect(f.producer).addProduct('Insulin pen', 'Batch B-117', quantity, batch.root)
    return { ...f, batch }
  }

  async function moveToSeller(f: Awaited<ReturnType<typeof batchFixture>>, id = 1) {
    await f.supplyChain.connect(f.supplier).supplyProduct(id)
    await f.supplyChain.connect(f.producer).processProduct(id)
    await f.supplyChain.connect(f.distributor).distributeProduct(id)
    await f.supplyChain.connect(f.seller).listForSale(id)
  }

  // -------------------------------------------------------------------------
  // Original behaviour (kept, adapted to the new addProduct signature)
  // -------------------------------------------------------------------------
  describe('original flow', () => {
    const root = makeBatch(4).root

    it('sets the deployer as owner', async () => {
      const { supplyChain, owner } = await deployFixture()
      expect(await supplyChain.owner()).to.equal(owner.address)
    })

    it('rejects role registration from non-owners', async () => {
      const { supplyChain, supplier } = await deployFixture()
      await expect(
        supplyChain.connect(supplier).addSupplier(supplier.address, 'Acme Supply', 'City'),
      ).to.be.revertedWith('Only owner')
      expect(await supplyChain.supplierCtr()).to.equal(0n)
    })

    it('reverts addProduct when roles are not registered', async () => {
      const { supplyChain, producer } = await deployFixture()
      await expect(supplyChain.connect(producer).addProduct('Insulin pen', 'Batch A', 4, root)).to.be.revertedWith(
        'All roles required',
      )
    })

    it('reverts addProduct for owner when owner is not a registered producer', async () => {
      const { supplyChain, owner } = await registeredFixture()
      await expect(supplyChain.connect(owner).addProduct('Insulin pen', 'Batch A', 4, root)).to.be.revertedWith(
        'Not producer',
      )
    })

    it('allows producer to add a product after registering all roles', async () => {
      const { supplyChain, producer } = await registeredFixture()
      await expect(supplyChain.connect(producer).addProduct('Insulin pen', 'Batch A', 4, root)).to.not.be.reverted
      expect(await supplyChain.productCtr()).to.equal(1n)
      const product = await supplyChain.ProductStock(1)
      expect(product.name).to.equal('Insulin pen')
      expect(product.description).to.equal('Batch A')
    })

    it('progresses through supply chain stages with the correct roles', async () => {
      const f = await batchFixture()
      await moveToSeller(f)
      await f.supplyChain.connect(f.seller).markProductSold(1)
      expect(await f.supplyChain.showStage(1)).to.equal('Product Sold')
    })

    it('reverts when a non-supplier tries to supply a product', async () => {
      const { supplyChain, producer } = await batchFixture()
      await expect(supplyChain.connect(producer).supplyProduct(1)).to.be.revertedWith('Not supplier')
      expect(await supplyChain.showStage(1)).to.equal('Product Created')
    })

    it('rejects out-of-order stage transitions without changing the product stage', async () => {
      const { supplyChain, producer, seller } = await batchFixture()
      await expect(supplyChain.connect(producer).processProduct(1)).to.be.revertedWith('Wrong stage')
      expect(await supplyChain.showStage(1)).to.equal('Product Created')
      await expect(supplyChain.connect(seller).listForSale(1)).to.be.revertedWith('Wrong stage')
      expect(await supplyChain.showStage(1)).to.equal('Product Created')
    })
  })

  // -------------------------------------------------------------------------
  // Feature 1: foundation fixes
  // -------------------------------------------------------------------------
  describe('Feature 1 — foundation', () => {
    it('records the manufacturer, quantity and merkle root at creation', async () => {
      const { supplyChain, producer, batch } = await batchFixture(10)
      const p = await supplyChain.ProductStock(1)
      expect(p.producerId).to.equal(1n)
      expect(p.quantity).to.equal(10n)
      expect(p.merkleRoot).to.equal(batch.root)
      expect(await supplyChain.actorId(producer.address, 2)).to.equal(1n) // ROLE.PRODUCER
    })

    it('emits BatchRegistered with the batch details', async () => {
      const { supplyChain, producer } = await registeredFixture()
      const batch = makeBatch(3)
      await expect(supplyChain.connect(producer).addProduct('Insulin pen', 'B', 3, batch.root))
        .to.emit(supplyChain, 'BatchRegistered')
        .withArgs(1n, producer.address, 3n, batch.root)
    })

    it('rejects a zero quantity, an oversized quantity or a missing root', async () => {
      const { supplyChain, producer } = await registeredFixture()
      const root = makeBatch(2).root
      await expect(supplyChain.connect(producer).addProduct('X', 'Y', 0, root)).to.be.revertedWith('Invalid quantity')
      await expect(supplyChain.connect(producer).addProduct('X', 'Y', 1_000_001, root)).to.be.revertedWith(
        'Invalid quantity',
      )
      await expect(supplyChain.connect(producer).addProduct('X', 'Y', 2, ethers.ZeroHash)).to.be.revertedWith(
        'Missing merkle root',
      )
    })

    it('blocks registering the same wallet twice in one role but allows multiple roles', async () => {
      const { supplyChain, owner, supplier } = await registeredFixture()
      await expect(supplyChain.connect(owner).addSupplier(supplier.address, 'Again', 'City')).to.be.revertedWith(
        'Already registered',
      )
      await expect(supplyChain.connect(owner).addSeller(supplier.address, 'Also a seller', 'City')).to.not.be.reverted
    })

    it('only the batch manufacturer can process its batch', async () => {
      const { supplyChain, owner, supplier, producer2 } = await batchFixture()
      await supplyChain.connect(owner).addProducer(producer2.address, 'Other Pharma', 'City')
      await supplyChain.connect(supplier).supplyProduct(1)
      await expect(supplyChain.connect(producer2).processProduct(1)).to.be.revertedWith('Not batch manufacturer')
    })

    it('a second seller cannot take over a listed batch', async () => {
      const f = await batchFixture()
      await f.supplyChain.connect(f.owner).addSeller(f.seller2.address, 'Retail Two', 'City')
      await moveToSeller(f)
      await expect(f.supplyChain.connect(f.seller2).listForSale(1)).to.be.revertedWith('Already listed')
      expect((await f.supplyChain.ProductStock(1)).sellerId).to.equal(1n)
    })
  })

  // -------------------------------------------------------------------------
  // Feature 3: scratch-code verification
  // -------------------------------------------------------------------------
  describe('Feature 3 — scratch-code verification', () => {
    it('contract leaf formula matches the off-chain formula', async () => {
      const { supplyChain, batch } = await batchFixture(5)
      expect(await supplyChain.unitLeaf(3, batch.secret(3))).to.equal(unitLeaf(3, batch.secret(3)))
    })

    it('reports a genuine pack as Genuine', async () => {
      const { supplyChain, batch } = await batchFixture(10)
      const [status, claimant] = await supplyChain.unitStatus(1, 7, batch.secret(7), batch.proof(7))
      expect(status).to.equal(UnitStatus.Genuine)
      expect(claimant).to.equal(ethers.ZeroAddress)
    })

    it('reports wrong secret, wrong serial, out-of-range serial and unknown batch as Invalid', async () => {
      const { supplyChain, batch } = await batchFixture(10)
      const fake = ethers.hexlify(ethers.randomBytes(32))
      expect((await supplyChain.unitStatus(1, 7, fake, batch.proof(7)))[0]).to.equal(UnitStatus.Invalid)
      expect((await supplyChain.unitStatus(1, 6, batch.secret(7), batch.proof(7)))[0]).to.equal(UnitStatus.Invalid)
      expect((await supplyChain.unitStatus(1, 11, batch.secret(7), batch.proof(7)))[0]).to.equal(UnitStatus.Invalid)
      expect((await supplyChain.unitStatus(1, 0, batch.secret(7), batch.proof(7)))[0]).to.equal(UnitStatus.Invalid)
      expect((await supplyChain.unitStatus(99, 7, batch.secret(7), batch.proof(7)))[0]).to.equal(UnitStatus.Invalid)
    })

    it('a code from one batch does not verify against another batch', async () => {
      const { supplyChain, producer, batch } = await batchFixture(10)
      const other = makeBatch(10)
      await supplyChain.connect(producer).addProduct('Insulin pen', 'Batch B-118', 10, other.root)
      expect((await supplyChain.unitStatus(2, 7, batch.secret(7), batch.proof(7)))[0]).to.equal(UnitStatus.Invalid)
    })

    it('knowing a neighbour leaf from a proof does not let anyone claim that neighbour', async () => {
      const { supplyChain, customer, batch } = await batchFixture(2)
      // With 2 leaves, the proof for serial 1 is exactly serial 2's leaf hash.
      const neighbourLeaf = batch.proof(1)[0]
      expect(neighbourLeaf).to.equal(batch.leaves[1])
      await expect(supplyChain.connect(customer).claimUnit(1, 2, neighbourLeaf, batch.proof(2))).to.be.revertedWith(
        'Invalid code',
      )
    })
  })

  // -------------------------------------------------------------------------
  // Feature 9: unit claim
  // -------------------------------------------------------------------------
  describe('Feature 9 — unit claim', () => {
    it('first valid check claims the pack; a second claim is rejected and shows AlreadyClaimed', async () => {
      const f = await batchFixture(10)
      await moveToSeller(f)
      await expect(f.supplyChain.connect(f.customer).claimUnit(1, 4, f.batch.secret(4), f.batch.proof(4)))
        .to.emit(f.supplyChain, 'UnitClaimed')
        .withArgs(1n, 4n, f.customer.address, false)

      const [status, claimant] = await f.supplyChain.unitStatus(1, 4, f.batch.secret(4), f.batch.proof(4))
      expect(status).to.equal(UnitStatus.AlreadyClaimed)
      expect(claimant).to.equal(f.customer.address)

      await expect(
        f.supplyChain.connect(f.other).claimUnit(1, 4, f.batch.secret(4), f.batch.proof(4)),
      ).to.be.revertedWith('Already claimed')
      expect(await f.supplyChain.claimedCount(1)).to.equal(1n)
    })

    it('a relayer can submit a claim signed by the customer key', async () => {
      const f = await batchFixture(10)
      await moveToSeller(f)
      const customerKey = ethers.Wallet.createRandom() // phone-generated key, holds no ETH
      const digest = await f.supplyChain.claimDigest(1, 5, customerKey.address)
      const signature = await customerKey.signMessage(ethers.getBytes(digest))

      await f.supplyChain
        .connect(f.relayer)
        .claimUnitFor(1, 5, f.batch.secret(5), f.batch.proof(5), customerKey.address, signature)
      expect((await f.supplyChain.units(1, 5)).claimant).to.equal(customerKey.address)
    })

    it('rejects a relayed claim whose signature does not match the claimant or the serial', async () => {
      const f = await batchFixture(10)
      const customerKey = ethers.Wallet.createRandom()
      const digest = await f.supplyChain.claimDigest(1, 5, customerKey.address)
      const signature = await customerKey.signMessage(ethers.getBytes(digest))

      await expect(
        f.supplyChain.connect(f.relayer).claimUnitFor(1, 5, f.batch.secret(5), f.batch.proof(5), f.relayer.address, signature),
      ).to.be.revertedWith('Bad signature')
      await expect(
        f.supplyChain.connect(f.relayer).claimUnitFor(1, 6, f.batch.secret(6), f.batch.proof(6), customerKey.address, signature),
      ).to.be.revertedWith('Bad signature')
    })

    it('flags claims made before the batch reached a seller (possible theft)', async () => {
      const f = await batchFixture(10)
      await f.supplyChain.connect(f.customer).claimUnit(1, 1, f.batch.secret(1), f.batch.proof(1))
      expect((await f.supplyChain.units(1, 1)).claimedBeforeSale).to.equal(true)
      expect(await f.supplyChain.claimedBeforeSaleCount(1)).to.equal(1n)

      await moveToSeller(f)
      await f.supplyChain.connect(f.customer).claimUnit(1, 2, f.batch.secret(2), f.batch.proof(2))
      expect((await f.supplyChain.units(1, 2)).claimedBeforeSale).to.equal(false)
      expect(await f.supplyChain.claimedBeforeSaleCount(1)).to.equal(1n)
    })
  })

  // -------------------------------------------------------------------------
  // Feature 5: recall with confirmation
  // -------------------------------------------------------------------------
  describe('Feature 5 — recall with confirmation', () => {
    const reason = ethers.id('Sterility failure in QC re-test')

    it('only the manufacturer that created the batch can recall it', async () => {
      const f = await batchFixture()
      await f.supplyChain.connect(f.owner).addProducer(f.producer2.address, 'Other Pharma', 'City')
      await expect(f.supplyChain.connect(f.owner).recall(1, reason)).to.be.revertedWith('Only batch manufacturer')
      await expect(f.supplyChain.connect(f.producer2).recall(1, reason)).to.be.revertedWith('Only batch manufacturer')
      await expect(f.supplyChain.connect(f.seller).recall(1, reason)).to.be.revertedWith('Only batch manufacturer')
      await expect(f.supplyChain.connect(f.producer).recall(1, reason)).to.emit(f.supplyChain, 'BatchRecalled')
      await expect(f.supplyChain.connect(f.producer).recall(1, reason)).to.be.revertedWith('Already recalled')
    })

    it('freezes the batch: no stage changes, no claims, and every scan shows Recalled', async () => {
      const f = await batchFixture(10)
      await moveToSeller(f)
      await f.supplyChain.connect(f.customer).claimUnit(1, 1, f.batch.secret(1), f.batch.proof(1))
      await f.supplyChain.connect(f.producer).recall(1, reason)

      await expect(f.supplyChain.connect(f.seller).markProductSold(1)).to.be.revertedWith('Batch recalled')
      await expect(
        f.supplyChain.connect(f.customer).claimUnit(1, 2, f.batch.secret(2), f.batch.proof(2)),
      ).to.be.revertedWith('Batch recalled')

      const claimed = await f.supplyChain.unitStatus(1, 1, f.batch.secret(1), f.batch.proof(1))
      expect(claimed[0]).to.equal(UnitStatus.Recalled)
      expect(claimed[1]).to.equal(f.customer.address)
      expect((await f.supplyChain.unitStatus(1, 2, f.batch.secret(2), f.batch.proof(2)))[0]).to.equal(
        UnitStatus.Recalled,
      )
      // A fake code is still reported as Invalid, not Recalled.
      expect(
        (await f.supplyChain.unitStatus(1, 2, ethers.hexlify(ethers.randomBytes(32)), f.batch.proof(2)))[0],
      ).to.equal(UnitStatus.Invalid)
    })

    it('makes everyone who handled the batch a holder, counting a multi-role wallet once', async () => {
      const f = await batchFixture()
      // The supplier wallet is also registered as the distributor.
      await f.supplyChain.connect(f.owner).addDistributor(f.supplier.address, 'Supplier Logistics', 'City')
      await f.supplyChain.connect(f.supplier).supplyProduct(1)
      await f.supplyChain.connect(f.producer).processProduct(1)
      await f.supplyChain.connect(f.supplier).distributeProduct(1)
      await f.supplyChain.connect(f.producer).recall(1, reason)

      const holders = await f.supplyChain.getRecallHolders(1)
      expect(holders).to.deep.equal([f.supplier.address, f.producer.address])
      expect(await f.supplyChain.holderStatus(1, f.seller.address)).to.equal(HolderStatus.None)
    })

    it('holders quarantine serials; claimed or repeated serials are skipped', async () => {
      const f = await batchFixture(10)
      await moveToSeller(f)
      await f.supplyChain.connect(f.customer).claimUnit(1, 3, f.batch.secret(3), f.batch.proof(3))
      await f.supplyChain.connect(f.producer).recall(1, reason)

      await expect(f.supplyChain.connect(f.seller).quarantineUnits(1, [1, 2, 3, 4]))
        .to.emit(f.supplyChain, 'UnitsQuarantined')
        .withArgs(1n, f.seller.address, 3n) // serial 3 is with a customer
      await f.supplyChain.connect(f.distributor).quarantineUnits(1, [4, 5])
      expect(await f.supplyChain.quarantinedCount(1)).to.equal(4n)
      expect((await f.supplyChain.units(1, 3)).state).to.equal(1n) // still Claimed
    })

    it('rejects quarantine by non-holders, before a recall, or with bad serials', async () => {
      const f = await batchFixture(10)
      await expect(f.supplyChain.connect(f.producer).quarantineUnits(1, [1])).to.be.revertedWith('Not recalled')
      await f.supplyChain.connect(f.producer).recall(1, reason)
      await expect(f.supplyChain.connect(f.other).quarantineUnits(1, [1])).to.be.revertedWith('Not a holder')
      await expect(f.supplyChain.connect(f.producer).quarantineUnits(1, [11])).to.be.revertedWith('Serial out of range')
      await expect(f.supplyChain.connect(f.producer).quarantineUnits(1, [])).to.be.revertedWith('Bad serial count')
    })

    it('enforces the deadline: escalation only after it, misses are recorded, late confirmations allowed', async () => {
      const f = await batchFixture(10)
      await moveToSeller(f)
      await f.supplyChain.connect(f.producer).recall(1, reason)

      await expect(f.supplyChain.connect(f.seller).ackRecall(1))
        .to.emit(f.supplyChain, 'RecallAcknowledged')
        .withArgs(1n, f.seller.address, false)
      await expect(f.supplyChain.connect(f.seller).ackRecall(1)).to.be.revertedWith('Not pending')
      await expect(f.supplyChain.connect(f.other).escalate(1, f.distributor.address)).to.be.revertedWith(
        'Deadline not passed',
      )

      await time.increase(24 * 60 * 60 + 1)
      await expect(f.supplyChain.connect(f.other).escalate(1, f.distributor.address))
        .to.emit(f.supplyChain, 'RecallEscalated')
        .withArgs(1n, f.distributor.address)
      expect(await f.supplyChain.missedRecalls(f.distributor.address)).to.equal(1n)
      await expect(f.supplyChain.connect(f.other).escalate(1, f.distributor.address)).to.be.revertedWith('Not pending')
      await expect(f.supplyChain.connect(f.other).escalate(1, f.seller.address)).to.be.revertedWith('Not pending')

      await expect(f.supplyChain.connect(f.distributor).ackRecall(1))
        .to.emit(f.supplyChain, 'RecallAcknowledged')
        .withArgs(1n, f.distributor.address, true)
      expect(await f.supplyChain.holderStatus(1, f.distributor.address)).to.equal(HolderStatus.Acknowledged)
    })

    it('lets only the owner shorten the recall window, down to 60 seconds', async () => {
      const f = await batchFixture()
      await expect(f.supplyChain.connect(f.producer).setRecallWindow(120)).to.be.revertedWith('Only owner')
      await expect(f.supplyChain.connect(f.owner).setRecallWindow(59)).to.be.revertedWith('Window too short')
      await f.supplyChain.connect(f.owner).setRecallWindow(120)
      await f.supplyChain.connect(f.producer).recall(1, reason)
      const r = await f.supplyChain.recalls(1)
      expect(r.deadline - r.recalledAt).to.equal(120n)
    })
  })

  // -------------------------------------------------------------------------
  // Feature 10: recall closure report
  // -------------------------------------------------------------------------
  describe('Feature 10 — recall closure report', () => {
    it('accounts for every pack after a recall', async () => {
      const f = await batchFixture(10)
      // Serial 1 is claimed before the batch reaches a seller (suspicious), 2 and 3 after.
      await f.supplyChain.connect(f.customer).claimUnit(1, 1, f.batch.secret(1), f.batch.proof(1))
      await moveToSeller(f)
      await f.supplyChain.connect(f.customer).claimUnit(1, 2, f.batch.secret(2), f.batch.proof(2))
      await f.supplyChain.connect(f.other).claimUnit(1, 3, f.batch.secret(3), f.batch.proof(3))

      await f.supplyChain.connect(f.producer).recall(1, ethers.id('Mislabelled strength'))
      await f.supplyChain.connect(f.seller).quarantineUnits(1, [3, 4, 5, 6, 7]) // 3 is skipped
      await f.supplyChain.connect(f.seller).ackRecall(1)
      await f.supplyChain.connect(f.producer).ackRecall(1)
      await time.increase(24 * 60 * 60 + 1)
      await f.supplyChain.escalate(1, f.supplier.address)

      const rep = await f.supplyChain.closureReport(1)
      expect(rep.recalled).to.equal(true)
      expect(rep.quantity).to.equal(10n)
      expect(rep.quarantined).to.equal(4n)
      expect(rep.claimed).to.equal(3n)
      expect(rep.claimedBeforeSale).to.equal(1n)
      expect(rep.unaccounted).to.equal(3n) // serials 8, 9, 10
      expect(rep.holdersTotal).to.equal(4n)
      expect(rep.holdersAcknowledged).to.equal(2n)
      expect(rep.holdersEscalated).to.equal(1n)
      expect(rep.holdersPending).to.equal(2n) // supplier (escalated) + distributor (still pending)
      expect(rep.quarantined + rep.claimed + rep.unaccounted).to.equal(rep.quantity)
    })

    it('reports a batch that is not recalled with everything unaccounted except claims', async () => {
      const f = await batchFixture(5)
      await f.supplyChain.connect(f.customer).claimUnit(1, 1, f.batch.secret(1), f.batch.proof(1))
      const rep = await f.supplyChain.closureReport(1)
      expect(rep.recalled).to.equal(false)
      expect(rep.claimed).to.equal(1n)
      expect(rep.unaccounted).to.equal(4n)
      expect(rep.holdersTotal).to.equal(0n)
      await expect(f.supplyChain.closureReport(2)).to.be.revertedWith('Invalid product id')
    })

    it('scales to a 1,000-pack batch with short proofs', async () => {
      const f = await registeredFixture()
      const batch = makeBatch(1000)
      await f.supplyChain.connect(f.producer).addProduct('Insulin pen', 'Large batch', 1000, batch.root)
      expect(batch.proof(777).length).to.be.lessThanOrEqual(10)
      await f.supplyChain.connect(f.customer).claimUnit(1, 777, batch.secret(777), batch.proof(777))
      await f.supplyChain.connect(f.producer).recall(1, ethers.id('test'))
      const serials = Array.from({ length: 200 }, (_, i) => i + 1)
      await f.supplyChain.connect(f.producer).quarantineUnits(1, serials)
      const rep = await f.supplyChain.closureReport(1)
      expect(rep.quarantined).to.equal(200n)
      expect(rep.unaccounted).to.equal(799n)
    })
  })
})
