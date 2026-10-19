// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.34;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPersonhood} from "./interfaces/IPersonhood.sol";
import {ISystem, SYSTEM_ADDR} from "./interfaces/ISystem.sol";
import {IXcm, XCM_PRECOMPILE_ADDRESS} from "./interfaces/IXcm.sol";
import {Transfer, XcmProgram} from "./XcmProgram.sol";

/// @notice Personhood tier; the numeric value is the `IPersonhood` status it requires.
enum Tier {
    None,
    Lite,
    Full
}

/// @notice Amounts paid per drip: PAS in plancks, pUSD in base units.
struct TierConfig {
    bool enabled;
    uint128 pas;
    uint128 pusd;
}

/// @notice A chain the faucet pays to. Registered iff `pasTransfer != Transfer.None`. `remoteFee` (plancks) is the
///         part of the PAS that buys execution on the destination, `maxDeliveryFee` (plancks) the most the faucet
///         pays Asset Hub to send a drip there; `minPas` and `minPusd` are the smallest drips it accepts.
struct Destination {
    uint32 id;
    bool enabled;
    Transfer pasTransfer;
    Transfer pusdTransfer;
    uint128 remoteFee;
    uint128 maxDeliveryFee;
    uint128 minPas;
    uint128 minPusd;
}

/// @title PaseoFaucet
/// @notice Pays PAS and pUSD at most once per person, tier and epoch to an `AccountId32` on Asset Hub or on a
///         registered destination chain. A person proves membership with a ring proof that `IPersonhood` verifies
///         against a context and a message the contract derives itself.
contract PaseoFaucet {
    bytes15 public constant DOMAIN = "paseo-faucet:v1";
    bytes28 public constant INDEX_MAGIC = 0x12e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f;
    uint32 public constant ASSET_HUB = 1000;
    uint32 public constant RELAY = XcmProgram.RELAY;

    IPersonhood public constant PERSONHOOD = IPersonhood(0x000000000000000000000000000000000a010000);
    ISystem public constant SYSTEM = ISystem(SYSTEM_ADDR);
    IXcm public constant XCM = IXcm(XCM_PRECOMPILE_ADDRESS);
    IERC20 public constant PUSD = IERC20(0x02FaF21d00000000000000000000000001200000);

    uint256 private constant WEI_PER_PLANCK = 1e8;

    uint64 public immutable epochSeconds;
    string public productId;

    address public owner;
    address public pendingOwner;
    address public pauser;
    bool public paused;
    uint32 public maxDripsPerEpoch;

    mapping(Tier tier => TierConfig) public tiers;
    mapping(uint64 epoch => uint32) public dripsInEpoch;
    mapping(uint64 epoch => mapping(Tier tier => mapping(bytes32 contextAlias => bool))) public hasClaimed;
    mapping(uint32 id => Destination) public destination;
    uint32[] private _destinationIds;

    event Dripped(
        uint64 indexed epoch,
        Tier tier,
        bytes32 contextAlias,
        uint32 indexed destinationId,
        bytes32 indexed recipient,
        uint128 pas,
        uint128 pusd
    );
    event TierUpdated(Tier indexed tier, TierConfig config);
    event EpochCapUpdated(uint32 maxDripsPerEpoch);
    event DestinationSet(uint32 indexed id, Destination entry);
    event DestinationDisabled(uint32 indexed id);
    event DestinationRemoved(uint32 indexed id);
    event Paused(address account);
    event Unpaused(address account);
    event PauserUpdated(address newPauser);
    event Withdrawn(address indexed to, uint128 pas, uint256 pusd);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error FaucetPaused();
    error TierDisabled();
    error UnknownDestination();
    error DestinationNotEnabled();
    error BelowDestinationMinimum();
    error EpochCapReached();
    error AlreadyClaimed();
    error InsufficientPas();
    error InsufficientPusd();
    error InvalidProof();
    error PayoutFailed();
    error NotOwner();
    error NotPauser();
    error InvalidConfig();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOwnerOrPauser() {
        if (msg.sender != owner && msg.sender != pauser) revert NotPauser();
        _;
    }

    constructor(string memory productId_, uint64 epochSeconds_) {
        if (bytes(productId_).length == 0 || epochSeconds_ == 0) revert InvalidConfig();
        productId = productId_;
        epochSeconds = epochSeconds_;
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    receive() external payable {}

    /// @notice Claims this epoch's drip for `tier` and pays it to `recipient` on `destinationId`.
    /// @param proof The SCALE-encoded ring proof (compact length prefix included), forwarded unchanged.
    function drip(
        Tier tier,
        uint32 destinationId,
        bytes32 recipient,
        bytes calldata proof,
        bytes32 contextAlias,
        uint32 ringIndex,
        uint32 revision
    ) external {
        if (paused) revert FaucetPaused();
        TierConfig memory t = tiers[tier];
        if (!t.enabled) revert TierDisabled();
        Destination memory d = _registered(destinationId);
        if (!d.enabled) revert DestinationNotEnabled();
        uint128 pusd = d.pusdTransfer == Transfer.None ? 0 : t.pusd;
        if (t.pas < d.minPas || pusd < d.minPusd) revert BelowDestinationMinimum();
        uint64 epoch = currentEpoch();
        if (dripsInEpoch[epoch] >= maxDripsPerEpoch) revert EpochCapReached();
        if (hasClaimed[epoch][tier][contextAlias]) revert AlreadyClaimed();
        if (address(this).balance < _maxOutflow(d, t.pas)) revert InsufficientPas();
        if (pusd != 0 && PUSD.balanceOf(address(this)) < pusd) revert InsufficientPusd();

        {
            IPersonhood.ProofVerificationRequest memory request;
            request.expectedStatus = uint8(tier);
            request.proof = proof;
            request.expectedAlias = contextAlias;
            request.ringIndex = ringIndex;
            request.context = contextFor(epoch);
            request.revision = revision;
            request.message = messageFor(epoch, destinationId, recipient);
            if (!PERSONHOOD.personhoodInfoByProof(request)) revert InvalidProof();
        }

        hasClaimed[epoch][tier][contextAlias] = true;
        ++dripsInEpoch[epoch];
        _pay(d, recipient, t.pas, pusd);
        emit Dripped(epoch, tier, contextAlias, destinationId, recipient, t.pas, pusd);
    }

    function setTier(Tier tier, TierConfig calldata config) external onlyOwner {
        if (tier == Tier.None) revert InvalidConfig();
        tiers[tier] = config;
        emit TierUpdated(tier, config);
    }

    function setMaxDripsPerEpoch(uint32 cap) external onlyOwner {
        maxDripsPerEpoch = cap;
        emit EpochCapUpdated(cap);
    }

    function setPauser(address newPauser) external onlyOwner {
        pauser = newPauser;
        emit PauserUpdated(newPauser);
    }

    function pause() external onlyOwnerOrPauser {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Adds a destination, or replaces the entry with the same id (re-enabling it included).
    function setDestination(Destination calldata entry) external onlyOwner {
        _validate(entry);
        if (destination[entry.id].pasTransfer == Transfer.None) _destinationIds.push(entry.id);
        destination[entry.id] = entry;
        emit DestinationSet(entry.id, entry);
    }

    function disableDestination(uint32 id) external onlyOwnerOrPauser {
        _registered(id).enabled = false;
        emit DestinationDisabled(id);
    }

    function removeDestination(uint32 id) external onlyOwner {
        _registered(id);
        delete destination[id];
        uint256 last = _destinationIds.length - 1;
        uint256 i;
        while (_destinationIds[i] != id) ++i;
        for (; i < last; ++i) {
            _destinationIds[i] = _destinationIds[i + 1];
        }
        _destinationIds.pop();
        emit DestinationRemoved(id);
    }

    /// @notice Sends `pas` plancks and `pusd` base units to the owner with plain transfers, independent of XCM.
    function withdraw(uint128 pas, uint256 pusd) external onlyOwner {
        if (pas != 0) {
            (bool sent,) = msg.sender.call{value: pas * WEI_PER_PLANCK}("");
            if (!sent) revert PayoutFailed();
        }
        if (pusd != 0 && !PUSD.transfer(msg.sender, pusd)) revert PayoutFailed();
        emit Withdrawn(msg.sender, pas, pusd);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }

    function currentEpoch() public view returns (uint64) {
        return uint64(block.timestamp / epochSeconds);
    }

    function nextEpochStart() external view returns (uint64) {
        return (currentEpoch() + 1) * epochSeconds;
    }

    /// @notice `blake2b_256("product/" ++ productId ++ "/" ++ u32_le(epoch) ++ INDEX_MAGIC)`, the context a host
    ///         derives for `{ productId, Index(epoch) }`.
    function contextFor(uint64 epoch) public view returns (bytes32) {
        return SYSTEM.hashBlake256(abi.encodePacked("product/", productId, "/", XcmProgram.le(epoch, 4), INDEX_MAGIC));
    }

    /// @notice The 87-byte message a proof must sign: domain, contract, chain id, epoch, destination, recipient.
    function messageFor(uint64 epoch, uint32 destinationId, bytes32 recipient) public view returns (bytes memory) {
        return abi.encodePacked(DOMAIN, address(this), uint64(block.chainid), epoch, destinationId, recipient);
    }

    function destinations() external view returns (Destination[] memory list) {
        list = new Destination[](_destinationIds.length);
        for (uint256 i; i < list.length; ++i) {
            list[i] = destination[_destinationIds[i]];
        }
    }

    /// @return pas Spendable plancks: the free balance minus the existential deposit.
    /// @return pusd pUSD base units held.
    function balances() external view returns (uint256 pas, uint256 pusd) {
        return (address(this).balance / WEI_PER_PLANCK, PUSD.balanceOf(address(this)));
    }

    /// @dev Reverts when the payout took more than `_maxOutflow`: the faucet pays the delivery fee, and Asset Hub
    ///      raises it while a destination's queue is congested.
    function _pay(Destination memory d, bytes32 recipient, uint128 pas, uint128 pusd) internal {
        bytes memory program = d.pasTransfer == Transfer.Local
            ? XcmProgram.deposit(recipient, pas, pusd)
            : XcmProgram.transfer(d.id, d.pasTransfer, d.pusdTransfer, d.remoteFee, recipient, pas, pusd);
        uint256 before = address(this).balance;
        try XCM.execute(program, XCM.weighMessage(program)) {}
        catch {
            revert PayoutFailed();
        }
        if (address(this).balance + _maxOutflow(d, pas) < before) revert PayoutFailed();
    }

    function _registered(uint32 id) internal view returns (Destination storage d) {
        d = destination[id];
        if (d.pasTransfer == Transfer.None) revert UnknownDestination();
    }

    /// @dev The most a payout of `pas` plancks to `d` may take from the faucet's balance, in wei.
    function _maxOutflow(Destination memory d, uint128 pas) private pure returns (uint256) {
        return (uint256(pas) + d.maxDeliveryFee) * WEI_PER_PLANCK;
    }

    /// @dev Only Asset Hub is paid locally and costs nothing beyond the drip; every other chain takes a remote fee
    ///      out of the PAS it receives and costs a delivery fee. `minPusd` is zero exactly when the destination takes
    ///      no pUSD.
    function _validate(Destination calldata d) private pure {
        bool valid = d.id == ASSET_HUB
            ? d.pasTransfer == Transfer.Local && !_isRemote(d.pusdTransfer) && d.remoteFee == 0 && d.maxDeliveryFee == 0
            : _isRemote(d.pasTransfer) && d.pusdTransfer != Transfer.Local && d.remoteFee != 0 && d.maxDeliveryFee != 0;
        if (!valid || d.minPas <= d.remoteFee || (d.pusdTransfer == Transfer.None) != (d.minPusd == 0)) {
            revert InvalidConfig();
        }
    }

    function _isRemote(Transfer kind) private pure returns (bool) {
        return kind == Transfer.Teleport || kind == Transfer.ReserveFromAssetHub;
    }
}
