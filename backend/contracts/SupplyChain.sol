// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title SupplyChain — medicine provenance ledger
 *
 * Built on the original role/stage flow (supplier -> producer -> distributor -> seller) and adds:
 *  - Feature 1  Foundation: O(1) role lookups, creator recorded at creation, re-listing bug fixed,
 *               batch quantity, recalled batches frozen.
 *  - Feature 3  Scratch-code unit verification: one Merkle root per batch; each pack carries a
 *               serial number plus a secret printed under a scratch layer.
 *  - Feature 5  Recall with confirmation: only the manufacturer that created the batch can recall it,
 *               every actor that handled the batch must confirm before a deadline, misses escalate.
 *               Recalls are permanent (there is no regulator role that could safely lift one).
 *  - Feature 9  Unit claim: the first valid scratch-code check binds the pack to the customer's key
 *               (no personal data on-chain). Claims can be relayed with the customer's signature.
 *  - Feature 10 Recall closure report: per batch, how many packs were quarantined, how many are with
 *               reachable (claimed) customers, and how many are unaccounted for.
 */
contract SupplyChain {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    // ---------------------------------------------------------------------
    // Roles, stages and products (original model, extended)
    // ---------------------------------------------------------------------

    enum ROLE {
        NONE,
        SUPPLIER,
        PRODUCER,
        DISTRIBUTOR,
        SELLER
    }

    enum STAGE {
        Created,
        Processing,
        InTransit,
        ForSale,
        Sold
    }

    uint256 public productCtr = 0;
    uint256 public supplierCtr = 0;
    uint256 public producerCtr = 0;
    uint256 public distributorCtr = 0;
    uint256 public sellerCtr = 0;

    /// @dev A product is a production batch. New fields are appended so existing readers keep working.
    struct Product {
        uint256 id;
        string name;
        string description;
        uint256 supplierId;
        uint256 producerId; // manufacturer that created the batch (set at creation)
        uint256 distributorId;
        uint256 sellerId;
        STAGE stage;
        uint256 quantity; // number of packs (serials 1..quantity)
        bytes32 merkleRoot; // root over all pack fingerprints
    }

    struct Actor {
        address addr;
        uint256 id;
        string name;
        string place;
        ROLE role;
    }

    mapping(uint256 => Product) public ProductStock;
    mapping(uint256 => Actor) public SUPPLIERS;
    mapping(uint256 => Actor) public PRODUCERS;
    mapping(uint256 => Actor) public DISTRIBUTORS;
    mapping(uint256 => Actor) public SELLERS;

    /// @dev address => role => actor id (0 = not registered). One wallet may hold several roles.
    mapping(address => mapping(ROLE => uint256)) private actorIdOf;

    event ActorAdded(uint256 indexed actorId, ROLE indexed role, address indexed actor, string name, string place);
    event ProductAdded(uint256 indexed productId, string name);
    event ProductStageUpdated(uint256 indexed productId, STAGE indexed stage);
    event BatchRegistered(uint256 indexed productId, address indexed manufacturer, uint256 quantity, bytes32 merkleRoot);

    uint256 public constant MAX_BATCH_QUANTITY = 1_000_000;

    // ---------------------------------------------------------------------
    // Units (Features 3 and 9)
    // ---------------------------------------------------------------------

    enum UnitState {
        None,
        Claimed,
        Quarantined
    }

    /// @dev Result of checking a scratch code.
    enum UnitStatus {
        Invalid, // code does not belong to this batch
        Genuine, // valid and not yet claimed
        AlreadyClaimed, // valid but someone already claimed this pack
        Recalled // valid but the batch is recalled - do not use
    }

    struct Unit {
        address claimant;
        UnitState state;
        bool claimedBeforeSale; // claimed before the batch reached a seller -> possible theft/diversion
    }

    mapping(uint256 => mapping(uint256 => Unit)) public units; // productId => serial => unit
    mapping(uint256 => uint256) public claimedCount;
    mapping(uint256 => uint256) public claimedBeforeSaleCount;
    mapping(uint256 => uint256) public quarantinedCount;

    event UnitClaimed(uint256 indexed productId, uint256 indexed serial, address indexed claimant, bool beforeSale);

    // ---------------------------------------------------------------------
    // Recalls (Features 5 and 10)
    // ---------------------------------------------------------------------

    enum HolderStatus {
        None,
        Pending,
        Acknowledged,
        Escalated
    }

    struct RecallInfo {
        bool active;
        address initiatedBy;
        uint64 recalledAt;
        uint64 deadline;
        bytes32 reasonHash;
        uint32 holdersAcknowledged;
        uint32 holdersEscalated;
    }

    struct ClosureReport {
        bool recalled;
        uint256 quantity;
        uint256 quarantined;
        uint256 claimed;
        uint256 claimedBeforeSale;
        uint256 unaccounted;
        uint256 holdersTotal;
        uint256 holdersAcknowledged;
        uint256 holdersEscalated;
        uint256 holdersPending;
        uint64 deadline;
    }

    /// @notice Time holders get to confirm a recall. Owner can shorten it for demos (minimum 60 seconds).
    uint64 public recallWindow = 1 days;

    mapping(uint256 => RecallInfo) public recalls;
    mapping(uint256 => address[]) private recallHolders;
    mapping(uint256 => mapping(address => HolderStatus)) public holderStatus;
    mapping(address => uint256) public missedRecalls;

    uint256 public constant MAX_QUARANTINE_PER_TX = 500;

    event RecallWindowUpdated(uint64 window);
    event BatchRecalled(uint256 indexed productId, address indexed manufacturer, bytes32 reasonHash, uint64 deadline);
    event UnitsQuarantined(uint256 indexed productId, address indexed holder, uint256 count);
    event RecallAcknowledged(uint256 indexed productId, address indexed holder, bool late);
    event RecallEscalated(uint256 indexed productId, address indexed holder);

    // ---------------------------------------------------------------------
    // Role registration
    // ---------------------------------------------------------------------

    function addActor(address _address, string memory _name, string memory _place, ROLE _role) public onlyOwner {
        require(_address != address(0), "Invalid address");
        require(_role != ROLE.NONE, "Invalid role");
        require(actorIdOf[_address][_role] == 0, "Already registered");

        uint256 newId;
        if (_role == ROLE.SUPPLIER) {
            newId = ++supplierCtr;
            SUPPLIERS[newId] = Actor(_address, newId, _name, _place, _role);
        } else if (_role == ROLE.PRODUCER) {
            newId = ++producerCtr;
            PRODUCERS[newId] = Actor(_address, newId, _name, _place, _role);
        } else if (_role == ROLE.DISTRIBUTOR) {
            newId = ++distributorCtr;
            DISTRIBUTORS[newId] = Actor(_address, newId, _name, _place, _role);
        } else {
            newId = ++sellerCtr;
            SELLERS[newId] = Actor(_address, newId, _name, _place, _role);
        }
        actorIdOf[_address][_role] = newId;
        emit ActorAdded(newId, _role, _address, _name, _place);
    }

    function addSupplier(address _address, string memory _name, string memory _place) public onlyOwner {
        addActor(_address, _name, _place, ROLE.SUPPLIER);
    }

    function addProducer(address _address, string memory _name, string memory _place) public onlyOwner {
        addActor(_address, _name, _place, ROLE.PRODUCER);
    }

    function addDistributor(address _address, string memory _name, string memory _place) public onlyOwner {
        addActor(_address, _name, _place, ROLE.DISTRIBUTOR);
    }

    function addSeller(address _address, string memory _name, string memory _place) public onlyOwner {
        addActor(_address, _name, _place, ROLE.SELLER);
    }

    /// @notice Actor id of `_address` for `_role` (0 when not registered).
    function actorId(address _address, ROLE _role) external view returns (uint256) {
        return actorIdOf[_address][_role];
    }

    function setRecallWindow(uint64 _window) external onlyOwner {
        require(_window >= 60, "Window too short");
        recallWindow = _window;
        emit RecallWindowUpdated(_window);
    }

    // ---------------------------------------------------------------------
    // Batch lifecycle
    // ---------------------------------------------------------------------

    modifier validProduct(uint256 _productId) {
        require(_productId > 0 && _productId <= productCtr, "Invalid product id");
        _;
    }

    modifier notRecalled(uint256 _productId) {
        require(!recalls[_productId].active, "Batch recalled");
        _;
    }

    /**
     * @notice Manufacturer creates a batch of `_quantity` packs.
     * @param _merkleRoot Root over leaves keccak256(bytes.concat(keccak256(abi.encode(serial, secret)))).
     */
    function addProduct(string memory _name, string memory _description, uint256 _quantity, bytes32 _merkleRoot)
        public
    {
        require(supplierCtr > 0 && producerCtr > 0 && distributorCtr > 0 && sellerCtr > 0, "All roles required");
        uint256 _producerId = findProducer(msg.sender);
        require(_producerId > 0, "Not producer");
        require(_quantity > 0 && _quantity <= MAX_BATCH_QUANTITY, "Invalid quantity");
        require(_merkleRoot != bytes32(0), "Missing merkle root");

        productCtr++;
        ProductStock[productCtr] = Product(
            productCtr, _name, _description, 0, _producerId, 0, 0, STAGE.Created, _quantity, _merkleRoot
        );
        emit ProductAdded(productCtr, _name);
        emit BatchRegistered(productCtr, msg.sender, _quantity, _merkleRoot);
    }

    function supplyProduct(uint256 _productId) public validProduct(_productId) notRecalled(_productId) {
        uint256 _id = findSupplier(msg.sender);
        require(_id > 0, "Not supplier");
        require(ProductStock[_productId].stage == STAGE.Created, "Wrong stage");
        ProductStock[_productId].supplierId = _id;
        ProductStock[_productId].stage = STAGE.Processing;
        emit ProductStageUpdated(_productId, STAGE.Processing);
    }

    function processProduct(uint256 _productId) public validProduct(_productId) notRecalled(_productId) {
        uint256 _id = findProducer(msg.sender);
        require(_id > 0, "Not producer");
        require(ProductStock[_productId].stage == STAGE.Processing, "Wrong stage");
        require(ProductStock[_productId].producerId == _id, "Not batch manufacturer");
        ProductStock[_productId].stage = STAGE.InTransit;
        emit ProductStageUpdated(_productId, STAGE.InTransit);
    }

    function distributeProduct(uint256 _productId) public validProduct(_productId) notRecalled(_productId) {
        uint256 _id = findDistributor(msg.sender);
        require(_id > 0, "Not distributor");
        require(ProductStock[_productId].stage == STAGE.InTransit, "Wrong stage");
        ProductStock[_productId].distributorId = _id;
        ProductStock[_productId].stage = STAGE.ForSale;
        emit ProductStageUpdated(_productId, STAGE.ForSale);
    }

    /// @notice A seller takes the batch. Fixed: a second seller can no longer overwrite the first.
    function listForSale(uint256 _productId) public validProduct(_productId) notRecalled(_productId) {
        uint256 _id = findSeller(msg.sender);
        require(_id > 0, "Not seller");
        require(ProductStock[_productId].stage == STAGE.ForSale, "Wrong stage");
        require(ProductStock[_productId].sellerId == 0, "Already listed");
        ProductStock[_productId].sellerId = _id;
        emit ProductStageUpdated(_productId, STAGE.ForSale);
    }

    function markProductSold(uint256 _productId) public validProduct(_productId) notRecalled(_productId) {
        uint256 _id = findSeller(msg.sender);
        require(_id > 0, "Not seller");
        require(_id == ProductStock[_productId].sellerId, "Wrong seller");
        require(ProductStock[_productId].stage == STAGE.ForSale, "Wrong stage");
        ProductStock[_productId].stage = STAGE.Sold;
        emit ProductStageUpdated(_productId, STAGE.Sold);
    }

    function showStage(uint256 _productId) public view returns (string memory) {
        require(productCtr > 0, "No products");
        STAGE stage = ProductStock[_productId].stage;
        if (stage == STAGE.Created) return "Product Created";
        if (stage == STAGE.Processing) return "Processing Stage";
        if (stage == STAGE.InTransit) return "In Transit Stage";
        if (stage == STAGE.ForSale) return "For Sale Stage";
        return "Product Sold";
    }

    // ---------------------------------------------------------------------
    // Feature 3 + 9: scratch-code verification and unit claim
    // ---------------------------------------------------------------------

    /// @notice Leaf for one pack. Computed off-chain identically when the batch is created.
    function unitLeaf(uint256 _serial, bytes32 _secret) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(_serial, _secret))));
    }

    /// @notice Message a customer signs (EIP-191 personal_sign over this 32-byte hash) to have a claim relayed.
    function claimDigest(uint256 _productId, uint256 _serial, address _claimant) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, _productId, _serial, _claimant));
    }

    function _isValidUnit(uint256 _productId, uint256 _serial, bytes32 _secret, bytes32[] calldata _proof)
        internal
        view
        returns (bool)
    {
        if (_productId == 0 || _productId > productCtr) return false;
        Product storage p = ProductStock[_productId];
        if (_serial == 0 || _serial > p.quantity) return false;
        return MerkleProof.verifyCalldata(_proof, p.merkleRoot, unitLeaf(_serial, _secret));
    }

    /// @notice Free read: is this scratch code genuine, already claimed, or recalled?
    function unitStatus(uint256 _productId, uint256 _serial, bytes32 _secret, bytes32[] calldata _proof)
        external
        view
        returns (UnitStatus status, address claimant)
    {
        if (!_isValidUnit(_productId, _serial, _secret, _proof)) return (UnitStatus.Invalid, address(0));
        Unit storage u = units[_productId][_serial];
        if (recalls[_productId].active) return (UnitStatus.Recalled, u.claimant);
        if (u.state != UnitState.None) return (UnitStatus.AlreadyClaimed, u.claimant);
        return (UnitStatus.Genuine, address(0));
    }

    /// @notice Customer claims a pack directly from their own wallet.
    function claimUnit(uint256 _productId, uint256 _serial, bytes32 _secret, bytes32[] calldata _proof) external {
        _claim(_productId, _serial, _secret, _proof, msg.sender);
    }

    /// @notice A relayer submits a claim on behalf of `_claimant`, who signed `claimDigest(...)`.
    function claimUnitFor(
        uint256 _productId,
        uint256 _serial,
        bytes32 _secret,
        bytes32[] calldata _proof,
        address _claimant,
        bytes calldata _signature
    ) external {
        require(_claimant != address(0), "Invalid claimant");
        bytes32 digest = ECDSA.toEthSignedMessageHash(claimDigest(_productId, _serial, _claimant));
        require(ECDSA.recover(digest, _signature) == _claimant, "Bad signature");
        _claim(_productId, _serial, _secret, _proof, _claimant);
    }

    function _claim(uint256 _productId, uint256 _serial, bytes32 _secret, bytes32[] calldata _proof, address _claimant)
        internal
    {
        require(_isValidUnit(_productId, _serial, _secret, _proof), "Invalid code");
        require(!recalls[_productId].active, "Batch recalled");
        Unit storage u = units[_productId][_serial];
        require(u.state == UnitState.None, "Already claimed");

        Product storage p = ProductStock[_productId];
        bool beforeSale = p.stage < STAGE.ForSale || p.sellerId == 0;

        u.claimant = _claimant;
        u.state = UnitState.Claimed;
        u.claimedBeforeSale = beforeSale;
        claimedCount[_productId]++;
        if (beforeSale) claimedBeforeSaleCount[_productId]++;

        emit UnitClaimed(_productId, _serial, _claimant, beforeSale);
    }

    // ---------------------------------------------------------------------
    // Feature 5: recall with confirmation
    // ---------------------------------------------------------------------

    /// @notice Only the manufacturer that created the batch can recall it. Recalls are permanent.
    function recall(uint256 _productId, bytes32 _reasonHash) external validProduct(_productId) {
        Product storage p = ProductStock[_productId];
        require(PRODUCERS[p.producerId].addr == msg.sender, "Only batch manufacturer");
        RecallInfo storage r = recalls[_productId];
        require(!r.active, "Already recalled");

        uint64 deadline = uint64(block.timestamp) + recallWindow;
        r.active = true;
        r.initiatedBy = msg.sender;
        r.recalledAt = uint64(block.timestamp);
        r.deadline = deadline;
        r.reasonHash = _reasonHash;

        // Everyone who handled the batch must confirm. A wallet holding several roles is counted once.
        _addHolder(_productId, p.supplierId == 0 ? address(0) : SUPPLIERS[p.supplierId].addr);
        _addHolder(_productId, PRODUCERS[p.producerId].addr);
        _addHolder(_productId, p.distributorId == 0 ? address(0) : DISTRIBUTORS[p.distributorId].addr);
        _addHolder(_productId, p.sellerId == 0 ? address(0) : SELLERS[p.sellerId].addr);

        emit BatchRecalled(_productId, msg.sender, _reasonHash, deadline);
    }

    function _addHolder(uint256 _productId, address _holder) private {
        if (_holder == address(0)) return;
        if (holderStatus[_productId][_holder] != HolderStatus.None) return;
        holderStatus[_productId][_holder] = HolderStatus.Pending;
        recallHolders[_productId].push(_holder);
    }

    function getRecallHolders(uint256 _productId) external view returns (address[] memory) {
        return recallHolders[_productId];
    }

    /// @notice A holder records the serial numbers of packs it has pulled from stock.
    /// Packs already claimed by customers or already quarantined are skipped.
    function quarantineUnits(uint256 _productId, uint256[] calldata _serials)
        external
        validProduct(_productId)
        returns (uint256 added)
    {
        require(recalls[_productId].active, "Not recalled");
        require(holderStatus[_productId][msg.sender] != HolderStatus.None, "Not a holder");
        require(_serials.length > 0 && _serials.length <= MAX_QUARANTINE_PER_TX, "Bad serial count");

        uint256 qty = ProductStock[_productId].quantity;
        for (uint256 i = 0; i < _serials.length; i++) {
            uint256 s = _serials[i];
            require(s > 0 && s <= qty, "Serial out of range");
            Unit storage u = units[_productId][s];
            if (u.state == UnitState.None) {
                u.state = UnitState.Quarantined;
                added++;
            }
        }
        quarantinedCount[_productId] += added;
        emit UnitsQuarantined(_productId, msg.sender, added);
    }

    /// @notice Holder confirms it has quarantined its stock. Allowed after escalation (recorded as late).
    function ackRecall(uint256 _productId) external validProduct(_productId) {
        RecallInfo storage r = recalls[_productId];
        require(r.active, "Not recalled");
        HolderStatus s = holderStatus[_productId][msg.sender];
        require(s == HolderStatus.Pending || s == HolderStatus.Escalated, "Not pending");

        bool late = s == HolderStatus.Escalated || block.timestamp > r.deadline;
        holderStatus[_productId][msg.sender] = HolderStatus.Acknowledged;
        r.holdersAcknowledged++;
        emit RecallAcknowledged(_productId, msg.sender, late);
    }

    /// @notice Anyone can escalate a holder that missed the deadline. The miss is recorded permanently.
    function escalate(uint256 _productId, address _holder) external validProduct(_productId) {
        RecallInfo storage r = recalls[_productId];
        require(r.active, "Not recalled");
        require(block.timestamp > r.deadline, "Deadline not passed");
        require(holderStatus[_productId][_holder] == HolderStatus.Pending, "Not pending");

        holderStatus[_productId][_holder] = HolderStatus.Escalated;
        r.holdersEscalated++;
        missedRecalls[_holder]++;
        emit RecallEscalated(_productId, _holder);
    }

    // ---------------------------------------------------------------------
    // Feature 10: recall closure report
    // ---------------------------------------------------------------------

    function closureReport(uint256 _productId)
        external
        view
        validProduct(_productId)
        returns (ClosureReport memory rep)
    {
        RecallInfo storage r = recalls[_productId];
        rep.recalled = r.active;
        rep.quantity = ProductStock[_productId].quantity;
        rep.quarantined = quarantinedCount[_productId];
        rep.claimed = claimedCount[_productId];
        rep.claimedBeforeSale = claimedBeforeSaleCount[_productId];
        rep.unaccounted = rep.quantity - rep.quarantined - rep.claimed; // a pack is in at most one state
        rep.holdersTotal = recallHolders[_productId].length;
        rep.holdersAcknowledged = r.holdersAcknowledged;
        rep.holdersEscalated = r.holdersEscalated;
        uint256 pending;
        for (uint256 i = 0; i < recallHolders[_productId].length; i++) {
            HolderStatus s = holderStatus[_productId][recallHolders[_productId][i]];
            if (s == HolderStatus.Pending || s == HolderStatus.Escalated) pending++;
        }
        rep.holdersPending = pending;
        rep.deadline = r.deadline;
    }

    // ---------------------------------------------------------------------
    // Role lookups (O(1), replaces the original linear scans)
    // ---------------------------------------------------------------------

    function findSupplier(address _address) private view returns (uint256) {
        return actorIdOf[_address][ROLE.SUPPLIER];
    }

    function findProducer(address _address) private view returns (uint256) {
        return actorIdOf[_address][ROLE.PRODUCER];
    }

    function findDistributor(address _address) private view returns (uint256) {
        return actorIdOf[_address][ROLE.DISTRIBUTOR];
    }

    function findSeller(address _address) private view returns (uint256) {
        return actorIdOf[_address][ROLE.SELLER];
    }
}
