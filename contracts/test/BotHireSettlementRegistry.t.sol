// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BotHireSettlementRegistry as R} from "../src/BotHireSettlementRegistry.sol";

contract RegistryTest is Test {
    R reg;
    address payer = address(0xA11CE);
    address payee = address(0xB0B);
    address other = address(0xC0C);
    address human = address(0x4011);
    address token = address(0x7070);
    address token18 = address(0x1818);
    bytes32 cart = keccak256("cart-1");
    bytes32 tx1 = keccak256("tx-1");
    bytes32 deliv = keccak256("work");

    function setUp() public {
        reg = new R();
        vm.warp(1_800_000_000);
        vm.startPrank(payer);
        reg.setPolicy(payer, token, 5e6, 8e6, true);
        reg.setPayeeAllowed(payer, payee, true);
        vm.stopPrank();
    }

    function _auth(uint256 amt) internal {
        vm.prank(payer);
        reg.authorizeSpend(cart, payee, token, amt);
    }

    function _record(uint256 amt) internal {
        vm.prank(payee);
        reg.recordSettlement(payer, cart, token, amt, "PR-123", tx1, deliv);
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function test_happyPath() public {
        _auth(3e6);
        _record(3e6);
        vm.expectEmit(true, true, false, true);
        emit R.DeliveryConfirmed(cart, payer, deliv);
        vm.prank(payer);
        reg.confirmDelivery(cart, deliv);
        R.Hire memory h = reg.getHire(payer, cart);
        assertEq(uint8(h.status), uint8(R.Status.Delivered));
        assertEq(h.hspPaymentRequestId, "PR-123");
        assertEq(h.settlementTx, tx1);
        assertEq(reg.spentOnDay(payer, _today(), token), 3e6);
    }

    // H1: someone else using the same cart hash gets their own entry, never the payer's.
    function test_cartHashCannotBeClaimedByOthers() public {
        vm.startPrank(other);
        reg.setPolicy(other, token, 1e6, 1e6, false);
        reg.authorizeSpend(cart, other, token, 1);
        vm.stopPrank();
        _auth(3e6); // the real payer is unaffected
        assertEq(reg.getHire(payer, cart).payee, payee);
        assertEq(reg.getHire(other, cart).payee, other);
        // the payee can only record the payer's own entry
        vm.prank(payee);
        vm.expectRevert(R.NotPayee.selector);
        reg.recordSettlement(other, cart, token, 1, "PR-x", tx1, deliv);
    }

    // H2: once a controller is set, the agent can no longer loosen its own policy.
    function test_controller() public {
        vm.prank(payer);
        reg.setController(payer, human);
        vm.startPrank(payer);
        vm.expectRevert(R.NotController.selector);
        reg.setPolicy(payer, token, 100e6, 100e6, false);
        vm.expectRevert(R.NotController.selector);
        reg.setPayeeAllowed(payer, other, true);
        vm.expectRevert(R.NotController.selector);
        reg.setController(payer, address(0));
        // pausing is still allowed for the agent, unpausing is not
        reg.setPaused(payer, true);
        vm.expectRevert(R.NotController.selector);
        reg.setPaused(payer, false);
        vm.expectRevert(R.Paused.selector);
        reg.authorizeSpend(cart, payee, token, 1e6);
        vm.stopPrank();
        vm.startPrank(human);
        reg.setPaused(payer, false);
        reg.setPolicy(payer, token, 6e6, 8e6, true);
        vm.stopPrank();
        _auth(6e6);
        // strangers can't do anything
        vm.prank(other);
        vm.expectRevert(R.NotController.selector);
        reg.setPaused(payer, true);
    }

    function test_policyNotSetAndZeroValues() public {
        vm.prank(other);
        vm.expectRevert(R.PolicyNotSet.selector);
        reg.authorizeSpend(cart, payee, token, 1);
        vm.startPrank(payer);
        vm.expectRevert(R.ZeroValue.selector);
        reg.setPolicy(payer, token, 0, 1, false);
        vm.expectRevert(R.ZeroValue.selector);
        reg.setPolicy(payer, address(0), 1, 1, false);
        vm.expectRevert(R.ZeroValue.selector);
        reg.authorizeSpend(cart, payee, address(0), 1);
        vm.expectRevert(R.ZeroValue.selector);
        reg.authorizeSpend(bytes32(0), payee, token, 1);
        vm.stopPrank();
    }

    function test_perPaymentCap() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(R.OverPerPaymentCap.selector, 6e6, 5e6));
        reg.authorizeSpend(cart, payee, token, 6e6);
    }

    function test_dailyCapAndReset() public {
        vm.startPrank(payer);
        reg.authorizeSpend(cart, payee, token, 5e6);
        vm.expectRevert(abi.encodeWithSelector(R.OverDailyCap.selector, 5e6, 4e6, 8e6));
        reg.authorizeSpend(keccak256("cart-2"), payee, token, 4e6);
        vm.warp(block.timestamp + 1 days);
        reg.authorizeSpend(keccak256("cart-2"), payee, token, 4e6);
        vm.stopPrank();
    }

    // M4: caps are per token; a token without a policy is refused.
    function test_capsArePerToken() public {
        vm.prank(payer);
        vm.expectRevert(R.PolicyNotSet.selector);
        reg.authorizeSpend(cart, payee, token18, 1);
        vm.startPrank(payer);
        reg.setPolicy(payer, token18, 1e18, 1e18, true);
        reg.authorizeSpend(cart, payee, token18, 1e18);
        reg.authorizeSpend(keccak256("cart-2"), payee, token, 5e6);
        vm.stopPrank();
        assertEq(reg.spentOnDay(payer, _today(), token18), 1e18);
        assertEq(reg.spentOnDay(payer, _today(), token), 5e6);
    }

    function test_allowlist() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(R.PayeeNotAllowed.selector, other));
        reg.authorizeSpend(cart, other, token, 1e6);
        (bool ok, string memory why) = reg.checkSpend(payer, cart, other, token, 1e6);
        assertFalse(ok);
        assertEq(why, "payee not on allowlist");
    }

    // M1 + R2: the payee can release at any time; the cap comes back.
    function test_payeeReleaseRefundsCap() public {
        _auth(5e6);
        vm.prank(other);
        vm.expectRevert(R.NotPayerOrPayee.selector);
        reg.cancelAuthorization(payer, cart);
        vm.prank(payee);
        reg.cancelAuthorization(payer, cart);
        assertEq(reg.spentOnDay(payer, _today(), token), 0);
        assertEq(uint8(reg.getHire(payer, cart).status), uint8(R.Status.Cancelled));
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(R.WrongStatus.selector, R.Status.Cancelled));
        reg.recordSettlement(payer, cart, token, 5e6, "PR", tx1, deliv);
        vm.startPrank(payer); // full daily cap (8e6) available again
        reg.authorizeSpend(keccak256("cart-2"), payee, token, 5e6);
        reg.authorizeSpend(keccak256("cart-3"), payee, token, 3e6);
        vm.stopPrank();
    }

    // R2: the payer can't cancel early (it may already have paid); only after expiry.
    function test_payerCancelsOnlyAfterExpiry() public {
        _auth(5e6);
        uint256 day0 = _today();
        vm.prank(payer);
        vm.expectRevert(R.NotExpired.selector);
        reg.cancelAuthorization(payer, cart);
        vm.warp(block.timestamp + reg.AUTH_TTL() + 1);
        vm.prank(payer);
        reg.cancelAuthorization(payer, cart);
        assertEq(reg.spentOnDay(payer, day0, token), 0);
    }

    // R2: a stranger copying a payee's settlement tx / request id into their own hire blocks nobody.
    function test_noCrossPayeeGrief() public {
        vm.startPrank(other);
        reg.setPolicy(other, token, 1e6, 1e6, false);
        reg.authorizeSpend(keccak256("x"), other, token, 1);
        reg.recordSettlement(other, keccak256("x"), token, 1, "PR-123", tx1, deliv);
        vm.stopPrank();
        _auth(3e6);
        _record(3e6); // still works for the real payee
        assertEq(uint8(reg.getHire(payer, cart).status), uint8(R.Status.Settled));
    }

    function test_clearPolicy() public {
        vm.prank(payer);
        reg.clearPolicy(payer, token);
        vm.prank(payer);
        vm.expectRevert(R.PolicyNotSet.selector);
        reg.authorizeSpend(cart, payee, token, 1);
        vm.prank(other);
        vm.expectRevert(R.NotController.selector);
        reg.clearPolicy(payer, token);
    }

    function test_hugeCapNoOverflow() public {
        vm.prank(payer);
        reg.setPolicy(payer, token, type(uint256).max, type(uint256).max, false);
        _auth(10);
        (bool ok, string memory why) = reg.checkSpend(payer, keccak256("c2"), payee, token, type(uint256).max);
        assertFalse(ok);
        assertEq(why, "over daily cap");
    }

    function test_expiry() public {
        _auth(1e6);
        vm.warp(block.timestamp + reg.AUTH_TTL() + 1);
        vm.prank(payee);
        vm.expectRevert(R.Expired.selector);
        reg.recordSettlement(payer, cart, token, 1e6, "PR", tx1, deliv);
    }

    // M2: terms must match, and one settlement tx / request id can only be recorded once.
    function test_settlementTermsAndReplay() public {
        _auth(1e6);
        vm.startPrank(payee);
        vm.expectRevert(R.TermsMismatch.selector);
        reg.recordSettlement(payer, cart, token, 2e6, "PR", tx1, deliv);
        vm.expectRevert(R.TermsMismatch.selector);
        reg.recordSettlement(payer, cart, token18, 1e6, "PR", tx1, deliv);
        vm.expectRevert(R.ZeroValue.selector);
        reg.recordSettlement(payer, cart, token, 1e6, "PR", bytes32(0), deliv);
        vm.expectRevert(R.ZeroValue.selector);
        reg.recordSettlement(payer, cart, token, 1e6, "", tx1, deliv);
        vm.expectRevert(R.ZeroValue.selector);
        reg.recordSettlement(payer, cart, token, 1e6, "PR", tx1, bytes32(0));
        reg.recordSettlement(payer, cart, token, 1e6, "PR", tx1, deliv);
        vm.expectRevert(abi.encodeWithSelector(R.WrongStatus.selector, R.Status.Settled));
        reg.recordSettlement(payer, cart, token, 1e6, "PR", tx1, deliv);
        vm.stopPrank();
        // a second hire can't reuse the same payment
        vm.prank(payer);
        reg.authorizeSpend(keccak256("cart-2"), payee, token, 1e6);
        vm.startPrank(payee);
        vm.expectRevert(R.AlreadyRecorded.selector);
        reg.recordSettlement(payer, keccak256("cart-2"), token, 1e6, "PR-2", tx1, deliv);
        vm.expectRevert(R.AlreadyRecorded.selector);
        reg.recordSettlement(payer, keccak256("cart-2"), token, 1e6, "PR", keccak256("tx-2"), deliv);
        vm.stopPrank();
    }

    function test_onlyPayeeRecords() public {
        _auth(1e6);
        vm.prank(other);
        vm.expectRevert(R.NotPayee.selector);
        reg.recordSettlement(payer, cart, token, 1e6, "PR", tx1, deliv);
    }

    function test_noDuplicateCart() public {
        _auth(1e6);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(R.HireExists.selector, cart));
        reg.authorizeSpend(cart, payee, token, 1e6);
        (bool ok, string memory why) = reg.checkSpend(payer, cart, payee, token, 1e6);
        assertFalse(ok);
        assertEq(why, "hire exists");
    }

    // M3: mismatch reverts confirm; the payer can reject instead of being stuck.
    function test_deliveryMismatchAndReject() public {
        _auth(1e6);
        _record(1e6);
        vm.prank(other); // other has no hire under this cart
        vm.expectRevert(abi.encodeWithSelector(R.WrongStatus.selector, R.Status.None));
        reg.confirmDelivery(cart, deliv);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(R.DeliverableMismatch.selector, deliv, bytes32(uint256(1))));
        reg.confirmDelivery(cart, bytes32(uint256(1)));
        vm.prank(payer);
        reg.rejectDelivery(cart, bytes32(uint256(1)));
        assertEq(uint8(reg.getHire(payer, cart).status), uint8(R.Status.Rejected));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(R.WrongStatus.selector, R.Status.Rejected));
        reg.confirmDelivery(cart, deliv);
    }

    // L1: the dry run agrees with the real call.
    function testFuzz_checkSpendMatchesAuthorize(uint256 amount, bool allowed, uint8 tokenPick, bool prior) public {
        amount = bound(amount, 0, 10e6);
        address tok = tokenPick % 3 == 0 ? token : tokenPick % 3 == 1 ? token18 : address(0);
        address pe = allowed ? payee : other;
        if (prior) _auth(4e6);
        bytes32 c = prior && tokenPick % 2 == 0 ? cart : keccak256("cart-f");
        (bool ok,) = reg.checkSpend(payer, c, pe, tok, amount);
        vm.prank(payer);
        try reg.authorizeSpend(c, pe, tok, amount) {
            assertTrue(ok, "authorize passed but check said no");
        } catch {
            assertFalse(ok, "check said yes but authorize reverted");
        }
    }
}
