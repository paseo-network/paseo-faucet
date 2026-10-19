// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @notice Minimal token; `transfer` returns false when the sender lacks the balance.
contract MockERC20 {
    mapping(address account => uint256) public balanceOf;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (balanceOf[msg.sender] < value) return false;
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
