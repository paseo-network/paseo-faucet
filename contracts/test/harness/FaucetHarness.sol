// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {PaseoFaucet, Tier} from "../../src/PaseoFaucet.sol";

/// @notice Test-only faucet that lets its owner run payouts without a proof: one destination's payout, or a whole
///         claim. Never deploy it with real funds.
contract FaucetHarness is PaseoFaucet {
    constructor(string memory productId_, uint64 epochSeconds_) PaseoFaucet(productId_, epochSeconds_) {}

    function pay(uint32 destinationId, bytes32 recipient, uint128 pas, uint128 pusd) external onlyOwner {
        _pay(_registered(destinationId), recipient, pas, pusd);
    }

    function dripWithoutProof(Tier tier, bytes32 recipient, bytes32 contextAlias) external onlyOwner {
        (uint64 epoch, uint256 due) = _due(tier, contextAlias);
        _drip(tier, epoch, contextAlias, recipient, due);
    }
}
