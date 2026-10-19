// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @notice The subset of the ERC20 precompile of pallet-assets that the faucet uses.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}
