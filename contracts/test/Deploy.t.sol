// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Destination, PaseoFaucet, Tier} from "../src/PaseoFaucet.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Transfer} from "../src/XcmProgram.sol";

contract DeployTest is Test {
    function test_run_configuresTheLaunchState() public {
        address pauser = makeAddr("pauser");
        address owner = makeAddr("owner");
        vm.setEnv("PRODUCT_ID", "faucet.dot");
        vm.setEnv("EPOCH_SECONDS", "86400");
        vm.setEnv("MAX_DRIPS_PER_EPOCH", "1000");
        vm.setEnv("LITE_PAS", "250000000000");
        vm.setEnv("LITE_PUSD", "25000000");
        vm.setEnv("FULL_PAS", "5000000000000");
        vm.setEnv("FULL_PUSD", "500000000");
        vm.setEnv("PAUSER", vm.toString(pauser));
        vm.setEnv("OWNER", vm.toString(owner));
        Deploy deploy = new Deploy();

        PaseoFaucet faucet = deploy.run();
        assertEq(faucet.productId(), "faucet.dot");
        assertEq(faucet.epochSeconds(), 86_400);
        assertEq(faucet.maxDripsPerEpoch(), 1000);
        assertEq(faucet.pauser(), pauser);
        assertEq(faucet.pendingOwner(), owner);
        (bool enabled, uint128 pas, uint128 pusd) = faucet.tiers(Tier.Full);
        assertTrue(enabled);
        assertEq(pas, 5e12);
        assertEq(pusd, 5e8);
        Destination[6] memory launch = deploy.launch();
        Destination[] memory registered = faucet.destinations();
        assertEq(registered.length, launch.length);
        uint32[6] memory ids = [uint32(1000), 1004, 1010, 1500, 1501, 1502];
        for (uint256 i; i < launch.length; ++i) {
            assertEq(abi.encode(registered[i]), abi.encode(launch[i]));
            assertEq(launch[i].id, ids[i]);
            assertTrue(launch[i].enabled);
            // Only Asset Hub and People take pUSD.
            assertEq(launch[i].pusdTransfer == Transfer.None, i > 1);
        }

        assertEq(faucet.owner(), DEFAULT_SENDER);

        vm.setEnv("OWNER", vm.toString(DEFAULT_SENDER));
        faucet = deploy.run();
        assertEq(faucet.owner(), DEFAULT_SENDER);
        assertEq(faucet.pendingOwner(), address(0));

        vm.setEnv("EPOCH_SECONDS", "18446744073709551616");
        vm.expectRevert(bytes("EPOCH_SECONDS is out of range"));
        deploy.run();
    }
}
