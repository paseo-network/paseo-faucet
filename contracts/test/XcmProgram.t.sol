// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test, stdError} from "forge-std/Test.sol";
import {Transfer, XcmProgram} from "../src/XcmProgram.sol";

contract XcmProgramTest is Test {
    bytes32 constant RECIPIENT = 0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d;
    uint128 constant PAS = 25e10;
    uint128 constant PUSD = 25e6;
    uint128 constant REMOTE_FEE = 1e9;

    function test_deposit_pasAndPusd() public pure {
        assertEq(
            XcmProgram.deposit(RECIPIENT, PAS, PUSD),
            hex"05080008000204320576c8eb0b0002e1f50501000007004429353a0d01020800010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_deposit_pasOnly() public pure {
        assertEq(
            XcmProgram.deposit(RECIPIENT, PAS, 0),
            hex"0508000401000007004429353a0d01020400010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_transfer_peopleTeleportsPasAndPusd() public pure {
        assertEq(
            XcmProgram.transfer(1004, Transfer.Teleport, Transfer.Teleport, REMOTE_FEE, RECIPIENT, PAS, PUSD),
            hex"050c0008000204320576c8eb0b0002e1f50501000007004429353a2b0131010100b10f0100000401000002286bee000800000401000007007a8ef939000004000204320576c8eb0b0002e1f50508140d01020800010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_transfer_teleportsPasOnly() public pure {
        assertEq(
            XcmProgram.transfer(1501, Transfer.Teleport, Transfer.None, REMOTE_FEE, RECIPIENT, PAS, 0),
            hex"050c000401000007004429353a2b013101010075170100000401000002286bee000400000401000007007a8ef93908140d01020400010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_transfer_reserveDepositsPasAndPusd() public pure {
        assertEq(
            XcmProgram.transfer(
                2034, Transfer.ReserveFromAssetHub, Transfer.ReserveFromAssetHub, REMOTE_FEE, RECIPIENT, PAS, PUSD
            ),
            hex"050c0008000204320576c8eb0b0002e1f50501000007004429353a2b0131010100c91f0101000401000002286bee000801000401000007007a8ef939010004000204320576c8eb0b0002e1f50508140d01020800010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_transfer_reservesPasAndTeleportsPusd() public pure {
        assertEq(
            XcmProgram.transfer(
                2034, Transfer.ReserveFromAssetHub, Transfer.Teleport, REMOTE_FEE, RECIPIENT, PAS, PUSD
            ),
            hex"050c0008000204320576c8eb0b0002e1f50501000007004429353a2b0131010100c91f0101000401000002286bee000801000401000007007a8ef939000004000204320576c8eb0b0002e1f50508140d01020800010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_transfer_relayTeleportsPasOnly() public pure {
        assertEq(
            XcmProgram.transfer(XcmProgram.RELAY, Transfer.Teleport, Transfer.None, REMOTE_FEE, RECIPIENT, PAS, 0),
            hex"050c000401000007004429353a2b013101000100000401000002286bee000400000401000007007a8ef93908140d01020400010100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    function test_transfer_revertsForANonTransferLeg() public {
        vm.expectRevert(stdError.arithmeticError);
        this.transferWithPusdLeg(Transfer.None);
        vm.expectRevert(stdError.arithmeticError);
        this.transferWithPusdLeg(Transfer.Local);
    }

    function transferWithPusdLeg(Transfer pusdKind) external pure returns (bytes memory) {
        return XcmProgram.transfer(1004, Transfer.Teleport, pusdKind, REMOTE_FEE, RECIPIENT, PAS, PUSD);
    }

    function test_compact_vectors() public pure {
        assertEq(XcmProgram.compact(0), hex"00");
        assertEq(XcmProgram.compact(1), hex"04");
        assertEq(XcmProgram.compact(63), hex"fc");
        assertEq(XcmProgram.compact(64), hex"0101");
        assertEq(XcmProgram.compact(785), hex"450c");
        assertEq(XcmProgram.compact(1004), hex"b10f");
        assertEq(XcmProgram.compact(2 ** 14 - 1), hex"fdff");
        assertEq(XcmProgram.compact(2 ** 14), hex"02000100");
        assertEq(XcmProgram.compact(50_000_413), hex"76c8eb0b");
        assertEq(XcmProgram.compact(2 ** 30 - 1), hex"feffffff");
        assertEq(XcmProgram.compact(2 ** 30), hex"0300000040");
        assertEq(XcmProgram.compact(2 ** 32), hex"070000000001");
        assertEq(XcmProgram.compact(25e10), hex"07004429353a");
        assertEq(
            XcmProgram.compact(type(uint256).max),
            hex"73ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        );
    }

    function testFuzz_compact_roundTrips(uint256 value) public pure {
        bytes memory encoded = XcmProgram.compact(value);
        uint256 mode = uint8(encoded[0]) & 3;
        uint256 decoded;
        if (mode == 3) {
            uint256 size = (uint8(encoded[0]) >> 2) + 4;
            assertEq(encoded.length, size + 1);
            assertTrue(uint8(encoded[size]) != 0 && value >= 2 ** 30, "not canonical");
            for (uint256 i = size; i > 0; --i) {
                decoded = decoded << 8 | uint8(encoded[i]);
            }
        } else {
            assertEq(encoded.length, 2 ** mode);
            for (uint256 i = encoded.length; i > 0; --i) {
                decoded = decoded << 8 | uint8(encoded[i - 1]);
            }
            decoded >>= 2;
            assertTrue(mode == 0 || decoded >= 2 ** (8 * (encoded.length >> 1) - 2), "not canonical");
        }
        assertEq(decoded, value);
    }
}
