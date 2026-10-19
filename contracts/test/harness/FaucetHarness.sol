// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {PaseoFaucet} from "../../src/PaseoFaucet.sol";

/// @notice Test-only faucet that lets its owner run a registered destination's payout without a proof. Never deploy
///         it with real funds.
contract FaucetHarness is PaseoFaucet {
    constructor(string memory productId_, uint64 epochSeconds_) PaseoFaucet(productId_, epochSeconds_) {}

    function pay(uint32 destinationId, bytes32 recipient, uint128 pas, uint128 pusd) external onlyOwner {
        _pay(_registered(destinationId), recipient, pas, pusd);
    }
}
