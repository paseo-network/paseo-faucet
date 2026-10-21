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

/// @notice Why a claim left an enabled destination unpaid; `None` when it did not.
enum Skip {
    None,
    BelowMinimum,
    InsufficientPas,
    PayoutFailed
}

/// @title PaseoFaucet
/// @notice Pays PAS and pUSD at most once per person, tier, epoch and destination to an `AccountId32`, on Asset Hub
///         and on every enabled destination chain at once. A person proves membership with a ring proof that
///         `IPersonhood` verifies against a context and a message the contract derives itself.
contract PaseoFaucet {
    bytes15 public constant DOMAIN = "paseo-faucet:v2";
    bytes28 public constant INDEX_MAGIC = 0x12e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f;
    uint32 public constant ASSET_HUB = 1000;
    uint32 public constant RELAY = XcmProgram.RELAY;

    IPersonhood public constant PERSONHOOD = IPersonhood(0x000000000000000000000000000000000a010000);
    ISystem public constant SYSTEM = ISystem(SYSTEM_ADDR);
    IXcm public constant XCM = IXcm(XCM_PRECOMPILE_ADDRESS);
    IERC20 public constant PUSD = IERC20(0x02FaF21d00000000000000000000000001200000);

    uint256 private constant WEI_PER_PLANCK = 1e8;
    uint256 private constant MAX_DESTINATIONS = 256;

    uint64 public immutable epochSeconds;
    string public productId;

    address public owner;
    address public pendingOwner;
    address public pauser;
    bool public paused;
    uint32 public maxDripsPerEpoch;

    mapping(Tier tier => TierConfig) public tiers;
    mapping(uint64 epoch => uint32) public dripsInEpoch;
    mapping(uint32 id => Destination) public destination;
    /// @dev Every id ever registered, in registration order. An id keeps its index after removal: bit `i` of `_paid`
    ///      stands for `_destinationIds[i]`.
    uint32[] private _destinationIds;
    mapping(uint32 id => uint256) private _position;
    mapping(uint64 epoch => mapping(Tier tier => mapping(bytes32 contextAlias => uint256))) private _paid;

    event Dripped(
        uint64 indexed epoch,
        Tier tier,
        bytes32 contextAlias,
        uint32 indexed destinationId,
        bytes32 indexed recipient,
        uint128 pas,
        uint128 pusd
    );
    event DripSkipped(
        uint64 indexed epoch,
        Tier tier,
        bytes32 contextAlias,
        uint32 indexed destinationId,
        bytes32 indexed recipient,
        Skip reason
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
    error EpochCapReached();
    error AlreadyClaimed();
    error NothingToPay();
    error InvalidProof();
    error PayoutFailed();
    error NotOwner();
    error NotPauser();
    error NotSelf();
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

    /// @notice Claims this epoch's drip for `tier` and pays it to `recipient` on every enabled destination that has
    ///         not paid this alias yet. A destination that cannot be paid is skipped and stays claimable this epoch.
    /// @param proof The SCALE-encoded ring proof (compact length prefix included), forwarded unchanged.
    function drip(
        Tier tier,
        bytes32 recipient,
        bytes calldata proof,
        bytes32 contextAlias,
        uint32 ringIndex,
        uint32 revision
    ) external {
        (uint64 epoch, uint256 due) = _due(tier, contextAlias);
        IPersonhood.ProofVerificationRequest memory request;
        request.expectedStatus = uint8(tier);
        request.proof = proof;
        request.expectedAlias = contextAlias;
        request.ringIndex = ringIndex;
        request.context = contextFor(epoch);
        request.revision = revision;
        request.message = messageFor(epoch, recipient);
        if (!PERSONHOOD.personhoodInfoByProof(request)) revert InvalidProof();
        _drip(tier, epoch, contextAlias, recipient, due);
    }

    /// @notice Pays one destination's part of a drip. Only the faucet calls it, so that a failed payout reverts alone.
    function payLeg(Destination calldata d, bytes32 recipient, uint128 pas, uint128 pusd) external {
        if (msg.sender != address(this)) revert NotSelf();
        _pay(d, recipient, pas, pusd);
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

    /// @notice Adds a destination, or replaces the entry with the same id (re-enabling it included). An id keeps the
    ///         place it was first registered at; at most 256 ids can ever be registered.
    function setDestination(Destination calldata entry) external onlyOwner {
        _validate(entry);
        if (_position[entry.id] == 0) {
            if (_destinationIds.length == MAX_DESTINATIONS) revert InvalidConfig();
            _destinationIds.push(entry.id);
            _position[entry.id] = _destinationIds.length;
        }
        destination[entry.id] = entry;
        emit DestinationSet(entry.id, entry);
    }

    function disableDestination(uint32 id) external onlyOwnerOrPauser {
        _registered(id).enabled = false;
        emit DestinationDisabled(id);
    }

    /// @notice Deletes a destination. What it paid this epoch stays recorded, so adding it back pays nobody twice.
    function removeDestination(uint32 id) external onlyOwner {
        _registered(id);
        delete destination[id];
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

    /// @notice The 83-byte message a proof must sign: domain, contract, chain id, epoch, recipient.
    function messageFor(uint64 epoch, bytes32 recipient) public view returns (bytes memory) {
        return abi.encodePacked(DOMAIN, address(this), uint64(block.chainid), epoch, recipient);
    }

    /// @notice Whether `contextAlias` has been paid on destination `id` for `tier` in `epoch`.
    function hasClaimed(uint64 epoch, Tier tier, bytes32 contextAlias, uint32 id) external view returns (bool) {
        uint256 position = _position[id];
        return position != 0 && ((_paid[epoch][tier][contextAlias] >> (position - 1)) & 1) == 1;
    }

    /// @notice The registered destinations, in the order they were first registered.
    function destinations() external view returns (Destination[] memory list) {
        uint256 count;
        for (uint256 i; i < _destinationIds.length; ++i) {
            if (destination[_destinationIds[i]].pasTransfer != Transfer.None) ++count;
        }
        list = new Destination[](count);
        count = 0;
        for (uint256 i; i < _destinationIds.length; ++i) {
            Destination memory d = destination[_destinationIds[i]];
            if (d.pasTransfer != Transfer.None) list[count++] = d;
        }
    }

    /// @return pas Spendable plancks: the free balance minus the existential deposit.
    /// @return pusd pUSD base units held.
    function balances() external view returns (uint256 pas, uint256 pusd) {
        return (address(this).balance / WEI_PER_PLANCK, PUSD.balanceOf(address(this)));
    }

    /// @dev The checks that need no proof. Bit `i` of `due` is set for each enabled destination `_destinationIds[i]`
    ///      that has not paid `contextAlias` this epoch; at least one of them must be fundable.
    function _due(Tier tier, bytes32 contextAlias) internal view returns (uint64 epoch, uint256 due) {
        if (paused) revert FaucetPaused();
        TierConfig memory t = tiers[tier];
        if (!t.enabled) revert TierDisabled();
        epoch = currentEpoch();
        uint256 paid = _paid[epoch][tier][contextAlias];
        if (paid == 0 && dripsInEpoch[epoch] >= maxDripsPerEpoch) revert EpochCapReached();
        uint32[] memory ids = _destinationIds;
        bool fundable;
        for (uint256 i; i < ids.length; ++i) {
            if (!destination[ids[i]].enabled || ((paid >> i) & 1) == 1) continue;
            // forge-lint: disable-next-line(incorrect-shift)
            due |= 1 << i;
            if (!fundable) fundable = _skip(destination[ids[i]], t.pas) == Skip.None;
        }
        if (due == 0 && paid != 0) revert AlreadyClaimed();
        if (!fundable) revert NothingToPay();
    }

    /// @dev Records the claim, then pays each destination in `due` through `payLeg`. Reverts if it pays none.
    function _drip(Tier tier, uint64 epoch, bytes32 contextAlias, bytes32 recipient, uint256 due) internal {
        {
            uint256 paid = _paid[epoch][tier][contextAlias];
            if (paid == 0) ++dripsInEpoch[epoch];
            _paid[epoch][tier][contextAlias] = paid | due;
        }
        TierConfig memory t = tiers[tier];
        uint32[] memory ids = _destinationIds;
        uint256 skipped;
        for (uint256 i; (due >> i) != 0; ++i) {
            if (((due >> i) & 1) == 0) continue;
            Destination memory d = destination[ids[i]];
            uint128 pusd = _pusdFor(d, t.pusd);
            Skip reason = _leg(d, recipient, t.pas, pusd);
            if (reason == Skip.None) {
                emit Dripped(epoch, tier, contextAlias, d.id, recipient, t.pas, pusd);
            } else {
                // forge-lint: disable-next-line(incorrect-shift)
                skipped |= 1 << i;
                emit DripSkipped(epoch, tier, contextAlias, d.id, recipient, reason);
            }
        }
        if (skipped == due) revert PayoutFailed();
        if (skipped != 0) _paid[epoch][tier][contextAlias] ^= skipped;
    }

    /// @dev Pays `d` its part of a drip in a call of its own, so that a failure reverts only this payout.
    function _leg(Destination memory d, bytes32 recipient, uint128 pas, uint128 pusd) private returns (Skip) {
        Skip reason = _skip(d, pas);
        if (reason != Skip.None) return reason;
        try this.payLeg(d, recipient, pas, pusd) {
            return Skip.None;
        } catch {
            return Skip.PayoutFailed;
        }
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

    /// @dev Why a drip of `pas` plancks cannot be paid to `d` now.
    function _skip(Destination memory d, uint128 pas) private view returns (Skip) {
        if (pas < d.minPas) return Skip.BelowMinimum;
        if (address(this).balance < _maxOutflow(d, pas)) return Skip.InsufficientPas;
        return Skip.None;
    }

    /// @dev The tier's pUSD where `d` takes pUSD, the amount reaches its minimum and the faucet holds it; else none.
    function _pusdFor(Destination memory d, uint128 amount) private view returns (uint128) {
        if (d.pusdTransfer == Transfer.None || amount < d.minPusd || PUSD.balanceOf(address(this)) < amount) return 0;
        return amount;
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
