// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPersonhood} from "../src/interfaces/IPersonhood.sol";
import {IXcm} from "../src/interfaces/IXcm.sol";
import {Allowance, Destination, PaseoFaucet, Skip, Tier, TierConfig} from "../src/PaseoFaucet.sol";
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
    address member = makeAddr("member");

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
        bytes memory message = faucet.messageFor(START_EPOCH, RECIPIENT);
        bytes memory expected = bytes.concat(
            hex"706173656f2d6661756365743a7632",
            bytes20(address(faucet)),
            hex"00000000190f1b41",
            hex"0000000000004e20",
            RECIPIENT
        );
        assertEq(message.length, 83);
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

    function test_drip_paysEveryEnabledDestination() public {
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectDripped(Tier.Lite, ASSET_HUB, LITE_PAS, LITE_PUSD);
        _expectDripped(Tier.Lite, PEOPLE, LITE_PAS, LITE_PUSD);
        _expectDripped(Tier.Lite, PAS_ONLY, LITE_PAS, 0);
        _drip(Tier.Lite, RECIPIENT, ALIAS);

        _assertExecuted(
            _programs3(
                _assetHubProgram(LITE_PAS, LITE_PUSD), _peopleProgram(LITE_PAS, LITE_PUSD), _pasOnlyProgram(LITE_PAS)
            )
        );
        _assertPaid(Tier.Lite, ALIAS, true, true, true);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 1);
    }

    function test_drip_paysPasWherePusdCannotBePaid() public {
        uint128 belowPeople = _people().minPusd - 1;
        faucet.setTier(Tier.Lite, TierConfig(true, LITE_PAS, belowPeople));
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectDripped(Tier.Lite, ASSET_HUB, LITE_PAS, belowPeople);
        _expectDripped(Tier.Lite, PEOPLE, LITE_PAS, 0);
        _drip(Tier.Lite, RECIPIENT, ALIAS);

        deal(address(pusd), address(faucet), FULL_PUSD - 1);
        _prove(Tier.Full, RECIPIENT, ALIAS);
        xcm.clear();
        _expectDripped(Tier.Full, ASSET_HUB, FULL_PAS, 0);
        _expectDripped(Tier.Full, PEOPLE, FULL_PAS, 0);
        _expectDripped(Tier.Full, PAS_ONLY, FULL_PAS, 0);
        _drip(Tier.Full, RECIPIENT, ALIAS);
        _assertExecuted(
            _programs3(_assetHubProgram(FULL_PAS, 0), _peopleProgram(FULL_PAS, 0), _pasOnlyProgram(FULL_PAS))
        );
    }

    function test_drip_skipsDestinationsBelowTheirMinimum() public {
        uint128 pas = _people().minPas - 1;
        faucet.setTier(Tier.Lite, TierConfig(true, pas, LITE_PUSD));
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectDripped(Tier.Lite, ASSET_HUB, pas, LITE_PUSD);
        _expectSkipped(Tier.Lite, PEOPLE, Skip.BelowMinimum);
        _expectSkipped(Tier.Lite, PAS_ONLY, Skip.BelowMinimum);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        _assertPaid(Tier.Lite, ALIAS, true, false, false);
    }

    function test_drip_skipsDestinationsTheFaucetCannotFund() public {
        xcm.setOutflow(uint256(LITE_PAS) * 1e8);
        vm.deal(address(faucet), uint256(2 * LITE_PAS + MAX_DELIVERY_FEE) * 1e8);
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectDripped(Tier.Lite, ASSET_HUB, LITE_PAS, LITE_PUSD);
        _expectDripped(Tier.Lite, PEOPLE, LITE_PAS, LITE_PUSD);
        _expectSkipped(Tier.Lite, PAS_ONLY, Skip.InsufficientPas);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        _assertPaid(Tier.Lite, ALIAS, true, true, false);
    }

    function test_drip_skipsFailedPayoutsAndPaysThemOnTheNextClaim() public {
        xcm.setFails(_peopleProgram(LITE_PAS, LITE_PUSD), true);
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectDripped(Tier.Lite, ASSET_HUB, LITE_PAS, LITE_PUSD);
        _expectSkipped(Tier.Lite, PEOPLE, Skip.PayoutFailed);
        _expectDripped(Tier.Lite, PAS_ONLY, LITE_PAS, 0);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        _assertExecuted(_programs2(_assetHubProgram(LITE_PAS, LITE_PUSD), _pasOnlyProgram(LITE_PAS)));
        _assertPaid(Tier.Lite, ALIAS, true, false, true);

        xcm.setFails(_peopleProgram(LITE_PAS, LITE_PUSD), false);
        xcm.clear();
        _expectDripped(Tier.Lite, PEOPLE, LITE_PAS, LITE_PUSD);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        _assertExecuted(_programs1(_peopleProgram(LITE_PAS, LITE_PUSD)));
        _assertPaid(Tier.Lite, ALIAS, true, true, true);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 1);

        vm.expectRevert(PaseoFaucet.AlreadyClaimed.selector);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
    }

    function test_drip_payoutMayTakeTheAmountPlusMaxDeliveryFee() public {
        uint256 maxOutflow = uint256(LITE_PAS + MAX_DELIVERY_FEE) * 1e8;
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        xcm.setOutflow(maxOutflow + 1);
        _expectDripRevert(ALIAS, PaseoFaucet.PayoutFailed.selector);

        xcm.setOutflow(maxOutflow);
        _expectSkipped(Tier.Lite, ASSET_HUB, Skip.PayoutFailed);
        _expectDripped(Tier.Lite, PEOPLE, LITE_PAS, LITE_PUSD);
        _expectDripped(Tier.Lite, PAS_ONLY, LITE_PAS, 0);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
    }

    function test_drip_paysADestinationAddedLaterInTheEpoch() public {
        _claim(Tier.Lite, RECIPIENT, ALIAS);
        Destination memory added = _pasOnly();
        added.id = 1500;
        faucet.setDestination(added);

        xcm.clear();
        _expectDripped(Tier.Lite, 1500, LITE_PAS, 0);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        _assertExecuted(
            _programs1(XcmProgram.transfer(1500, Transfer.Teleport, Transfer.None, REMOTE_FEE, RECIPIENT, LITE_PAS, 0))
        );
    }

    function test_drip_checksRunInSpecOrder() public {
        bytes32 claimed = keccak256("claimed");
        _claim(Tier.Lite, RECIPIENT, claimed);

        faucet.pause();
        faucet.setTier(Tier.Lite, TierConfig(false, LITE_PAS, LITE_PUSD));
        faucet.setMaxDripsPerEpoch(1);
        _disableAll();
        vm.deal(address(faucet), 0);
        _failAll(true);

        _expectDripRevert(ALIAS, PaseoFaucet.FaucetPaused.selector);
        faucet.unpause();
        _expectDripRevert(ALIAS, PaseoFaucet.TierDisabled.selector);
        faucet.setTier(Tier.Lite, TierConfig(true, LITE_PAS, LITE_PUSD));
        _expectDripRevert(ALIAS, PaseoFaucet.EpochCapReached.selector);
        faucet.setMaxDripsPerEpoch(2);
        _expectDripRevert(claimed, PaseoFaucet.AlreadyClaimed.selector);
        _expectDripRevert(ALIAS, PaseoFaucet.NothingToPay.selector);
        _enableAll();
        _expectDripRevert(ALIAS, PaseoFaucet.NothingToPay.selector);
        vm.deal(address(faucet), uint256(LITE_PAS) * 1e8);
        _expectDripRevert(ALIAS, PaseoFaucet.InvalidProof.selector);
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectDripRevert(ALIAS, PaseoFaucet.PayoutFailed.selector);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 1);
        _assertPaid(Tier.Lite, ALIAS, false, false, false);

        _failAll(false);
        _expectDripped(Tier.Lite, ASSET_HUB, LITE_PAS, LITE_PUSD);
        _expectSkipped(Tier.Lite, PEOPLE, Skip.InsufficientPas);
        _expectSkipped(Tier.Lite, PAS_ONLY, Skip.InsufficientPas);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 2);
    }

    function test_drip_tierNoneIsNeverEnabled() public {
        vm.expectRevert(PaseoFaucet.TierDisabled.selector);
        _drip(Tier.None, RECIPIENT, ALIAS);
    }

    function test_drip_proofIsBoundToEveryInput() public {
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        _expectInvalidProof(Tier.Lite, bytes32(uint256(RECIPIENT) + 1), ALIAS);
        _expectInvalidProof(Tier.Full, RECIPIENT, ALIAS);
        _expectInvalidProof(Tier.Lite, RECIPIENT, keccak256("other"));
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        faucet.drip(Tier.Lite, RECIPIENT, PROOF, ALIAS, RING + 1, REVISION);
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        faucet.drip(Tier.Lite, RECIPIENT, PROOF, ALIAS, RING, REVISION + 1);
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        faucet.drip(Tier.Lite, RECIPIENT, hex"01", ALIAS, RING, REVISION);

        vm.warp(vm.getBlockTimestamp() + EPOCH_SECONDS);
        _expectInvalidProof(Tier.Lite, RECIPIENT, ALIAS);
        vm.warp(vm.getBlockTimestamp() - EPOCH_SECONDS);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
    }

    function test_drip_oncePerAliasTierAndEpoch() public {
        _claim(Tier.Lite, RECIPIENT, ALIAS);
        bytes32 other = bytes32(uint256(RECIPIENT) + 1);
        _prove(Tier.Lite, other, ALIAS);
        vm.expectRevert(PaseoFaucet.AlreadyClaimed.selector);
        _drip(Tier.Lite, other, ALIAS);

        _claim(Tier.Full, RECIPIENT, ALIAS);

        vm.warp(vm.getBlockTimestamp() + EPOCH_SECONDS);
        _claim(Tier.Lite, RECIPIENT, ALIAS);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 2);
        assertEq(faucet.dripsInEpoch(START_EPOCH + 1), 1);
        _assertPaid(Tier.Lite, ALIAS, true, true, true);
        assertFalse(faucet.hasClaimed(START_EPOCH + 1, Tier.Full, ALIAS, ASSET_HUB));
    }

    function test_drip_capResetsEachEpoch() public {
        faucet.setMaxDripsPerEpoch(1);
        _claim(Tier.Lite, RECIPIENT, ALIAS);
        _prove(Tier.Lite, RECIPIENT, keccak256("second"));
        vm.expectRevert(PaseoFaucet.EpochCapReached.selector);
        _drip(Tier.Lite, RECIPIENT, keccak256("second"));

        vm.warp(vm.getBlockTimestamp() + EPOCH_SECONDS);
        _claim(Tier.Lite, RECIPIENT, keccak256("second"));
    }

    function test_drip_rejectsValue() public {
        _prove(Tier.Lite, RECIPIENT, ALIAS);
        (bool ok,) = address(faucet).call{value: 1}(
            abi.encodeCall(PaseoFaucet.drip, (Tier.Lite, RECIPIENT, PROOF, ALIAS, RING, REVISION))
        );
        assertFalse(ok);
    }

    function test_payLeg_onlyTheFaucet() public {
        vm.expectRevert(PaseoFaucet.NotSelf.selector);
        faucet.payLeg(_assetHub(), RECIPIENT, LITE_PAS, LITE_PUSD);
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotSelf.selector);
        faucet.payLeg(_assetHub(), RECIPIENT, LITE_PAS, LITE_PUSD);
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
        _claim(Tier.Lite, RECIPIENT, ALIAS);
        _assertPaid(Tier.Lite, ALIAS, true, false, true);

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
        vm.expectRevert(PaseoFaucet.AlreadyClaimed.selector);
        _drip(Tier.Lite, RECIPIENT, ALIAS);

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.DestinationSet(PEOPLE, people);
        faucet.setDestination(people);
        _assertIds(_ids3(ASSET_HUB, PEOPLE, PAS_ONLY));
        faucet.removeDestination(PEOPLE);
        faucet.removeDestination(ASSET_HUB);
        faucet.removeDestination(PAS_ONLY);
        assertEq(faucet.destinations().length, 0);
    }

    function test_registry_removalKeepsWhatWasPaid() public {
        _claim(Tier.Lite, RECIPIENT, ALIAS);
        faucet.removeDestination(PEOPLE);
        assertTrue(faucet.hasClaimed(START_EPOCH, Tier.Lite, ALIAS, PEOPLE));
        faucet.setDestination(_people());
        vm.expectRevert(PaseoFaucet.AlreadyClaimed.selector);
        _drip(Tier.Lite, RECIPIENT, ALIAS);
        assertFalse(faucet.hasClaimed(START_EPOCH, Tier.Lite, ALIAS, 1006));
    }

    function test_setDestination_registersAtMost256Ids() public {
        Destination memory entry = _pasOnly();
        for (uint32 id = 2000; id < 2253; ++id) {
            entry.id = id;
            faucet.setDestination(entry);
        }
        assertEq(faucet.destinations().length, 256);
        entry.id = 2253;
        vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
        faucet.setDestination(entry);

        faucet.removeDestination(2000);
        vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
        faucet.setDestination(entry);
        entry.id = 2000;
        faucet.setDestination(entry);
        assertEq(faucet.destinations().length, 256);
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
        _assertExecuted(_programs1(_peopleProgram(LITE_PAS, LITE_PUSD)));
        vm.expectRevert(PaseoFaucet.UnknownDestination.selector);
        faucet.pay(1006, RECIPIENT, LITE_PAS, 0);
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.pay(PEOPLE, RECIPIENT, LITE_PAS, 0);
    }

    function test_harness_dripsWithoutProofForOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.dripWithoutProof(Tier.Lite, RECIPIENT, ALIAS);
        faucet.dripWithoutProof(Tier.Lite, RECIPIENT, ALIAS);
        _assertPaid(Tier.Lite, ALIAS, true, true, true);
    }

    // Whitelist

    function test_setWhitelisted_byOwnerOnly() public {
        Allowance memory allowance = Allowance(1000e10, 100e6);
        vm.prank(stranger);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setWhitelisted(member, allowance);
        vm.prank(pauser);
        vm.expectRevert(PaseoFaucet.NotOwner.selector);
        faucet.setWhitelisted(member, allowance);

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.WhitelistUpdated(member, allowance);
        faucet.setWhitelisted(member, allowance);
        (uint128 pas, uint128 pusd_) = faucet.whitelist(member);
        assertEq(abi.encode(pas, pusd_), abi.encode(allowance.pas, allowance.pusd));

        vm.expectRevert(PaseoFaucet.InvalidConfig.selector);
        faucet.setWhitelisted(member, Allowance(0, 1));

        vm.expectEmit(address(faucet));
        emit PaseoFaucet.WhitelistUpdated(member, Allowance(0, 0));
        faucet.setWhitelisted(member, Allowance(0, 0));
        _expectRequestRevert(member, ASSET_HUB, LITE_PAS, 0, PaseoFaucet.NotWhitelisted.selector);
    }

    function test_request_paysWithoutAProofOrTheEpochCap() public {
        faucet.setMaxDripsPerEpoch(0);
        faucet.setWhitelisted(member, Allowance(1000e10, 100e6));
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Requested(START_EPOCH, member, ASSET_HUB, RECIPIENT, 300e10, 40e6);
        vm.prank(member);
        faucet.request(ASSET_HUB, RECIPIENT, 300e10, 40e6);
        vm.prank(member);
        faucet.request(ASSET_HUB, RECIPIENT, 300e10, 0);

        _assertExecuted(_programs2(_assetHubProgram(300e10, 40e6), _assetHubProgram(300e10, 0)));
        _assertRequested(START_EPOCH, member, 600e10, 40e6);
        assertEq(faucet.dripsInEpoch(START_EPOCH), 0);
    }

    function test_request_countsTheDeliveryFeeOfARemoteDestination() public {
        faucet.setWhitelisted(member, Allowance(LITE_PAS + MAX_DELIVERY_FEE, LITE_PUSD));
        vm.prank(member);
        faucet.request(PEOPLE, RECIPIENT, LITE_PAS, LITE_PUSD);
        _assertExecuted(_programs1(_peopleProgram(LITE_PAS, LITE_PUSD)));
        _assertRequested(START_EPOCH, member, LITE_PAS + MAX_DELIVERY_FEE, LITE_PUSD);

        _expectRequestRevert(member, ASSET_HUB, _assetHub().minPas, 0, PaseoFaucet.AllowanceExceeded.selector);
    }

    function test_request_allowanceResetsEachEpoch() public {
        faucet.setWhitelisted(member, Allowance(2 * LITE_PAS, LITE_PUSD));
        vm.prank(member);
        faucet.request(ASSET_HUB, RECIPIENT, LITE_PAS, LITE_PUSD);
        _expectRequestRevert(member, ASSET_HUB, 1e8, 10, PaseoFaucet.AllowanceExceeded.selector);
        _expectRequestRevert(member, ASSET_HUB, LITE_PAS + 1, 0, PaseoFaucet.AllowanceExceeded.selector);

        vm.warp(block.timestamp + EPOCH_SECONDS);
        vm.prank(member);
        faucet.request(ASSET_HUB, RECIPIENT, 2 * LITE_PAS, LITE_PUSD);
        _assertRequested(START_EPOCH, member, LITE_PAS, LITE_PUSD);
        _assertRequested(START_EPOCH + 1, member, 2 * LITE_PAS, LITE_PUSD);
    }

    function test_request_checksRunInSpecOrder() public {
        faucet.setWhitelisted(member, Allowance(LITE_PAS, LITE_PUSD));
        faucet.pause();
        _expectRequestRevert(stranger, ASSET_HUB, LITE_PAS, 0, PaseoFaucet.FaucetPaused.selector);
        faucet.unpause();
        _expectRequestRevert(stranger, ASSET_HUB, LITE_PAS, 0, PaseoFaucet.NotWhitelisted.selector);
        _expectRequestRevert(member, 4242, LITE_PAS, 0, PaseoFaucet.UnknownDestination.selector);
        faucet.disableDestination(PEOPLE);
        _expectRequestRevert(member, PEOPLE, LITE_PAS, 0, PaseoFaucet.UnknownDestination.selector);
        _expectRequestRevert(member, PAS_ONLY, _pasOnly().minPas - 1, 0, PaseoFaucet.InvalidRequest.selector);
        _expectRequestRevert(member, PAS_ONLY, _pasOnly().minPas, LITE_PUSD, PaseoFaucet.InvalidRequest.selector);
        _expectRequestRevert(member, ASSET_HUB, 1e8, _assetHub().minPusd - 1, PaseoFaucet.InvalidRequest.selector);
        _expectRequestRevert(member, ASSET_HUB, LITE_PAS + 1, 0, PaseoFaucet.AllowanceExceeded.selector);
        _assertRequested(START_EPOCH, member, 0, 0);
    }

    function test_request_failedPayoutRevertsAndSpendsNothing() public {
        faucet.setWhitelisted(member, Allowance(LITE_PAS, LITE_PUSD));
        xcm.setFails(_assetHubProgram(LITE_PAS, LITE_PUSD), true);
        _expectRequestRevert(member, ASSET_HUB, LITE_PAS, LITE_PUSD, PaseoFaucet.PayoutFailed.selector);

        xcm.setFails(_assetHubProgram(LITE_PAS, LITE_PUSD), false);
        xcm.setOutflow(uint256(LITE_PAS) * 1e8 + 1);
        _expectRequestRevert(member, ASSET_HUB, LITE_PAS, LITE_PUSD, PaseoFaucet.PayoutFailed.selector);
        _assertRequested(START_EPOCH, member, 0, 0);
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

    function _assetHubProgram(uint128 pas, uint128 pusd_) internal pure returns (bytes memory) {
        return XcmProgram.deposit(RECIPIENT, pas, pusd_);
    }

    function _peopleProgram(uint128 pas, uint128 pusd_) internal pure returns (bytes memory) {
        return XcmProgram.transfer(PEOPLE, Transfer.Teleport, Transfer.Teleport, REMOTE_FEE, RECIPIENT, pas, pusd_);
    }

    function _pasOnlyProgram(uint128 pas) internal pure returns (bytes memory) {
        return XcmProgram.transfer(PAS_ONLY, Transfer.Teleport, Transfer.None, REMOTE_FEE, RECIPIENT, pas, 0);
    }

    function _request(Tier tier, bytes32 recipient, bytes32 contextAlias)
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
            message: faucet.messageFor(epoch, recipient)
        });
    }

    function _prove(Tier tier, bytes32 recipient, bytes32 contextAlias) internal {
        personhood.accept(_request(tier, recipient, contextAlias));
    }

    function _drip(Tier tier, bytes32 recipient, bytes32 contextAlias) internal {
        faucet.drip(tier, recipient, PROOF, contextAlias, RING, REVISION);
    }

    function _claim(Tier tier, bytes32 recipient, bytes32 contextAlias) internal {
        _prove(tier, recipient, contextAlias);
        _drip(tier, recipient, contextAlias);
    }

    function _expectDripRevert(bytes32 contextAlias, bytes4 selector) internal {
        vm.expectRevert(selector);
        _drip(Tier.Lite, RECIPIENT, contextAlias);
    }

    function _expectInvalidProof(Tier tier, bytes32 recipient, bytes32 contextAlias) internal {
        vm.expectRevert(PaseoFaucet.InvalidProof.selector);
        _drip(tier, recipient, contextAlias);
    }

    function _expectDripped(Tier tier, uint32 id, uint128 pas, uint128 pusd_) internal {
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.Dripped(START_EPOCH, tier, ALIAS, id, RECIPIENT, pas, pusd_);
    }

    function _expectSkipped(Tier tier, uint32 id, Skip reason) internal {
        vm.expectEmit(address(faucet));
        emit PaseoFaucet.DripSkipped(START_EPOCH, tier, ALIAS, id, RECIPIENT, reason);
    }

    function _assertPaid(Tier tier, bytes32 contextAlias, bool assetHub, bool people, bool pasOnly) internal view {
        assertEq(faucet.hasClaimed(START_EPOCH, tier, contextAlias, ASSET_HUB), assetHub);
        assertEq(faucet.hasClaimed(START_EPOCH, tier, contextAlias, PEOPLE), people);
        assertEq(faucet.hasClaimed(START_EPOCH, tier, contextAlias, PAS_ONLY), pasOnly);
    }

    function _expectRequestRevert(address account, uint32 id, uint128 pas, uint128 pusd_, bytes4 selector) internal {
        vm.prank(account);
        vm.expectRevert(selector);
        faucet.request(id, RECIPIENT, pas, pusd_);
    }

    function _assertRequested(uint64 epoch, address account, uint128 pas, uint128 pusd_) internal view {
        (uint128 usedPas, uint128 usedPusd) = faucet.requested(epoch, account);
        assertEq(abi.encode(usedPas, usedPusd), abi.encode(pas, pusd_));
    }

    function _assertExecuted(bytes[] memory programs) internal view {
        (bytes[] memory messages, IXcm.Weight[] memory weights) = xcm.executed();
        assertEq(messages.length, programs.length);
        for (uint256 i; i < programs.length; ++i) {
            assertEq(messages[i], programs[i]);
            assertEq(weights[i].refTime, programs[i].length * 1000);
            assertEq(weights[i].proofSize, programs[i].length);
        }
    }

    function _disableAll() internal {
        faucet.disableDestination(ASSET_HUB);
        faucet.disableDestination(PEOPLE);
        faucet.disableDestination(PAS_ONLY);
    }

    function _enableAll() internal {
        faucet.setDestination(_assetHub());
        faucet.setDestination(_people());
        faucet.setDestination(_pasOnly());
    }

    function _failAll(bool fails) internal {
        xcm.setFails(_assetHubProgram(LITE_PAS, LITE_PUSD), fails);
        xcm.setFails(_peopleProgram(LITE_PAS, LITE_PUSD), fails);
        xcm.setFails(_pasOnlyProgram(LITE_PAS), fails);
    }

    function _programs1(bytes memory a) internal pure returns (bytes[] memory list) {
        list = new bytes[](1);
        list[0] = a;
    }

    function _programs2(bytes memory a, bytes memory b) internal pure returns (bytes[] memory list) {
        list = new bytes[](2);
        (list[0], list[1]) = (a, b);
    }

    function _programs3(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes[] memory list) {
        list = new bytes[](3);
        (list[0], list[1], list[2]) = (a, b, c);
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
