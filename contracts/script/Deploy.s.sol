// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {Destination, PaseoFaucet, Tier, TierConfig} from "../src/PaseoFaucet.sol";
import {Transfer} from "../src/XcmProgram.sol";

/// @notice Deploys and configures the faucet, then proposes `OWNER`, who completes the handover with
///         `acceptOwnership()`. Every setting comes from the environment; a missing or out-of-range value aborts.
///         The deployer signs with `DEPLOYER_PRIVATE_KEY` when it is set, otherwise with the CLI's wallet options.
/// @dev PAS amounts are plancks, pUSD amounts are base units. fork/check.ts measures each launch entry against its
///      destination. Other chains are added with `setDestination` once a transfer to the live chain has arrived.
contract Deploy is Script {
    uint32 constant ASSET_HUB = 1000;
    uint32 constant PEOPLE = 1004;

    uint128 constant ASSET_HUB_ED = 1e8;
    uint128 constant PEOPLE_ED = 1e9;
    uint128 constant REMOTE_FEE = 1e8;
    uint128 constant MAX_DELIVERY_FEE = 5e9;
    uint128 constant ASSET_HUB_MIN_PUSD = 10;
    uint128 constant PEOPLE_MIN_PUSD = 10_000;

    function run() external returns (PaseoFaucet faucet) {
        string memory productId = vm.envString("PRODUCT_ID");
        uint64 epochSeconds = uint64(_envUint("EPOCH_SECONDS", type(uint64).max));
        uint32 maxDrips = uint32(_envUint("MAX_DRIPS_PER_EPOCH", type(uint32).max));
        TierConfig memory lite = TierConfig(true, _envAmount("LITE_PAS"), _envAmount("LITE_PUSD"));
        TierConfig memory full = TierConfig(true, _envAmount("FULL_PAS"), _envAmount("FULL_PUSD"));
        address pauser = vm.envAddress("PAUSER");
        address owner = vm.envAddress("OWNER");
        Destination[2] memory destinations = launch();

        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) vm.startBroadcast();
        else vm.startBroadcast(deployerKey);
        faucet = new PaseoFaucet(productId, epochSeconds);
        faucet.setTier(Tier.Lite, lite);
        faucet.setTier(Tier.Full, full);
        faucet.setMaxDripsPerEpoch(maxDrips);
        faucet.setPauser(pauser);
        for (uint256 i; i < destinations.length; ++i) {
            faucet.setDestination(destinations[i]);
        }
        faucet.transferOwnership(owner);
        vm.stopBroadcast();
    }

    /// @notice The destinations the faucet launches with.
    function launch() public pure returns (Destination[2] memory) {
        return [
            Destination(ASSET_HUB, true, Transfer.Local, Transfer.Local, 0, 0, ASSET_HUB_ED, ASSET_HUB_MIN_PUSD),
            Destination(
                PEOPLE,
                true,
                Transfer.Teleport,
                Transfer.Teleport,
                REMOTE_FEE,
                MAX_DELIVERY_FEE,
                PEOPLE_ED + REMOTE_FEE,
                PEOPLE_MIN_PUSD
            )
        ];
    }

    function _envAmount(string memory name) private view returns (uint128) {
        return uint128(_envUint(name, type(uint128).max));
    }

    function _envUint(string memory name, uint256 max) private view returns (uint256 value) {
        value = vm.envUint(name);
        require(value <= max, string.concat(name, " is out of range"));
    }
}
