// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IXcm} from "../../src/interfaces/IXcm.sol";

/// @notice Records every executed program. `setFails(program, true)` makes executing that program revert;
///         `setOutflow(amount)` makes each execution take `amount` wei from the caller, as the executor takes the
///         assets and the delivery fee. Unlike the real withdrawal, that balance change survives a revert.
contract MockXcm {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes[] private _messages;
    IXcm.Weight[] private _weights;
    mapping(bytes32 messageHash => bool) public fails;
    uint256 public outflow;

    function setFails(bytes calldata message, bool fails_) external {
        fails[keccak256(message)] = fails_;
    }

    function setOutflow(uint256 outflow_) external {
        outflow = outflow_;
    }

    function clear() external {
        delete _messages;
        delete _weights;
    }

    function executed() external view returns (bytes[] memory messages, IXcm.Weight[] memory weights) {
        return (_messages, _weights);
    }

    function weighMessage(bytes calldata message) external pure returns (IXcm.Weight memory) {
        return IXcm.Weight({refTime: uint64(message.length) * 1000, proofSize: uint64(message.length)});
    }

    function execute(bytes calldata message, IXcm.Weight calldata weight) external {
        require(!fails[keccak256(message)], "MockXcm: execution failed");
        _messages.push(message);
        _weights.push(weight);
        VM.deal(msg.sender, msg.sender.balance - outflow);
    }
}
