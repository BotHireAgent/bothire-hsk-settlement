// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BotHireSettlementRegistry
/// @notice On-chain spend policy and settlement log for agent-to-agent hires paid through
///         HashKey Settlement Platform (HSP). The contract never holds tokens; HSP moves the funds.
///
/// One hire is keyed by (payer, HSP cart hash), so nobody can claim another payer's cart.
///   1. The hiring agent (payer) calls `authorizeSpend` BEFORE it signs the HSP payment. The call
///      enforces the payer's policy for that token (per-payment cap, daily cap, payee allowlist)
///      and reverts if the payment would break it. An authorization expires after AUTH_TTL. The
///      payee can release it at any time, and the payer can cancel it once it has expired; either
///      gives the amount back to the cap of the day it was authorized. (The payer can't cancel early:
///      it may already have paid, and cancelling would let it re-spend the cap and strand the payee.)
///   2. The working agent (payee) checks the payment itself (HSP `query_payment` plus the token
///      transfer on the payment chain), does the work, and calls `recordSettlement` with the HSP
///      payment request id, the settlement tx and the hash of the work. This is the payee's own
///      attestation; the contract only makes sure it matches the authorization and that the payee
///      never records the same settlement tx or HSP request id twice. A payee should refuse an
///      authorization that is about to expire.
///   3. The payer checks the work it received against that hash and calls `confirmDelivery`, or
///      `rejectDelivery` if it does not match. Either way the outcome is on-chain.
///
/// Who sets the policy: an agent may hand control of its policy to a human or multisig with
/// `setController`. From then on only that controller can loosen the policy or the allowlist; the
/// agent itself can still pause, never authorize more. Until a controller is set the agent manages
/// its own policy. Either way HSP does not consult this contract: the policy limits an agent that
/// asks it before signing, which is what the BotHire employer agent does. Tightening a policy or
/// pausing does not touch authorizations already granted. A cancelled cart can't be re-authorized.
///
/// The daily cap resets at 00:00 UTC (block.timestamp / 1 days), so up to twice the cap can pass
/// in the minutes around midnight. Caps are per token, in that token's raw units.
contract BotHireSettlementRegistry {
    uint256 public constant AUTH_TTL = 1 days;

    struct Policy {
        uint256 maxPerPayment; // raw token units, must be > 0
        uint256 dailyCap; // raw token units, must be > 0
        bool allowlistOnly; // true = payee must be on the payer's allowlist
        bool active; // false = no policy for this token (all spends refused)
    }

    enum Status {
        None,
        Authorized,
        Settled,
        Delivered,
        Rejected,
        Cancelled
    }

    struct Hire {
        address payer;
        address payee;
        address token;
        uint256 amount;
        uint64 authorizedAt;
        uint64 expiresAt;
        uint64 settledAt;
        Status status;
        bytes32 settlementTx; // HSP on-chain settlement tx hash
        bytes32 deliverableHash; // hash of the delivered work, set by the payee
        string hspPaymentRequestId; // HSP payment_request_id
    }

    /// agent => controller (0 = the agent controls its own policy)
    mapping(address => address) public controllerOf;
    mapping(address => bool) public paused;
    /// payer => token => policy
    mapping(address => mapping(address => Policy)) public policies;
    mapping(address => mapping(address => bool)) public allowedPayee;
    /// payer => day index => token => amount authorized that day
    mapping(address => mapping(uint256 => mapping(address => uint256))) public spentOnDay;
    /// keccak256(abi.encode(payee, settlementTx)) => recorded
    mapping(bytes32 => bool) public settlementTxUsed;
    /// keccak256(abi.encode(payee, keccak256(hspPaymentRequestId))) => recorded
    mapping(bytes32 => bool) public requestIdUsed;
    mapping(bytes32 => Hire) private hires;

    error NotController();
    error PolicyNotSet();
    error Paused();
    error OverPerPaymentCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 spent, uint256 amount, uint256 cap);
    error PayeeNotAllowed(address payee);
    error HireExists(bytes32 cartHash);
    error WrongStatus(Status status);
    error Expired();
    error NotPayee();
    error NotPayerOrPayee();
    error NotExpired();
    error TermsMismatch();
    error AlreadyRecorded();
    error ZeroValue();
    error DeliverableMismatch(bytes32 recorded, bytes32 received);

    event ControllerSet(address indexed agent, address indexed controller);
    event PausedSet(address indexed agent, bool paused);
    event PolicySet(address indexed payer, address indexed token, uint256 maxPerPayment, uint256 dailyCap, bool allowlistOnly);
    event PayeeAllowed(address indexed payer, address indexed payee, bool allowed);
    event SpendAuthorized(
        bytes32 indexed cartHash, address indexed payer, address indexed payee, address token, uint256 amount, uint64 expiresAt
    );
    event PolicyCleared(address indexed payer, address indexed token);
    event AuthorizationCancelled(
        bytes32 indexed cartHash, address indexed payer, address indexed by, address token, uint256 amount
    );
    event SettlementRecorded(
        bytes32 indexed cartHash,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        string hspPaymentRequestId,
        bytes32 settlementTx,
        bytes32 deliverableHash
    );
    event DeliveryConfirmed(bytes32 indexed cartHash, address indexed payer, bytes32 deliverableHash);
    event DeliveryRejected(bytes32 indexed cartHash, address indexed payer, bytes32 receivedHash);

    // ---------------------------------------------------------------- control

    modifier onlyController(address agent) {
        address c = controllerOf[agent];
        if (msg.sender != (c == address(0) ? agent : c)) revert NotController();
        _;
    }

    /// @notice Hand control of `agent`'s policy to `controller` (or back to the agent with 0).
    function setController(address agent, address controller) external onlyController(agent) {
        controllerOf[agent] = controller;
        emit ControllerSet(agent, controller);
    }

    /// @notice Pausing is always allowed for the agent itself; unpausing needs the controller.
    function setPaused(address agent, bool p) external {
        if (!(p && msg.sender == agent)) {
            address c = controllerOf[agent];
            if (msg.sender != (c == address(0) ? agent : c)) revert NotController();
        }
        paused[agent] = p;
        emit PausedSet(agent, p);
    }

    function setPolicy(address agent, address token, uint256 maxPerPayment, uint256 dailyCap, bool allowlistOnly)
        external
        onlyController(agent)
    {
        if (token == address(0) || maxPerPayment == 0 || dailyCap == 0) revert ZeroValue();
        policies[agent][token] = Policy(maxPerPayment, dailyCap, allowlistOnly, true);
        emit PolicySet(agent, token, maxPerPayment, dailyCap, allowlistOnly);
    }

    /// @notice Turn off the policy for one token: all spends in that token are refused.
    function clearPolicy(address agent, address token) external onlyController(agent) {
        delete policies[agent][token];
        emit PolicyCleared(agent, token);
    }

    function setPayeeAllowed(address agent, address payee, bool allowed) external onlyController(agent) {
        allowedPayee[agent][payee] = allowed;
        emit PayeeAllowed(agent, payee, allowed);
    }

    // ---------------------------------------------------------------- spend checks

    /// @notice Dry run of `authorizeSpend` for `payer`. Returns (true, "") or (false, reason).
    function checkSpend(address payer, bytes32 cartHash, address payee, address token, uint256 amount)
        public
        view
        returns (bool ok, string memory reason)
    {
        if (cartHash == bytes32(0) || payee == address(0) || token == address(0) || amount == 0) {
            return (false, "zero value");
        }
        if (hires[hireId(payer, cartHash)].status != Status.None) return (false, "hire exists");
        if (paused[payer]) return (false, "paused");
        Policy memory p = policies[payer][token];
        if (!p.active) return (false, "policy not set");
        if (amount > p.maxPerPayment) return (false, "over per-payment cap");
        if (_overDaily(spentOnDay[payer][_today()][token], amount, p.dailyCap)) return (false, "over daily cap");
        if (p.allowlistOnly && !allowedPayee[payer][payee]) return (false, "payee not on allowlist");
        return (true, "");
    }

    // ---------------------------------------------------------------- hire lifecycle

    /// @notice Called by the payer before signing the HSP payment. Reverts if the policy says no.
    function authorizeSpend(bytes32 cartHash, address payee, address token, uint256 amount) external {
        if (cartHash == bytes32(0) || payee == address(0) || token == address(0) || amount == 0) revert ZeroValue();
        bytes32 id = hireId(msg.sender, cartHash);
        if (hires[id].status != Status.None) revert HireExists(cartHash);
        if (paused[msg.sender]) revert Paused();
        Policy memory p = policies[msg.sender][token];
        if (!p.active) revert PolicyNotSet();
        if (amount > p.maxPerPayment) revert OverPerPaymentCap(amount, p.maxPerPayment);
        uint256 day = _today();
        uint256 spent = spentOnDay[msg.sender][day][token];
        if (_overDaily(spent, amount, p.dailyCap)) revert OverDailyCap(spent, amount, p.dailyCap);
        uint256 wouldSpend = spent + amount;
        if (p.allowlistOnly && !allowedPayee[msg.sender][payee]) revert PayeeNotAllowed(payee);

        spentOnDay[msg.sender][day][token] = wouldSpend;
        Hire storage h = hires[id];
        h.payer = msg.sender;
        h.payee = payee;
        h.token = token;
        h.amount = amount;
        h.authorizedAt = uint64(block.timestamp);
        h.expiresAt = uint64(block.timestamp + AUTH_TTL);
        h.status = Status.Authorized;
        emit SpendAuthorized(cartHash, msg.sender, payee, token, amount, h.expiresAt);
    }

    /// @notice Ends an unsettled authorization and gives the amount back to the cap of the day it was
    ///         authorized. The payee may release it at any time; the payer only once it has expired.
    function cancelAuthorization(address payer, bytes32 cartHash) external {
        Hire storage h = hires[hireId(payer, cartHash)];
        if (h.status != Status.Authorized) revert WrongStatus(h.status);
        if (msg.sender == payer) {
            if (block.timestamp <= h.expiresAt) revert NotExpired();
        } else if (msg.sender != h.payee) {
            revert NotPayerOrPayee();
        }
        h.status = Status.Cancelled;
        spentOnDay[payer][h.authorizedAt / 1 days][h.token] -= h.amount;
        emit AuthorizationCancelled(cartHash, payer, msg.sender, h.token, h.amount);
    }

    /// @notice Called by the payee after it has confirmed the payment itself and done the work.
    function recordSettlement(
        address payer,
        bytes32 cartHash,
        address token,
        uint256 amount,
        string calldata hspPaymentRequestId,
        bytes32 settlementTx,
        bytes32 deliverableHash
    ) external {
        Hire storage h = hires[hireId(payer, cartHash)];
        if (h.status != Status.Authorized) revert WrongStatus(h.status);
        if (msg.sender != h.payee) revert NotPayee();
        if (block.timestamp > h.expiresAt) revert Expired();
        if (token != h.token || amount != h.amount) revert TermsMismatch();
        if (bytes(hspPaymentRequestId).length == 0 || settlementTx == bytes32(0) || deliverableHash == bytes32(0)) {
            revert ZeroValue();
        }
        // Scoped to the payee: a stranger copying these values into their own hire can't block anyone.
        bytes32 txKey = keccak256(abi.encode(msg.sender, settlementTx));
        bytes32 ridKey = keccak256(abi.encode(msg.sender, keccak256(bytes(hspPaymentRequestId))));
        if (settlementTxUsed[txKey] || requestIdUsed[ridKey]) revert AlreadyRecorded();
        settlementTxUsed[txKey] = true;
        requestIdUsed[ridKey] = true;

        h.hspPaymentRequestId = hspPaymentRequestId;
        h.settlementTx = settlementTx;
        h.deliverableHash = deliverableHash;
        h.settledAt = uint64(block.timestamp);
        h.status = Status.Settled;
        emit SettlementRecorded(
            cartHash, payer, h.payee, h.token, h.amount, hspPaymentRequestId, settlementTx, deliverableHash
        );
    }

    /// @notice Called by the payer once it has received work matching the recorded hash.
    function confirmDelivery(bytes32 cartHash, bytes32 receivedHash) external {
        Hire storage h = hires[hireId(msg.sender, cartHash)];
        if (h.status != Status.Settled) revert WrongStatus(h.status);
        if (receivedHash != h.deliverableHash) revert DeliverableMismatch(h.deliverableHash, receivedHash);
        h.status = Status.Delivered;
        emit DeliveryConfirmed(cartHash, msg.sender, receivedHash);
    }

    /// @notice Called by the payer when the work it received is missing or does not match.
    function rejectDelivery(bytes32 cartHash, bytes32 receivedHash) external {
        Hire storage h = hires[hireId(msg.sender, cartHash)];
        if (h.status != Status.Settled) revert WrongStatus(h.status);
        h.status = Status.Rejected;
        emit DeliveryRejected(cartHash, msg.sender, receivedHash);
    }

    // ---------------------------------------------------------------- views

    function hireId(address payer, bytes32 cartHash) public pure returns (bytes32) {
        return keccak256(abi.encode(payer, cartHash));
    }

    function getHire(address payer, bytes32 cartHash) external view returns (Hire memory) {
        return hires[hireId(payer, cartHash)];
    }

    /// Overflow-safe `spent + amount > cap`.
    function _overDaily(uint256 spent, uint256 amount, uint256 cap) internal pure returns (bool) {
        return spent > cap || amount > cap - spent;
    }

    function _today() internal view returns (uint256) {
        return block.timestamp / 1 days;
    }
}
