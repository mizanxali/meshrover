// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

/// One record per finished episode: where its log lives on 0G Storage and what it holds.
/// The chain is the record, never the control path: no rover reads this contract.
contract EpisodeAnchor {
    event EpisodeAnchored(
        bytes32 indexed fleet,
        bytes32 indexed episodeId,
        bytes32 storageRoot,
        uint32 decisions,
        uint32 safeStops,
        uint32 approvals,
        uint32 denials
    );

    address public immutable base;
    mapping(bytes32 episodeId => bytes32 storageRoot) public rootOf;

    constructor(address base_) {
        base = base_;
    }

    function anchor(
        bytes32 fleet,
        bytes32 episodeId,
        bytes32 storageRoot,
        uint32 decisions,
        uint32 safeStops,
        uint32 approvals,
        uint32 denials
    ) external {
        require(msg.sender == base, "only the base");
        require(storageRoot != bytes32(0), "empty root");
        require(rootOf[episodeId] == bytes32(0), "already anchored");
        rootOf[episodeId] = storageRoot;
        emit EpisodeAnchored(fleet, episodeId, storageRoot, decisions, safeStops, approvals, denials);
    }
}
