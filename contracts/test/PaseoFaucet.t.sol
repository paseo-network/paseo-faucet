// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPersonhood} from "../src/interfaces/IPersonhood.sol";
import {Destination, PaseoFaucet, Tier, TierConfig} from "../src/PaseoFaucet.sol";
import {Transfer, XcmProgram} from "../src/XcmProgram.sol";
import {FaucetHarness} from "./harness/FaucetHarness.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPersonhood} from "./mocks/MockPersonhood.sol";
import {MockSystem} from "./mocks/MockSystem.sol";
import {MockXcm} from "./mocks/MockXcm.sol";

contract PaseoFaucetTest is Test {
    uint64 constant EPOCH_SECONDS = 1 days;
    uint64 constant START_EPOCH = 20_000;
    uint32 constant ASSET_HUB = 1000;
    uint32 constant PEOPLE = 1004;
    uint32 constant PAS_ONLY = 1501;
    uint128 constant LITE_PAS = 25e10;
    uint128 constant LITE_PUSD = 25e6;
    uint128 constant FULL_PAS = 500e10;
    uint128 constant FULL_PUSD = 500e6;
    uint128 constant REMOTE_FEE = 1e9;
    uint128 constant MAX_DELIVERY_FEE = 3e9;
    bytes32 constant RECIPIENT = 0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d;
    bytes32 constant ALIAS = keccak256("alias");
    bytes constant PROOF = hex"0102030405";
    uint32 constant RING = 3;
    uint32 constant REVISION = 57;

    FaucetHarness faucet;
    MockPersonhood personhood;
    MockXcm xcm;
    MockERC20 pusd;
    address pauser = makeAddr("pauser");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.chainId(420_420_417);
        vm.warp(START_EPOCH * EPOCH_SECONDS + 123);
        faucet = new FaucetHarness("faucet.dot", EPOCH_SECONDS);

        vm.etch(address(faucet.PERSONHOOD()), address(new MockPersonhood()).code);
        vm.etch(address(faucet.SYSTEM()), address(new MockSystem()).code);
        vm.etch(address(faucet.XCM()), address(new MockXcm()).code);
        vm.etch(address(faucet.PUSD()), address(new MockERC20()).code);
        personhood = MockPersonhood(address(faucet.PERSONHOOD()));
        xcm = MockXcm(address(faucet.XCM()));
        pusd = MockERC20(address(faucet.PUSD()));

        faucet.setTier(Tier.Lite, TierConfig(true, LITE_PAS, LITE_PUSD));
        faucet.setTier(Tier.Full, TierConfig(true, FULL_PAS, FULL_PUSD));
        faucet.setMaxDripsPerEpoch(1000);
        faucet.setPauser(pauser);
        faucet.setDestination(_assetHub());
        faucet.setDestination(_people());
        faucet.setDestination(_pasOnly());

        vm.deal(address(faucet), 1e6 * 1e18);
        pusd.mint(address(faucet), 1e6 * 1e6);
    }

    // Formats

    function test_contextFor_matchesHostDerivation() public {
        assertEq(faucet.contextFor(0), 0x31c1b89cf59d9a9e3feeb55781674e2608785c7743d990f1eabc84f2c185e202);
        assertEq(faucet.contextFor(1), 0x2e49b0091ac03891906d1ce9354c1287f6bac0a594b95de162a92f10e0703da1);
        assertEq(faucet.contextFor(20_743), 0x0d15aca61c1575803eaa4d8fc1fff601faa1ae33fd4da030d520c969b639c147);
        PaseoFaucet other = new PaseoFaucet("paseofaucet.dot", EPOCH_SECONDS);
        assertEq(other.contextFor(0), 0x8b46236bc1bffb24e1a0750e3e6932d7255b508c57ed0d495842cf105576d71f);
    }

    function test_indexMagic_isTheHostConstant() public view {
        bytes32 digest = faucet.SYSTEM().hashBlake256("product-account-index");
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes28(digest), faucet.INDEX_MAGIC());
    }

    function test_messageFor_layout() public view {
        bytes memory message = faucet.messageFor(START_EPOCH, PEOPLE, RECIPIENT);
        bytes memory expected = bytes.concat(
            hex"706173656f2d6661756365743a7631",
            bytes20(address(faucet)),
            hex"00000000190f1b41",
            hex"0000000000004e20",
            hex"000003ec",
            RECIPIENT
        );
        assertEq(message.length, 87);
        assertEq(message, expected);
    }

    function test_epochs_followBlockTime() public {
        vm.warp(START_EPOCH * EPOCH_SECONDS);
        assertEq(faucet.currentEpoch(), START_EPOCH);
        assertEq(faucet.nextEpochStart(), (START_EPOCH + 1) * EPOCH_SECONDS);
        vm.warp((START_EPOCH + 1) * EPOCH_SECONDS - 1);
        assertEq(faucet.currentEpoch(), START_EPOCH);
        vm.warp((START_EPOCH + 1) * EPOCH_SECONDS);
        assertEq(faucet.currentEpoch(), START_EPOCH + 1);
    }

    // Drip

    function test_drip_assetHub_depositsBothAssets() public {
        _prove(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Dripped(START_EPOCH, Tier.Lite, ALIAS, ASSET_HUB, RECIPIENT, LITE_PAS, LITE_PUSD);
        _drip(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);

        assertTrue(faucet.hasClaimed(START_EPOCH, Tier.Lite, ALIAS));
        assertEq(faucet.dripsInEpoch(START_EPOCH), 1);
        _assertExecuted(XcmProgram.deposit(RECIPIENT, LITE_PAS, LITE_PUSD));
    }

    function test_drip_people_teleportsBothAssets() public {
        _prove(Tier.Full, PEOPLE, RECIPIENT, ALIAS);
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Dripped(START_EPOCH, Tier.Full, ALIAS, PEOPLE, RECIPIENT, FULL_PAS, FULL_PUSD);
        _drip(Tier.Full, PEOPLE, RECIPIENT, ALIAS);
        _assertExecuted(
            XcmProgram.transfer(
                PEOPLE, Transfer.Teleport, Transfer.Teleport, REMOTE_FEE, RECIPIENT, FULL_PAS, FULL_PUSD
            )
        );
    }

    function test_drip_pasOnlyDestination_needsNoPusd() public {
        deal(address(pusd), address(faucet), 0);
        _prove(Tier.Lite, PAS_ONLY, RECIPIENT, ALIAS);
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Dripped(START_EPOCH, Tier.Lite, ALIAS, PAS_ONLY, RECIPIENT, LITE_PAS, 0);
        _drip(Tier.Lite, PAS_ONLY, RECIPIENT, ALIAS);
        _assertExecuted(
            XcmProgram.transfer(PAS_ONLY, Transfer.Teleport, Transfer.None, REMOTE_FEE, RECIPIENT, LITE_PAS, 0)
        );
    }

    function test_drip_checksRunInSpecOrder() public {
        _claim(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        uint32 id = 1006;
        Destination memory entry = _people();
        entry.id = id;
        entry.enabled = false;
        entry.minPas = LITE_PAS + 1;
        uint256 maxOutflow = uint256(LITE_PAS + MAX_DELIVERY_FEE) * 1e8;

        faucet.pause();
        faucet.setTier(Tier.Lite, TierConfig(false, LITE_PAS, LITE_PUSD));
        faucet.setMaxDripsPerEpoch(1);
        vm.deal(address(faucet), maxOutflow - 1);
        deal(address(pusd), address(faucet), 0);
        xcm.setFails(true);

        _expectDripRevert(id, ALIAS, PaseoFaucet.FaucetPaused.selector);
        faucet.unpause();
        _expectDripRevert(id, ALIAS, PaseoFaucet.TierDisabled.selector);
        faucet.setTier(Tier.Lite, TierConfig(true, LITE_PAS, LITE_PUSD));
        _expectDripRevert(id, ALIAS, PaseoFaucet.UnknownDestination.selector);
        faucet.setDestination(entry);
        _expectDripRevert(id, ALIAS, PaseoFaucet.DestinationNotEnabled.selector);
        entry.enabled = true;
        faucet.setDestination(entry);
        _expectDripRevert(id, ALIAS, PaseoFaucet.BelowDestinationMinimum.selector);
        entry.minPas = LITE_PAS;
        faucet.setDestination(entry);
        _expectDripRevert(id, ALIAS, PaseoFaucet.EpochCapReached.selector);
        faucet.setMaxDripsPerEpoch(2);
        _expectDripRevert(id, ALIAS, PaseoFaucet.AlreadyClaimed.selector);
        bytes32 fresh = keccak256("fresh");
        _expectDripRevert(id, fresh, PaseoFaucet.InsufficientPas.selector);
        vm.deal(address(faucet), maxOutflow);
        _expectDripRevert(id, fresh, PaseoFaucet.InsufficientPusd.selector);
        pusd.mint(address(faucet), LITE_PUSD);
        _expectDripRevert(id, fresh, PaseoFaucet.InvalidProof.selector);
        _prove(Tier.Lite, id, RECIPIENT, fresh);
        _expectDripRevert(id, fresh, PaseoFaucet.PayoutFailed.selector);
        xcm.setFails(false);
        _drip(Tier.Lite, id, RECIPIENT, fresh);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 2);
    }

    function test_drip_payoutMayTakeTheAmountPlusMaxDeliveryFee() public {
        uint256 maxOutflow = uint256(LITE_PAS + MAX_DELIVERY_FEE) * 1e8;
        _prove(Tier.Lite, PEOPLE, RECIPIENT, ALIAS);
        xcm.setOutflow(maxOutflow + 1);
        _expectDripRevert(PEOPLE, ALIAS, PaseoFaucet.PayoutFailed.selector);
        xcm.setOutflow(maxOutflow);
        _drip(Tier.Lite, PEOPLE, RECIPIENT, ALIAS);

        _prove(Tier.Lite, ASSET_HUB, RECIPIENT, keccak256("local"));
        xcm.setOutflow(uint256(LITE_PAS) * 1e8 + 1);
        _expectDripRevert(ASSET_HUB, keccak256("local"), PaseoFaucet.PayoutFailed.selector);
    }

    function test_drip_belowPusdMinimum() public {
        faucet.setTier(Tier.Lite, TierConfig(true, LITE_PAS, _people().minPusd - 1));
        vm.expectRevert(PaseoFaucet.BelowDestinationMinimum.selector);
        _drip(Tier.Lite, PEOPLE, RECIPIENT, ALIAS);
    }

    function test_drip_tierNoneIsNeverEnabled() public {
        vm.expectRevert(PaseoFaucet.TierDisabled.selector);
        _drip(Tier.None, ASSET_HUB, RECIPIENT, ALIAS);
    }

    function test_drip_proofIsBoundToEveryInput() public {
        _prove(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        _expectInvalidProof(Tier.Lite, ASSET_HUB, bytes32(uint256(RECIPIENT) + 1), ALIAS);
        _expectInvalidProof(Tier.Lite, PEOPLE, RECIPIENT, ALIAS);
        _expectInvalidProof(Tier.Full, ASSET_HUB, RECIPIENT, ALIAS);
        _expectInvalidProof(Tier.Lite, ASSET_HUB, RECIPIENT, keccak256("other"));
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        faucet.drip(Tier.Lite, ASSET_HUB, RECIPIENT, PROOF, ALIAS, RING + 1, REVISION);
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        faucet.drip(Tier.Lite, ASSET_HUB, RECIPIENT, PROOF, ALIAS, RING, REVISION + 1);
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        faucet.drip(Tier.Lite, ASSET_HUB, RECIPIENT, hex"01", ALIAS, RING, REVISION);

        vm.warp(block.timestamp + EPOCH_SECONDS);
        _expectInvalidProof(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        vm.warp(block.timestamp - EPOCH_SECONDS);
        _drip(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
    }

    function test_drip_oncePerAliasTierAndEpoch() public {
        _claim(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        _prove(Tier.Lite, PEOPLE, RECIPIENT, ALIAS);
        vm.expectRevert(PaseoFaucet.AlreadyClaimed.selector);
        _drip(Tier.Lite, PEOPLE, RECIPIENT, ALIAS);

        _claim(Tier.Full, ASSET_HUB, RECIPIENT, ALIAS);

        vm.warp(block.timestamp + EPOCH_SECONDS);
        _claim(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 2);
        assertEq(faucet.dripsInEpoch(START_EPOCH + 1), 1);
    }

    function test_drip_capResetsEachEpoch() public {
        faucet.setMaxDripsPerEpoch(1);
        _claim(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        _prove(Tier.Lite, ASSET_HUB, RECIPIENT, keccak256("second"));
        vm.expectRevert(PaseoFaucet.EpochCapReached.selector);
        _drip(Tier.Lite, ASSET_HUB, RECIPIENT, keccak256("second"));

        vm.warp(block.timestamp + EPOCH_SECONDS);
        _claim(Tier.Lite, ASSET_HUB, RECIPIENT, keccak256("second"));
    }

    function test_drip_rejectsValue() public {
        _prove(Tier.Lite, ASSET_HUB, RECIPIENT, ALIAS);
        (bool ok,) = address(faucet).call{value: 1}(
            abi.encodeCall(PaseoFaucet.drip, (Tier.Lite, ASSET_HUB, RECIPIENT, PROOF, ALIAS, RING, REVISION))
        );
        assertFalse(ok);
    }

    // Deployment and configuration

    function test_constructor_deploysInert() public {
        vm.expectEmit();
        emit PaseoFaucet.OwnershipTransferred(address(0), address(this));
        PaseoFaucet fresh = new PaseoFaucet("faucet.dot", EPOCH_SECONDS);

        assertEq(fresh.owner(), address(this));
        assertEq(fresh.productId(), "faucet.dot");
        assertEq(fresh.epochSeconds(), EPOCH_SECONDS);
        assertEq(fresh.maxDripsPerEpoch(), 0);
        assertEq(fresh.pauser(), address(0));
        assertFalse(fresh.paused());
        assertEq(fresh.destinations().length, 0);
        (bool liteEnabled,,) = fresh.tiers(Tier.Lite);
        (bool fullEnabled,,) = fresh.tiers(Tier.Full);
        assertFalse(liteEnabled || fullEnabled);
    }

    function test_constructor_rejectsEmptyConfig() public {
        vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
        new PaseoFaucet("", EPOCH_SECONDS);
        vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
        new PaseoFaucet("faucet.dot", 0);
    }

    function test_tierValuesAreIPersonhoodStatuses() public pure {
        assertEq(uint8(Tier.Lite), 1);
        assertEq(uint8(Tier.Full), 2);
    }

    function test_setTier() public {
        TierConfig memory config = TierConfig(false, 1, 2);
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.TierUpdated(Tier.Full, config);
        faucet.setTier(Tier.Full, config);
        (bool enabled, uint128 pas, uint128 pusd_) = faucet.tiers(Tier.Full);
        assertEq(abi.encode(enabled, pas, pusd_), abi.encode(config));

        vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
        faucet.setTier(Tier.None, config);
        vm.prank(pauser);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setTier(Tier.Full, config);
    }

    function test_setMaxDripsPerEpoch() public {
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.EpochCapUpdated(7);
        faucet.setMaxDripsPerEpoch(7);
        assertEq(faucet.maxDripsPerEpoch(), 7);

        vm.prank(pauser);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setMaxDripsPerEpoch(8);
    }

    function test_setPauser() public {
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.PauserUpdated(stranger);
        faucet.setPauser(stranger);
        assertEq(faucet.pauser(), stranger);

        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setPauser(stranger);
    }

    function test_pause_byOwnerOrPauser_unpause_byOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotPauser.selector);
        faucet.pause();

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Paused(pauser);
        vm.prank(pauser);
        faucet.pause();
        assertTrue(faucet.paused());

        vm.prank(pauser);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.unpause();

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Unpaused(address(this));
        faucet.unpause();
        assertFalse(faucet.paused());

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Paused(address(this));
        faucet.pause();
    }

    function test_pauser_cannotConfigureOrWithdraw() public {
        vm.startPrank(pauser);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setDestination(_people());
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.removeDestination(PEOPLE);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.withdraw(1, 0);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.transferOwnership(pauser);
        vm.stopPrank();
    }

    // Destination registry

    function test_setDestination_rejectsInvalidEntries() public {
        Destination[] memory invalid = new Destination[](14);
        invalid[0] = _assetHub();
        invalid[0].pasTransfer = Transfer.Teleport;
        invalid[1] = _assetHub();
        invalid[1].pusdTransfer = Transfer.Teleport;
        invalid[2] = _assetHub();
        invalid[2].remoteFee = 1;
        invalid[3] = _assetHub();
        invalid[3].minPas = 0;
        invalid[4] = _people();
        invalid[4].pasTransfer = Transfer.Local;
        invalid[5] = _people();
        invalid[5].pasTransfer = Transfer.None;
        invalid[6] = _people();
        invalid[6].pusdTransfer = Transfer.Local;
        invalid[7] = _people();
        invalid[7].remoteFee = 0;
        invalid[8] = _people();
        invalid[8].minPas = REMOTE_FEE;
        invalid[9] = _people();
        invalid[9].minPusd = 0;
        invalid[10] = _pasOnly();
        invalid[10].minPusd = 1;
        invalid[11] = _assetHub();
        invalid[11].pasTransfer = Transfer.None;
        invalid[12] = _assetHub();
        invalid[12].maxDeliveryFee = 1;
        invalid[13] = _people();
        invalid[13].maxDeliveryFee = 0;

        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
            faucet.setDestination(invalid[i]);
        }
    }

    function test_setDestination_acceptsAssetHubPasOnlyAndReserveEntries() public {
        Destination memory ahPasOnly = _assetHub();
        ahPasOnly.pusdTransfer = Transfer.None;
        ahPasOnly.minPusd = 0;
        faucet.setDestination(ahPasOnly);

        Destination memory reserve =
            Destination(2034, true, Transfer.ReserveFromAssetHub, Transfer.Teleport, 1, 1, 2, 3);
        faucet.setDestination(reserve);
        Destination memory relay = Destination(0, true, Transfer.Teleport, Transfer.None, 1, 1, 2, 0);
        faucet.setDestination(relay);
        assertEq(faucet.destinations().length, 5);
    }

    function test_registry_lifecycle() public {
        _assertIds(_ids3(ASSET_HUB, PEOPLE, PAS_ONLY));

        Destination memory people = _people();
        people.remoteFee = 2e9;
        people.minPas = 3e9;
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.DestinationSet(PEOPLE, people);
        faucet.setDestination(people);
        _assertIds(_ids3(ASSET_HUB, PEOPLE, PAS_ONLY));
        (,,,, uint128 remoteFee,,,) = faucet.destination(PEOPLE);
        assertEq(remoteFee, 2e9);

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.DestinationDisabled(PEOPLE);
        vm.prank(pauser);
        faucet.disableDestination(PEOPLE);
        assertFalse(faucet.destinations()[1].enabled);
        _expectDripRevert(PEOPLE, ALIAS, PaseoFaucet.DestinationNotEnabled.selector);

        faucet.setDestination(people);
        assertTrue(faucet.destinations()[1].enabled);

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.DestinationRemoved(PEOPLE);
        faucet.removeDestination(PEOPLE);
        uint32[] memory remaining = new uint32[](2);
        (remaining[0], remaining[1]) = (ASSET_HUB, PAS_ONLY);
        _assertIds(remaining);
        (,, Transfer pasTransfer,,,,,) = faucet.destination(PEOPLE);
        assertEq(uint8(pasTransfer), uint8(Transfer.None));
        _expectDripRevert(PEOPLE, ALIAS, PaseoFaucet.UnknownDestination.selector);

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.DestinationSet(PEOPLE, people);
        faucet.setDestination(people);
        _assertIds(_ids3(ASSET_HUB, PAS_ONLY, PEOPLE));
        faucet.removeDestination(PEOPLE);
        faucet.removeDestination(ASSET_HUB);
        faucet.removeDestination(PAS_ONLY);
        assertEq(faucet.destinations().length, 0);
    }

    function test_registry_unknownIdsAndRoles() public {
        vm.expectRevert(PaseoFaucet.UnknownDestination.selector);
        faucet.disableDestination(1006);
        vm.expectRevert(PaseoFaucet.UnknownDestination.selector);
        faucet.removeDestination(1006);
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotPauser.selector);
        faucet.disableDestination(PEOPLE);
        faucet.disableDestination(PEOPLE);
    }

    // Funds and ownership

    function test_receive_andBalances() public {
        vm.deal(address(faucet), 0);
        deal(address(pusd), address(faucet), 7);
        vm.deal(stranger, 3e10 * 1e8);
        vm.prank(stranger);
        (bool ok,) = address(faucet).call{value: 3e10 * 1e8}("");
        assertTrue(ok);
        (uint256 pas, uint256 pusd_) = faucet.balances();
        assertEq(pas, 3e10);
        assertEq(pusd_, 7);
    }

    function test_withdraw_paysTheOwner() public {
        faucet.transferOwnership(stranger);
        vm.startPrank(stranger);
        faucet.acceptOwnership();
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Withdrawn(stranger, 5e10, 9e6);
        faucet.withdraw(5e10, 9e6);
        assertEq(stranger.balance, 5e10 * 1e8);
        assertEq(pusd.balanceOf(stranger), 9e6);

        faucet.withdraw(0, 0);
        assertEq(stranger.balance, 5e10 * 1e8);
        vm.stopPrank();
    }

    function test_withdraw_failuresRevert() public {
        // This test contract owns the faucet and rejects value.
        vm.expectRevert(PaseoFaucet.PayoutFailed.selector);
        faucet.withdraw(1, 0);
        vm.expectRevert(PaseoFaucet.PayoutFailed.selector);
        faucet.withdraw(0, 1e12 + 1);
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.withdraw(1, 0);
    }

    function test_ownership_twoStep() public {
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.OwnershipTransferStarted(address(this), stranger);
        faucet.transferOwnership(stranger);
        assertEq(faucet.pendingOwner(), stranger);
        assertEq(faucet.owner(), address(this));

        vm.prank(pauser);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.acceptOwnership();

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.OwnershipTransferred(address(this), stranger);
        vm.prank(stranger);
        faucet.acceptOwnership();
        assertEq(faucet.owner(), stranger);
        assertEq(faucet.pendingOwner(), address(0));

        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setMaxDripsPerEpoch(1);
    }

    // Harness

    function test_harness_paysRegisteredDestinationForOwnerOnly() public {
        faucet.pay(PEOPLE, RECIPIENT, LITE_PAS, LITE_PUSD);
        _assertExecuted(
            XcmProgram.transfer(
                PEOPLE, Transfer.Teleport, Transfer.Teleport, REMOTE_FEE, RECIPIENT, LITE_PAS, LITE_PUSD
            )
        );
        vm.expectRevert(PaseoFaucet.UnknownDestination.selector);
        faucet.pay(1006, RECIPIENT, LITE_PAS, 0);
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.pay(PEOPLE, RECIPIENT, LITE_PAS, 0);
    }

    // Helpers

    function _assetHub() internal pure returns (Destination memory) {
        return Destination(ASSET_HUB, true, Transfer.Local, Transfer.Local, 0, 0, 1e8, 10);
    }

    function _people() internal pure returns (Destination memory) {
        return Destination(
            PEOPLE, true, Transfer.Teleport, Transfer.Teleport, REMOTE_FEE, MAX_DELIVERY_FEE, 1e9 + REMOTE_FEE, 10_000
        );
    }

    function _pasOnly() internal pure returns (Destination memory) {
        return Destination(
            PAS_ONLY, true, Transfer.Teleport, Transfer.None, REMOTE_FEE, MAX_DELIVERY_FEE, 1e9 + REMOTE_FEE, 0
        );
    }

    function _request(Tier tier, uint32 destinationId, bytes32 recipient, bytes32 contextAlias)
        internal
        view
        returns (IPersonhood.ProofVerificationRequest memory)
    {
        uint64 epoch = faucet.currentEpoch();
        return IPersonhood.ProofVerificationRequest({
            expectedStatus: uint8(tier),
            proof: PROOF,
            expectedAlias: contextAlias,
            ringIndex: RING,
            context: faucet.contextFor(epoch),
            revision: REVISION,
            message: faucet.messageFor(epoch, destinationId, recipient)
        });
    }

    function _prove(Tier tier, uint32 destinationId, bytes32 recipient, bytes32 contextAlias) internal {
        personhood.accept(_request(tier, destinationId, recipient, contextAlias));
    }

    function _drip(Tier tier, uint32 destinationId, bytes32 recipient, bytes32 contextAlias) internal {
        faucet.drip(tier, destinationId, recipient, PROOF, contextAlias, RING, REVISION);
    }

    function _claim(Tier tier, uint32 destinationId, bytes32 recipient, bytes32 contextAlias) internal {
        _prove(tier, destinationId, recipient, contextAlias);
        _drip(tier, destinationId, recipient, contextAlias);
    }

    function _expectDripRevert(uint32 destinationId, bytes32 contextAlias, bytes4 selector) internal {
        vm.expectRevert(selector);
        _drip(Tier.Lite, destinationId, RECIPIENT, contextAlias);
    }

    function _expectInvalidProof(Tier tier, uint32 destinationId, bytes32 recipient, bytes32 contextAlias) internal {
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        _drip(tier, destinationId, recipient, contextAlias);
    }

    function _assertExecuted(bytes memory program) internal view {
        assertEq(xcm.lastMessage(), program);
        (uint64 refTime, uint64 proofSize) = xcm.lastWeight();
        assertEq(refTime, program.length * 1000);
        assertEq(proofSize, program.length);
    }

    function _ids3(uint32 a, uint32 b, uint32 c) internal pure returns (uint32[] memory ids) {
        ids = new uint32[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
    }

    function _assertIds(uint32[] memory expected) internal view {
        Destination[] memory list = faucet.destinations();
        assertEq(list.length, expected.length);
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].id, expected[i]);
        }
    }
}
