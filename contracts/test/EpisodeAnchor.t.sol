// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EpisodeAnchor} from "../src/EpisodeAnchor.sol";

contract EpisodeAnchorTest is Test {
    event EpisodeAnchored(
        bytes32 indexed fleet,
        bytes32 indexed episodeId,
        bytes32 storageRoot,
        uint32 decisions,
        uint32 safeStops,
        uint32 approvals,
        uint32 denials
    );

    address base = makeAddr("base");
    EpisodeAnchor a = new EpisodeAnchor(base);
    bytes32 fleet = keccak256("fleet");
    bytes32 ep = keccak256("ep-1105-01");
    bytes32 root = keccak256("root");

    function test_firstAnchorSucceeds() public {
        vm.expectEmit(address(a));
        emit EpisodeAnchored(fleet, ep, root, 12, 2, 1, 1);
        vm.prank(base);
        a.anchor(fleet, ep, root, 12, 2, 1, 1);
        assertEq(a.rootOf(ep), root);
    }

    function test_secondAnchorForSameEpisodeReverts() public {
        vm.startPrank(base);
        a.anchor(fleet, ep, root, 1, 0, 0, 0);
        vm.expectRevert("already anchored");
        a.anchor(fleet, ep, keccak256("other root"), 1, 0, 0, 0);
    }

    function test_callerOtherThanBaseReverts() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert("only the base");
        a.anchor(fleet, ep, root, 1, 0, 0, 0);
    }

    function test_emptyRootReverts() public {
        vm.prank(base);
        vm.expectRevert("empty root");
        a.anchor(fleet, ep, bytes32(0), 1, 0, 0, 0);
    }
}
