// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {IPersonhood} from "../../src/interfaces/IPersonhood.sol";

/// @notice Verifies exactly the one request registered with `accept`, as a real proof binds all of its inputs.
contract MockPersonhood {
    bytes32 public accepted;

    function accept(IPersonhood.ProofVerificationRequest calldata request) external {
        accepted = keccak256(abi.encode(request));
    }

    function personhoodInfoByProof(IPersonhood.ProofVerificationRequest calldata request) external view returns (bool) {
        return keccak256(abi.encode(request)) == accepted;
    }
}
