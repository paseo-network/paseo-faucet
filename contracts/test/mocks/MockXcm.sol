// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IXcm} from "../../src/interfaces/IXcm.sol";

/// @notice Records the last executed program. `setFails(true)` makes execution revert; `setOutflow(amount)` makes it
///         take `amount` wei from the caller, as the executor takes the assets and the delivery fee. Unlike the real
///         withdrawal, that balance change survives a revert.
contract MockXcm {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes public lastMessage;
    IXcm.Weight public lastWeight;
    bool public fails;
    uint256 public outflow;

    function setFails(bool fails_) external {
        fails = fails_;
    }

    function setOutflow(uint256 outflow_) external {
        outflow = outflow_;
    }

    function weighMessage(bytes calldata message) external pure returns (IXcm.Weight memory) {
        return IXcm.Weight({refTime: uint64(message.length) * 1000, proofSize: uint64(message.length)});
    }

    function execute(bytes calldata message, IXcm.Weight calldata weight) external {
        require(!fails, "MockXcm: execution failed");
        lastMessage = message;
        lastWeight = weight;
        VM.deal(msg.sender, msg.sender.balance - outflow);
    }
}
