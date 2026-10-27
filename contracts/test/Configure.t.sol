// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Destination, PaseoFaucet} from "../src/PaseoFaucet.sol";
import {Configure} from "../script/Configure.s.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract ConfigureTest is Test {
    function test_run_addsAndUpdatesOnlyWhatDiffersFromLaunch() public {
        Deploy deploy = new Deploy();
        Destination[6] memory launch = deploy.launch();
        vm.prank(DEFAULT_SENDER);
        PaseoFaucet faucet = new PaseoFaucet("faucet.dot", 1 days);
        vm.startPrank(DEFAULT_SENDER);
        faucet.setDestination(launch[0]);
        Destination memory stale = deploy.launch()[1];
        stale.remoteFee += 1;
        faucet.setDestination(stale);
        vm.stopPrank();
        Configure configure = new Configure();

        assertEq(configure.configure(faucet), 5);
        Destination[] memory registered = faucet.destinations();
        assertEq(registered.length, launch.length);
        for (uint256 i; i < launch.length; ++i) {
            assertEq(abi.encode(registered[i]), abi.encode(launch[i]));
        }
        assertEq(configure.configure(faucet), 0);
    }

    function test_run_needsTheOwner() public {
        PaseoFaucet faucet = new PaseoFaucet("faucet.dot", 1 days);
        Configure configure = new Configure();
        // A broadcast call's revert reaches the test without its data.
        vm.expectRevert();
        configure.configure(faucet);
    }
}
