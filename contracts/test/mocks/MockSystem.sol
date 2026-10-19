// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @notice `ISystem.hashBlake256` for inputs of up to one block, computed with the BLAKE2 F precompile (EIP-152).
contract MockSystem {
    /// @dev BLAKE2b IV as little-endian words, with `h[0] ^= 0x01010020` (32-byte digest, no key).
    bytes private constant INITIAL_STATE =
        hex"28c9bdf267e6096a3ba7ca8485ae67bb2bf894fe72f36e3cf1361d5f3af54fa5d182e6ad7f520e511f6c3e2b8c68059b6bbd41fbabd9831f79217e1319cde05b";

    function hashBlake256(bytes memory input) external view returns (bytes32) {
        require(input.length <= 128, "MockSystem: input longer than one block");
        bytes memory padded = bytes.concat(input, new bytes(128 - input.length));
        bytes16 counter = bytes16(bytes1(uint8(input.length)));
        (bool ok, bytes memory state) =
            address(0x09).staticcall(abi.encodePacked(uint32(12), INITIAL_STATE, padded, counter, true));
        require(ok, "MockSystem: blake2f failed");
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes32(state);
    }
}
