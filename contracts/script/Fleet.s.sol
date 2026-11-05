// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

// The fleet namespace on ENSv2 (Sepolia). Interfaces are cut from the deployed
// ABIs of ensdomains/contracts-v2 @ deploy/mainnet-v2-20261002 (the branch Sepolia runs).
// Registering the .eth name is commit-reveal, so this runs twice, at least 60 s apart:
//   forge script script/Fleet.s.sol --sig "commit()" --rpc-url sepolia --account base --broadcast
//   forge script script/Fleet.s.sol --rpc-url sepolia --account base --broadcast
// That makes the fleet name, its UserRegistry and rover-a. Then the rest of the
// fleet, with the engines' mesh invites in the environment:
//   eval "$(npm run -s invites)"
//   forge script script/Fleet.s.sol --sig "members()" --rpc-url sepolia --account base --broadcast
// Each of these ends by writing every text record; `--sig "records()"` writes
// them again on their own (after an engine gets a new key, say).
// Our keys are ENSIP-5 service keys in the fleet name's own namespace,
// reversed: eth.meshrover-demo.members (on the fleet name), .role and .invite
// (the member's mesh invite: INVITE_ROVER_A and so on). Robots also get
// ENSIP-26 agent-context, and agent-endpoint[web] when AGENT_ENDPOINT is set.
// Optional: CONTRACTOR_EXPIRY (Unix s, default 2 hours from now), ALICE_WALLET
// (may then set her own invite record, and no other).

struct Grant {
    address account;
    uint256 roleBitmap;
}

interface IETHRegistrar {
    function isAvailable(string calldata label) external view returns (bool);
    function getRegisterPrice(string calldata label, uint64 duration, address paymentToken)
        external view returns (uint256 base, uint256 premium);
    function makeCommitment(string calldata label, address owner, bytes32 secret, address subregistry,
        address resolver, uint64 duration, bytes32 referrer) external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function register(string calldata label, address owner, bytes32 secret, address subregistry, address resolver,
        uint64 duration, address paymentToken, bytes32 referrer) external returns (uint256 tokenId);
}

