#!/bin/bash
# Local-chain tests for poidh/agent/neweden.mjs and the New Eden part of sign-requests.mjs.
# Deploys test/MockEdenWorld.sol on a throwaway anvil chain; claim.mjs is replaced by
# test/stub-claim.mjs, so no poidh contract is needed.
#   bash poidh/agent/test/test-neweden.sh
# First run downloads Foundry, solc 0.8.24 and viem into $T (outside the shared folder).
T=${POIDH_TEST_DIR:-$HOME/.cache/poidh-agent-test}; F=$T/foundry; PORT=8547; R=http://127.0.0.1:$PORT
A=$(cd "$(dirname "$0")/.." && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p $F
if [ ! -x $F/anvil ]; then
  curl -fsSL https://github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.tar.gz | tar xz -C $F
fi
[ -x $F/solc-0.8.24 ] || { curl -fsSL -o $F/solc-0.8.24 https://github.com/ethereum/solidity/releases/download/v0.8.24/solc-static-linux && chmod +x $F/solc-0.8.24; }
S=$T/neweden-$$; mkdir -p $S/agent $S/eden/src
# The agent code under test, with its pinned dependency, and the claim.mjs stand-in.
cp $A/package.json $A/package-lock.json $A/neweden.mjs $A/sign-requests.mjs $A/x.mjs $S/agent/ && cp $HERE/stub-claim.mjs $S/agent/claim.mjs
(cd $S/agent && env -u POIDH_AGENT_KEY npm ci --ignore-scripts --no-audit --no-fund --silent >&2)
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AK=5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
BK=b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1   # an unfunded wallet
$F/anvil --silent --port $PORT > /dev/null 2>&1 & ANVIL=$!
trap 'kill $ANVIL 2>/dev/null' EXIT; sleep 2
cp $HERE/MockEdenWorld.sol $S/eden/src/
WORLD=$(cd $S/eden && $F/forge create src/MockEdenWorld.sol:MockEdenWorld --use $F/solc-0.8.24 --rpc-url $R --private-key $K0 --broadcast 2>&1 | awk '/Deployed to/{print $3}')
AGENT=$($F/cast wallet address 0x$AK)
$F/cast send $AGENT --value 1ether --private-key $K0 --rpc-url $R >/dev/null
export NEWEDEN_TEST_CONTRACT=$WORLD RPC_URL_LOCAL=$R POIDH_AGENT_KEY=0x$AK STUB_STATE=$S/stub-state.json STUB_LOG=$S/stub.log
LOG=$S/test-neweden.log; : > $LOG; pass=0; fail=0
ok(){ pass=$((pass+1)); echo "PASS $1"; }
no(){ fail=$((fail+1)); echo "FAIL $1"; [ -n "$2" ] && echo "$2" | grep -v '^    ' | tail -8; }
posts(){ $F/cast logs --from-block 0 --address $WORLD 'MessagePosted(uint256 indexed,address indexed,uint64,string)' --rpc-url $R 2>/dev/null | grep -c transactionHash; }
# t "name" expected_exit expected_text args...: runs neweden.mjs directly
t(){ local name="$1" want="$2" text="$3"; shift 3
  out=$(node $S/agent/neweden.mjs "$@" --chain=local 2>&1); code=$?; echo "$out" >> $LOG
  if [ "$code" = "$want" ] && echo "$out" | grep -qF -- "$text"; then ok "$name"; else no "$name (exit $code)" "$out"; fi; }

# ---- neweden.mjs on its own ----
t "status before registering" 0 '"registered":false' status
t "post before registering refused" 2 'is not registered in New Eden; register it first' post --room 6 --text "hello"
t "register dry run" 0 '"dryRun":true' register --name "Proof Pilgrim" --description "A wandering notary." --dry-run
[ "$($F/cast call $WORLD 'registered(address)(bool)' $AGENT --rpc-url $R)" = false ] && ok "dry run registered nothing" || no "dry run registered"
t "name with a line break refused" 2 'Name contains control characters' register --name $'Proof\nPilgrim' --description d
t "name over 48 characters refused" 2 'Name is 49 characters' register --name "$(printf 'n%.0s' $(seq 49))" --description d
t "register" 0 '"tx":"0x' register --name "Proof Pilgrim" --description "A wandering notary who only believes a tx hash."
[ "$($F/cast call $WORLD 'names(address)(string)' $AGENT --rpc-url $R)" = '"Proof Pilgrim"' ] && ok "profile stored onchain" || no "profile not stored"
t "status after registering" 0 '"registered":true' status
t "post dry run" 0 '"dryRun":true' post --room 6 --text "VERIFIED | NOTICE #1" --dry-run
[ "$(posts)" = 0 ] && ok "dry run posted nothing" || no "dry run posted: $(posts)"
t "post" 0 '"room":"6"' post --room 6 --text "VERIFIED | NOTICE #1 answered by @Metito"
TX=$(echo "$out" | grep -o '"tx":"0x[0-9a-f]*"' | cut -d'"' -f4)
[ "$($F/cast tx $TX value --rpc-url $R)" = 0 ] && ok "no ETH sent with the post" || no "post carried ETH"
[ "$($F/cast tx $TX to --rpc-url $R | tr A-F a-f)" = "$(echo $WORLD | tr A-F a-f)" ] && ok "post went to the World contract" || no "post went elsewhere"
t "same post again reported, not resent" 0 '"already":true' post --room 6 --text "VERIFIED | NOTICE #1 answered by @Metito"
t "same text in another room is a new post" 0 '"room":"5"' post --room 5 --text "VERIFIED | NOTICE #1 answered by @Metito"
[ "$(posts)" = 2 ] && ok "two posts onchain" || no "posts onchain: $(posts)"
t "room past the last place refused" 2 'Room 8 does not exist' post --room 8 --text hi
t "room that is not a number refused" 2 '--room must be a room number' post --room "6; rm -rf /" --text hi
t "text over 512 bytes refused" 2 'Text is 513 bytes; the limit is 512' post --room 6 --text "$(printf 'x%.0s' $(seq 513))"
t "multi-byte text counted in bytes" 2 'Text is 514 bytes' post --room 6 --text "$(printf 'é%.0s' $(seq 257))"
t "control character refused" 2 'Text contains control characters' post --room 6 --text $'bell\x07here'
t "direction override refused" 2 'Text contains control characters' post --room 6 --text $'abc\xe2\x80\xaedef'
t "key in text refused" 2 'Text contains the private key' post --room 6 --text "key $AK"
t "contract rejection refused before sending" 2 'The World contract would reject this: Invalid' post --room 6 --text "reject me"
NEWEDEN_TEST_MAX_FEE=0.000000000001 t "fee over the cap refused" 2 'above the 0.000000000001 ETH cap' post --room 6 --text "fee test"
out=$(node $S/agent/neweden.mjs post --chain=base --room 6 --text hi 2>&1); code=$?; echo "$out" >> $LOG
[ $code = 2 ] && echo "$out" | grep -qF 'Unknown chain "base". New Eden runs on mainnet.' && ok "unknown chain refused" || no "unknown chain refused" "$out"
t "unknown command refused" 2 'Command must be status, register or post' create --room 6
POIDH_AGENT_KEY= t "post without a key refused" 2 'POIDH_AGENT_KEY is not set' post --room 6 --text hi
POIDH_AGENT_KEY= t "read-only status by address needs no key" 0 '"registered":true' status --address $AGENT
POIDH_AGENT_KEY=0x$BK t "empty wallet refused" 2 'register it first' post --room 6 --text hi
POIDH_AGENT_KEY=0x$BK t "empty wallet cannot pay the fee" 2 'Wallet holds 0 ETH, less than the' register --name B --description b
for i in 3 4 5 6; do t "post $i of 6" 0 '"tx":"0x' post --room 0 --text "post number $i"; done
t "seventh post in a day refused" 2 'The daily cap is reached (6 of 6 posts' post --room 0 --text "post number 7"
t "a repeat is still reported at the cap" 0 '"already":true' post --room 0 --text "post number 3"
[ "$(posts)" = 6 ] && ok "six posts onchain" || no "posts onchain: $(posts)"

# ---- the signer ----
$F/cast rpc anvil_mine 7300 --rpc-url $R >/dev/null   # a day of blocks: the onchain cap starts over
Q=$S/requests; E=$S/neweden; mkdir -p $Q $E/done
req(){ printf '%s' "$2" > "$E/$1"; }
# s "name" expected_exit records_dir env text...: runs the signer with all three folders
s(){ local name="$1" want="$2" rec="$3" envs="$4"; shift 4; mkdir -p $rec
  out=$(env POST_RECORDS_DIR=$rec $envs node $S/agent/sign-requests.mjs $Q $S/posts $E 2>&1); code=$?; echo "$out" >> $LOG
  local good=1; [ "$code" = "$want" ] || good=0
  for text in "$@"; do echo "$out" | grep -qF -- "$text" || good=0; done
  if [ $good = 1 ]; then ok "$name"; else no "$name (exit $code)" "$out"; fi; }
out=$(POST_RECORDS_DIR=$S/rec0 node $S/agent/sign-requests.mjs $Q $S/posts 2>&1); echo "$out" >> $LOG
echo "$out" | grep -qF 'New Eden: off, no neweden folder given' && ok "off without the folder" || no "off without the folder" "$out"
out=$(env -u POST_RECORDS_DIR node $S/agent/sign-requests.mjs $Q $S/posts $E 2>&1); echo "$out" >> $LOG
echo "$out" | grep -qF 'New Eden: off, no POST_RECORDS_DIR' && ok "off without a records folder" || no "off without a records folder" "$out"
req neweden-1.json '{"chain":"local","action":"register","name":"Proof Pilgrim","description":"Same agent, now signing for itself."}'
req neweden-2.json '{"chain":"local","action":"post","room":6,"text":"NOTICE #2 | REQUEST: buy the first ticket"}'
req neweden-10.json '{"chain":"local","action":"post","room":5,"text":"--dry-run $(touch '$S'/pwned) @Metito your soda is verified"}'
req neweden-3.json '{"chain":"local","action":"post","room":6,"text":"x","name":"extra"}'
req neweden-4.json '{"chain":"base","action":"post","room":6,"text":"wrong chain"}'
req neweden-5.json '{"chain":"local","action":"create","room":6,"text":"not allowed"}'
req neweden-6.json '{"chain":"local","action":"post","room":"6","text":"room as a string"}'
req neweden-7.json "{\"chain\":\"local\",\"action\":\"post\",\"room\":6,\"text\":\"bell\\u0007\"}"
req neweden-8.json '{"chain":"local","action":"post","room":99,"text":"no such room"}'
req neweden-9.json "{not json $AK"
req post-11.json '{"chain":"local","action":"post","room":6,"text":"bad name"}'
req done/neweden-13.json '{"chain":"local","action":"post","room":6,"text":"in done/"}'
s "dry run checks without sending" 0 $S/rec1 "SIGNER_DRY_RUN=true NEWEDEN_CHAINS=local" "New Eden: on (local)" "neweden/neweden-1.json: dry run passed"
[ "$($F/cast call $WORLD 'names(address)(string)' $AGENT --rpc-url $R)" = '"Proof Pilgrim"' ] && [ "$(posts)" = 6 ] && [ -z "$(ls $S/rec1)" ] && ok "dry run sent and recorded nothing" || no "dry run sent something"
s "first run" 0 $S/rec1 "NEWEDEN_CHAINS=local" "neweden/neweden-1.json: registered, local tx 0x" "neweden/neweden-2.json: posted, local tx 0x" "neweden/neweden-10.json: posted, local tx 0x" \
  'neweden/neweden-3.json: skipped, a post request does not take "name"' "neweden/neweden-4.json: skipped, chain must be one of local" \
  'neweden/neweden-5.json: skipped, "action" must be "post" or "register"' 'neweden/neweden-6.json: skipped, "room" must be a room number' \
  'neweden/neweden-7.json: skipped, "text" contains control characters' "neweden/neweden-8.json: refused, Refused: Room 99 does not exist" \
  "neweden/neweden-9.json: skipped, not valid JSON" "11 files in neweden; handling the first 10 this run"
echo "$out" | grep -o 'neweden-[0-9]*\.json: \(registered\|posted\)' | tr '\n' ' ' | grep -qF 'neweden-1.json: registered neweden-2.json: posted neweden-10.json: posted' && ok "requests run in number order" || no "order" "$out"
[ "$($F/cast call $WORLD 'names(address)(string)' $AGENT --rpc-url $R)" = '"Proof Pilgrim"' ] && ok "register request updated the profile" || no "profile"
[ "$(posts)" = 8 ] && ok "two new posts onchain" || no "posts onchain: $(posts)"
[ "$(ls $S/rec1 | sort | tr '\n' ' ')" = "neweden-1.json neweden-10.json neweden-2.json " ] && ok "each sent request recorded" || no "records: $(ls $S/rec1)"
grep -q '"tx":"0x[0-9a-f]\{64\}"' $S/rec1/neweden-2.json && ok "record holds the transaction" || no "record: $(cat $S/rec1/neweden-2.json)"
if echo "$out" | grep -q 'neweden-13'; then no "signer read done/"; else ok "signer ignores done/"; fi
HEX=$(printf '%s' '--dry-run $(touch' | od -An -tx1 | tr -d ' \n')
[ ! -e $S/pwned ] && $F/cast logs --from-block 0 --address $WORLD 'MessagePosted(uint256 indexed,address indexed,uint64,string)' --rpc-url $R | grep -q "$HEX" && ok "request text posted literally" || no "request text not literal"
s "second run sends nothing again" 0 $S/rec1 "NEWEDEN_CHAINS=local" "neweden/neweden-1.json: already done" "neweden/neweden-2.json: already done" "neweden/neweden-10.json: already done"
[ "$(posts)" = 8 ] && ok "no posts from the second run" || no "posts onchain: $(posts)"
rm $S/rec1/neweden-2.json
s "lost record: post found onchain, not resent" 0 $S/rec1 "NEWEDEN_CHAINS=local" "neweden/neweden-2.json: already posted, local tx 0x"
[ "$(posts)" = 8 ] && [ -f $S/rec1/neweden-2.json ] && ok "found post recorded again, nothing resent" || no "posts onchain: $(posts)"
rm $E/neweden-*.json; mkdir -p $S/rec2; now=$(date +%s)
for i in 21 22 23 24 25 26; do printf '{"action":"post","chain":"local","tx":"0x%064d","link":"local tx","sentAt":%s}\n' $i $now > $S/rec2/neweden-$i.json; done
printf '{"chain":"base","bounty":"1","id":"5","url":"https://x.com/i/status/5","postedAt":%s}\n' $now > $S/rec2/base-1.json
req neweden-30.json '{"chain":"local","action":"post","room":6,"text":"over the daily cap"}'
req neweden-32.json '{"chain":"local","action":"post","room":6,"text":"--dry-run $(touch '$S'/pwned)","value":"1"}'
s "daily cap from the records" 0 $S/rec2 "NEWEDEN_CHAINS=local" "neweden/neweden-30.json: waiting, the daily New Eden cap is reached (6 of 6 in 24 hours)" \
  'neweden/neweden-32.json: skipped, unknown field(s) "value"' "neweden/post-11.json: skipped, file name must be neweden-<number>.json"
rm $E/neweden-32.json
[ "$(posts)" = 8 ] && ok "nothing sent at the cap" || no "posts onchain: $(posts)"
req neweden-31.json '{"chain":"local","action":"post","room":6,"text":"needs a key"}'
s "contract refusal does not fail the run" 0 $S/rec3 "NEWEDEN_CHAINS=local POIDH_AGENT_KEY=0x$BK" "neweden/neweden-31.json: refused, Refused: The agent wallet"
s "chain left out of NEWEDEN_CHAINS refused" 0 $S/rec3 "" "neweden/neweden-31.json: skipped, chain must be one of mainnet"
s "RPC failure turns the run red" 1 $S/rec3 "NEWEDEN_CHAINS=local RPC_URL_LOCAL=http://127.0.0.1:9" "neweden/neweden-31.json: error, Error:"
if grep -qi "$AK" $LOG; then no "key appeared in output"; else ok "key never printed"; fi
echo "$pass passed, $fail failed (log: $LOG)"
[ $fail = 0 ]
