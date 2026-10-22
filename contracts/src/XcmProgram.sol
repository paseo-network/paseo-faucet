// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.34;

/// @notice How a destination receives an asset. `Teleport` and `ReserveFromAssetHub` stay adjacent and in this
///         order: they map onto `AssetTransferFilter::Teleport` (0) and `AssetTransferFilter::ReserveDeposit` (1).
enum Transfer {
    None,
    Local,
    Teleport,
    ReserveFromAssetHub
}

/// @title XcmProgram
/// @notice SCALE-encoded `VersionedXcm::V5` programs that pay a drip from the faucet's account on Asset Hub.
/// @dev PAS is `(1, Here)`, pUSD is `(0, [PalletInstance(50), GeneralIndex(50000413)])` and the beneficiary is
///      `(0, [AccountId32 { network: None, id: recipient }])`. Asset vectors list pUSD before PAS because XCM only
///      decodes sorted assets. A zero `pusd` leaves pUSD out of the program.
library XcmProgram {
    uint32 internal constant RELAY = 0;

    uint8 private constant ASSETS_PALLET = 50;
    uint128 private constant PUSD_ASSET_ID = 50_000_413;

    bytes1 private constant V5 = 0x05;
    bytes1 private constant WITHDRAW_ASSET = 0x00;
    bytes1 private constant DEPOSIT_ASSET = 0x0d;
    bytes1 private constant REFUND_SURPLUS = 0x14;
    bytes1 private constant SET_FEES_MODE = 0x2b;
    bytes1 private constant INITIATE_TRANSFER = 0x31;

    /// @notice `WithdrawAsset`, then `DepositAsset` to `recipient` on Asset Hub.
    function deposit(bytes32 recipient, uint128 pas, uint128 pusd) internal pure returns (bytes memory) {
        return bytes.concat(V5, compact(2), WITHDRAW_ASSET, _assets(pas, pusd), _depositAll(_count(pusd), recipient));
    }

    /// @notice `WithdrawAsset`, `SetFeesMode`, then `InitiateTransfer` to `destination`, where `remoteFee` of the
    ///         PAS buys execution and the remote `RefundSurplus` hands what it leaves to `recipient`.
    /// @dev `jit_withdraw` makes the faucet's account pay the delivery fee: `InitiateTransfer` empties holding first.
    function transfer(
        uint32 destination,
        Transfer pasKind,
        Transfer pusdKind,
        uint128 remoteFee,
        bytes32 recipient,
        uint128 pas,
        uint128 pusd
    ) internal pure returns (bytes memory) {
        bytes memory legs = _definite(pasKind, _pas(pas - remoteFee));
        if (pusd != 0) legs = bytes.concat(legs, _definite(pusdKind, _pusd(pusd)));
        bytes memory initiateTransfer = bytes.concat(
            INITIATE_TRANSFER,
            _location(destination),
            hex"01", // remote_fees: Some
            _definite(pasKind, _pas(remoteFee)),
            hex"00", // preserve_origin: false
            compact(_count(pusd)),
            legs,
            compact(2),
            REFUND_SURPLUS,
            _depositAll(_count(pusd), recipient)
        );
        return
            bytes.concat(V5, compact(3), WITHDRAW_ASSET, _assets(pas, pusd), SET_FEES_MODE, hex"01", initiateTransfer);
    }

    /// @notice SCALE compact encoding of `value`.
    function compact(uint256 value) internal pure returns (bytes memory) {
        if (value < 1 << 6) return le(value << 2, 1);
        if (value < 1 << 14) return le(value << 2 | 1, 2);
        if (value < 1 << 30) return le(value << 2 | 2, 4);
        uint256 size = 4;
        while (value >> (8 * size) != 0) ++size;
        // casting to 'uint8' is safe because size is at most 32, so the prefix is at most 115
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes.concat(bytes1(uint8((size - 4) << 2 | 3)), le(value, size));
    }

    /// @notice The low `size` bytes of `value`, little-endian.
    function le(uint256 value, uint256 size) internal pure returns (bytes memory out) {
        out = new bytes(size);
        for (uint256 i; i < size; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            out[i] = bytes1(uint8(value >> (8 * i)));
        }
    }

    function _count(uint128 pusd) private pure returns (uint256) {
        return pusd == 0 ? 1 : 2;
    }

    function _assets(uint128 pas, uint128 pusd) private pure returns (bytes memory) {
        if (pusd == 0) return bytes.concat(compact(1), _pas(pas));
        return bytes.concat(compact(2), _pusd(pusd), _pas(pas));
    }

    function _pas(uint128 amount) private pure returns (bytes memory) {
        return bytes.concat(hex"0100", _fungible(amount));
    }

    function _pusd(uint128 amount) private pure returns (bytes memory) {
        return bytes.concat(hex"000204", bytes1(ASSETS_PALLET), hex"05", compact(PUSD_ASSET_ID), _fungible(amount));
    }

    function _fungible(uint128 amount) private pure returns (bytes memory) {
        return bytes.concat(hex"00", compact(amount));
    }

    /// @dev `AssetTransferFilter::<kind>(Definite([asset]))`; `None` and `Local` underflow and revert.
    function _definite(Transfer kind, bytes memory asset) private pure returns (bytes memory) {
        return bytes.concat(bytes1(uint8(kind) - uint8(Transfer.Teleport)), hex"00", compact(1), asset);
    }

    /// @dev `DepositAsset { assets: Wild(AllCounted(count)), beneficiary }`.
    function _depositAll(uint256 count, bytes32 recipient) private pure returns (bytes memory) {
        return bytes.concat(DEPOSIT_ASSET, hex"0102", compact(count), hex"00010100", recipient);
    }

    /// @dev `(1, Here)` for the relay chain, `(1, [Parachain(destination)])` otherwise.
    function _location(uint32 destination) private pure returns (bytes memory) {
        if (destination == RELAY) return hex"0100";
        return bytes.concat(hex"010100", compact(destination));
    }
}