interface IRegistry {
    function register(string calldata label, address owner, address registry, address resolver, uint256 roleBitmap,
        uint64 expiry) external returns (uint256 tokenId);
    function setParent(address parent, string calldata label) external;
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IETHRegistryRead {
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IUserRegistry {
    function initialize(Grant[] calldata grants) external;
}

interface IPermissionedResolver {
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
}

interface IMockUSDC {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

contract Fleet is Script {
    IETHRegistrar constant REGISTRAR = IETHRegistrar(0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3);
    IRegistry constant ETH_REGISTRY = IRegistry(0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4);
    IVerifiableFactory constant FACTORY = IVerifiableFactory(0xDa70306C98E97eCe36F997a21368e53298572991);
    address constant USER_REGISTRY_IMPL = 0x9BD8a88719068D09ecee662f36C0E3856708366a;
    address constant RESOLVER_IMPL = 0x115eb53F0c60696633855F90b138178Fb40b2b2C;
    IMockUSDC constant USDC = IMockUSDC(0x240b0316Df57887DBBE58b586508b19e633a14aa);

    /// One unit in every role nybble (EACBaseRolesLib.ALL_ROLES): admins need the base
    /// roles themselves, not only the *_ADMIN ones, to call register/setText.
    uint256 constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint64 constant DURATION = 365 days;
    uint64 constant ROBOT_EXPIRY_FROM_NOW = 365 days;

    function label() internal view returns (string memory) {
        return vm.envOr("FLEET_LABEL", string("meshrover-demo"));
    }

    // ponytail: secret derived from label+owner so commit() and run() agree without a file;
    // front-running a testnet registration isn't a threat worth a stored random secret.
    function secret(address owner) internal view returns (bytes32) {
        return keccak256(abi.encode("meshrover", label(), owner));
    }

    function commit() external {
        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        require(REGISTRAR.isAvailable(label()), "name not available");
        REGISTRAR.commit(REGISTRAR.makeCommitment(label(), owner, secret(owner), address(0), address(0), DURATION, 0));
        vm.stopBroadcast();
        console.log("committed", label(), "- wait 60 s, then run()");
    }

    function run() external {
        string memory fleet = label();
        vm.startBroadcast();
        (, address admin,) = vm.readCallers();
        Grant[] memory adminAll = new Grant[](1);
        adminAll[0] = Grant(admin, ALL_ROLES);

        // The fleet's own registry, deployed first so the name points at it from registration.
        address registry = FACTORY.deployProxy(
            USER_REGISTRY_IMPL, uint256(keccak256(abi.encode(fleet, "registry"))),
            abi.encodeCall(IUserRegistry.initialize, (adminAll))
        );
        address fleetResolver = newResolver(fleet, "fleet", adminAll);

        // The commitment was made with no subregistry/resolver, so register with none, then set them:
        // the registrant holds ROLE_SET_SUBREGISTRY and ROLE_SET_RESOLVER on the name.
        (uint256 base, uint256 premium) = REGISTRAR.getRegisterPrice(fleet, DURATION, address(USDC));
        USDC.mint(admin, base + premium);
        USDC.approve(address(REGISTRAR), base + premium);
        uint256 tokenId =
            REGISTRAR.register(fleet, admin, secret(admin), address(0), address(0), DURATION, address(USDC), 0);
        IRegistryAdmin(address(ETH_REGISTRY)).setSubregistry(tokenId, registry);
        IRegistryAdmin(address(ETH_REGISTRY)).setResolver(tokenId, fleetResolver);
        IRegistry(registry).setParent(address(ETH_REGISTRY), fleet);

        // One subname, its own resolver (a setter grant covers every name an instance serves).
        address roverResolver = newResolver(fleet, "rover-a", adminAll);
        IRegistry(registry).register(
            "rover-a", admin, address(0), roverResolver, 0, uint64(block.timestamp) + ROBOT_EXPIRY_FROM_NOW
        );
        writeRecords(IRegistry(registry), fleet);
        vm.stopBroadcast();

        console.log("fleet registry", registry);
        console.log("fleet resolver", fleetResolver);
        console.log("rover-a resolver", roverResolver);
    }

    /// Every member after rover-a, each with its own resolver: a setter grant covers every name an instance serves.
    function members() external {
        string memory fleet = label();
        IRegistry registry = IRegistry(IETHRegistryRead(address(ETH_REGISTRY)).getSubregistry(fleet));
        vm.startBroadcast();
        (, address admin,) = vm.readCallers();
        Grant[] memory adminAll = new Grant[](1);
        adminAll[0] = Grant(admin, ALL_ROLES);
        (string[5] memory subs,,) = fleetMembers();
        for (uint256 i = 1; i < subs.length; i++) {
            // A contractor's name lapses on its own: past its expiry the registry treats it as unregistered.
            uint64 expiry = keccak256(bytes(subs[i])) == keccak256("ravi-contractor")
                ? uint64(vm.envOr("CONTRACTOR_EXPIRY", block.timestamp + 2 hours))
                : uint64(block.timestamp) + 365 days;
            registry.register(subs[i], admin, address(0), newResolver(fleet, subs[i], adminAll), 0, expiry);
        }
        writeRecords(registry, fleet);

        // Alice's own wallet may set her invite record (a new phone), and no other record.
        address alice = vm.envOr("ALICE_WALLET", address(0));
        if (alice != address(0)) {
            bytes memory name = dnsEncode("alice", fleet);
            IPermissionedResolver(registry.getResolver("alice"))
                .grantSetterRoles(abi.encodeCall(IPermissionedResolver.setText, (name, key("invite"), "")), alice);
        }
        vm.stopBroadcast();
    }

    /// Every text record again, e.g. after an engine's key changes.
    function records() external {
        string memory fleet = label();
        IRegistry registry = IRegistry(IETHRegistryRead(address(ETH_REGISTRY)).getSubregistry(fleet));
        vm.startBroadcast();
        writeRecords(registry, fleet);
        vm.stopBroadcast();
    }

    /// The fleet: label, role, and the environment variable holding its mesh invite. rover-a comes first (run()).
    function fleetMembers() internal pure returns (string[5] memory subs, string[5] memory roles, string[5] memory invites) {
        subs = ["rover-a", "rover-b", "base", "alice", "ravi-contractor"];
        roles = ["robot", "robot", "base", "supervisor", "operator"];
        invites = ["INVITE_ROVER_A", "INVITE_ROVER_B", "INVITE_BASE", "INVITE_ALICE", "INVITE_RAVI_CONTRACTOR"];
    }

    /// A text record key in the fleet's own namespace (ENSIP-5 service key), e.g. eth.meshrover-demo.role.
    function key(string memory k) internal view returns (string memory) {
        return string.concat("eth.", label(), ".", k);
    }

    function writeRecords(IRegistry registry, string memory fleet) internal {
        (string[5] memory subs, string[5] memory roles, string[5] memory invites) = fleetMembers();
        string memory list = subs[0];
        for (uint256 i; i < subs.length; i++) {
            if (i > 0) list = string.concat(list, ",", subs[i]);
            address resolver = registry.getResolver(subs[i]);
            if (resolver == address(0)) continue; // not registered yet, or expired
            bytes memory name = dnsEncode(subs[i], fleet);
            IPermissionedResolver(resolver).setText(name, key("role"), roles[i]);
            string memory invite = vm.envOr(invites[i], string(""));
            if (bytes(invite).length > 0) IPermissionedResolver(resolver).setText(name, key("invite"), invite);
            if (keccak256(bytes(roles[i])) == keccak256("robot")) robotRecords(resolver, name);
        }
        IPermissionedResolver(IETHRegistryRead(address(ETH_REGISTRY)).getResolver(fleet))
            .setText(dnsEncode(fleet, ""), key("members"), list);
    }

    /// ENSIP-26 agent records on a robot.
    function robotRecords(address resolver, bytes memory name) internal {
        IPermissionedResolver(resolver).setText(name, "agent-context",
            "Mesh Rover warehouse rover (simulated). Moves only on 0G decisions relayed by the fleet's base over an offline mesh; obeys only keys this fleet's ENS roster lists.");
        string memory endpoint = vm.envOr("AGENT_ENDPOINT", string(""));
        if (bytes(endpoint).length > 0) IPermissionedResolver(resolver).setText(name, "agent-endpoint[web]", endpoint);
    }

    function newResolver(string memory fleet, string memory sub, Grant[] memory grants) internal returns (address) {
        return FACTORY.deployProxy(
            RESOLVER_IMPL, uint256(keccak256(abi.encode(fleet, sub, "resolver"))),
            abi.encodeCall(IPermissionedResolver.initialize, (grants, new bytes[](0)))
        );
    }

    /// DNS wire format for `<a>.<b>.eth`, or `<a>.eth` when `b` is empty.
    function dnsEncode(string memory a, string memory b) internal pure returns (bytes memory) {
        bytes memory out = abi.encodePacked(uint8(bytes(a).length), a);
        if (bytes(b).length > 0) out = abi.encodePacked(out, uint8(bytes(b).length), b);
        return abi.encodePacked(out, uint8(3), "eth", uint8(0));
    }
}

interface IRegistryAdmin {
    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;
}
