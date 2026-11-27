// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BotHireSettlementRegistry} from "../src/BotHireSettlementRegistry.sol";

/// forge script script/Deploy.s.sol --rpc-url https://testnet.hsk.xyz --broadcast --private-key $DEPLOYER_KEY
/// Refuses to run on any chain other than HashKey Chain testnet (133) or mainnet (177).
contract Deploy is Script {
    function run() external {
        require(block.chainid == 133 || block.chainid == 177, "not HashKey Chain");
        vm.startBroadcast();
        BotHireSettlementRegistry reg = new BotHireSettlementRegistry();
        vm.stopBroadcast();
        console.log("chain", block.chainid);
        console.log("BotHireSettlementRegistry", address(reg));
    }
}
