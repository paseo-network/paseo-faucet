// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {Destination, PaseoFaucet} from "../src/PaseoFaucet.sol";
import {Transfer} from "../src/XcmProgram.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Brings the destinations of the deployed faucet at `FAUCET_ADDRESS` in line with `Deploy.launch()`: calls
///         `setDestination` for each launch entry the faucet lacks or holds differently, and nothing else. A faucet
///         already in line gets no transaction. The sender must be the owner: a wallet option, or `--sender` to
///         simulate.
contract Configure is Script {
    function run() external returns (uint256 changed) {
        changed = configure(PaseoFaucet(payable(vm.envAddress("FAUCET_ADDRESS"))));
    }

    /// @notice The same for `faucet`, without the environment; answers how many entries it set.
    function configure(PaseoFaucet faucet) public returns (uint256 changed) {
        Destination[6] memory launch = new Deploy().launch();
        vm.startBroadcast();
        for (uint256 i; i < launch.length; ++i) {
            if (keccak256(abi.encode(registered(faucet, launch[i].id))) != keccak256(abi.encode(launch[i]))) {
                faucet.setDestination(launch[i]);
                ++changed;
            }
        }
        vm.stopBroadcast();
    }

    /// @notice The faucet's entry for `id`, all zeros when it has none.
    function registered(PaseoFaucet faucet, uint32 id) public view returns (Destination memory d) {
        (
            uint32 entryId,
            bool enabled,
            Transfer pasTransfer,
            Transfer pusdTransfer,
            uint128 remoteFee,
            uint128 maxDeliveryFee,
            uint128 minPas,
            uint128 minPusd
        ) = faucet.destination(id);
        d = Destination(entryId, enabled, pasTransfer, pusdTransfer, remoteFee, maxDeliveryFee, minPas, minPusd);
    }
}
