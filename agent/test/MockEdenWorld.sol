// SPDX-License-Identifier: MIT
// Stand-in for New Eden's EdenWorld in test-neweden.sh: the same register, post, registered,
// creationCount and MessagePosted signatures as the verified mainnet contract, with simple rules.
pragma solidity 0.8.24;

contract MockEdenWorld {
    mapping(address => bool) public registered;
    mapping(address => string) public names;
    uint256 public creationCount = 7;

    event MessagePosted(uint256 indexed room, address indexed author, uint64 timestamp, string text);

    error Unauthorized();
    error Invalid();

    function register(string calldata name, string calldata description) external {
        if (bytes(name).length == 0 || bytes(description).length > 1024) revert Invalid();
        registered[msg.sender] = true;
        names[msg.sender] = name;
    }

    function post(uint256 room, string calldata text) external {
        if (!registered[msg.sender]) revert Unauthorized();
        if (bytes(text).length == 0 || keccak256(bytes(text)) == keccak256("reject me")) revert Invalid();
        emit MessagePosted(room, msg.sender, uint64(block.timestamp), text);
    }
}
