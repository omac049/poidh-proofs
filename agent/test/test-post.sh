#!/bin/bash
# Tests for posting to X from the signer (sign-requests.mjs and x.mjs), with no chain and no X:
# claim.mjs is replaced by test/stub-claim.mjs, and X by test/mock-x.py, which checks every
# request's OAuth signature on its own.
#   bash poidh/agent/test/test-post.sh
T=${POIDH_TEST_DIR:-$HOME/.cache/poidh-agent-test}/post-$$
A=$(cd "$(dirname "$0")/.." && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p $T/agent $T/www
cp $A/sign-requests.mjs $A/x.mjs $T/agent/ && cp $HERE/stub-claim.mjs $T/agent/claim.mjs
SHA=0123456789abcdef0123456789abcdef01234567
mkdir -p $T/www/$SHA/proofs/t && cp $A/../proofs/1484/omars-agent-claim-1484.png $T/www/$SHA/proofs/t/pic.png
echo "not a png" > $T/www/$SHA/proofs/t/fake.png
python3 -I $HERE/serve.py $T/www > /dev/null 2>&1 & SERVE=$!
python3 -I $HERE/mock-x.py 8098 $T/posted.jsonl > /dev/null 2>&1 & MOCK=$!
trap 'kill $SERVE $MOCK 2>/dev/null' EXIT; sleep 1
export X_API_BASE=http://127.0.0.1:8098 POST_MEDIA_ROOT=http://127.0.0.1:8099/ STUB_STATE=$T/stub-state.json STUB_LOG=$T/stub.log
export X_API_KEY=ck-test-1234 X_API_SECRET=cs-test-5678 X_ACCESS_TOKEN=at-test-9012 X_ACCESS_TOKEN_SECRET=ats-test-3456
export POIDH_AGENT_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
IMG=http://127.0.0.1:8099/$SHA/proofs/t/pic.png
LOG=$T/test-post.log; : > $LOG; pass=0; fail=0
ok(){ pass=$((pass+1)); echo "PASS $1"; }
no(){ fail=$((fail+1)); echo "FAIL $1"; [ -n "$2" ] && echo "$2" | tail -5; }
posts(){ [ -f $T/posted.jsonl ] && wc -l < $T/posted.jsonl || echo 0; }
# run <records dir> <expected exit> [env...]: runs the signer on $T/requests and $T/posts
run(){ local rec=$1 want=$2; shift 2; mkdir -p $rec
  out=$(env POST_RECORDS_DIR=$rec "$@" node $T/agent/sign-requests.mjs $T/requests $T/posts 2>&1); code=$?; echo "$out" >> $LOG
  [ "$code" = "$want" ] || no "exit code $code, expected $want" "$out"; }
has(){ if echo "$out" | grep -qF -- "$2"; then ok "$1"; else no "$1" "$out"; fi; }
req(){ printf '%s' "$2" > "$1"; }

# ---- x.mjs on its own ----
v=$(cd $T/agent && node -e "import('./x.mjs').then(({oauthHeader:o,postWeight:w})=>{
  const h=o('POST','https://api.twitter.com/1.1/statuses/update.json?include_entities=true',{consumerKey:'xvz1evFS4wEEPTGEFPHBog',consumerSecret:'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',token:'370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',tokenSecret:'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE'},{params:{status:'Hello Ladies + Gentlemen, a signed OAuth request!'},nonce:'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',timestamp:1318622958});
  console.log(h.includes('oauth_signature=\"hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D\"'), w('a'.repeat(280)), w('see https://poidh.xyz/base/bounty/1 ok'), w('poidh.xyz'), w('🌍'))})")
[ "$v" = "true 280 30 23 2" ] && ok "OAuth signature matches X's published example; length counting" || no "x.mjs unit checks: $v"

# ---- dry run: everything checked, nothing posted or claimed ----
mkdir -p $T/requests $T/posts
req $T/requests/base-101.json '{"chain":"base","bounty":101,"title":"t","description":"What the agent did.","proof_uri":"'$IMG'","post":{"text":"Agent post for poidh bounty 101 @poidhxyz https://poidh.xyz/base/bounty/101","media_uri":"'$IMG'"}}'
run $T/rec1 0 SIGNER_DRY_RUN=true
has "dry run would post with the image" "base-101.json: dry run, would post"
has "dry run passes the claim" "base-101.json: dry run passed"
[ "$(posts)" = 0 ] && [ -z "$(ls $T/rec1)" ] && ok "dry run posted nothing" || no "dry run posted"

# ---- a real run ----
req $T/requests/base-102.json '{"chain":"base","bounty":102,"title":"t","description":"no post","proof_uri":"'$IMG'"}'
req $T/requests/base-103.json '{"chain":"base","bounty":103,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"'$(printf 'a%.0s' $(seq 281))'"}}'
req $T/requests/base-104.json '{"chain":"base","bounty":104,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"hi","media_uri":"https://evil.example/x.png"}}'
req $T/requests/base-105.json '{"chain":"base","bounty":105,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"hi","reply_to":"1"}}'
req $T/requests/base-106.json '{"chain":"base","bounty":106,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"hi","media_uri":"http://127.0.0.1:8099/'$SHA'/proofs/t/fake.png"}}'
req $T/requests/base-107.json '{"chain":"base","bounty":107,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"@a @b @c @d hi"}}'
req $T/requests/base-303.json '{"chain":"base","bounty":303,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"claim would fail"}}'
req $T/posts/mainnet-37.json '{"chain":"mainnet","bounty":37,"post":{"text":"I sent an AI agent into New Eden. @ac6kdev"}}'
req $T/posts/base-404.json '{"chain":"base","bounty":404,"post":{"text":"closed bounty"}}'
req $T/posts/arbitrum-5.json '{"chain":"arbitrum","bounty":5,"post":{"text":"wrong chain"}}'
run $T/rec1 0
has "post made before the claim" "base-101.json: posted https://x.com/i/status/"
has "claim made after the post" "base-101.json: claimed, claim 1"
if grep '"cmd":"claim"' $T/stub.log | grep '"bounty":"101"' | grep -v dry-run | grep -q 'Post on X: https://x.com/i/status/9'; then ok "claim description carries the post link"; else no "claim description lacks the post link"; fi
if head -1 $T/posted.jsonl | grep -q '"media_ids": \["9'; then ok "post carries the uploaded image"; else no "post has no image" "$(cat $T/posted.jsonl)"; fi
has "request without a post still claims" "base-102.json: claimed"
has "over-long post refused" "base-103.json: skipped, post text counts 281 of X's 280"
has "image from another host refused" 'base-104.json: skipped, "post.media_uri" must be'
has "unknown post field refused" 'base-105.json: skipped, unknown post field(s) "reply_to"'
has "image that is not really a PNG refused" "base-106.json: refused, the post image is not really image/png"
has "too many mentions refused" "base-107.json: skipped, post text mentions 4 accounts"
has "failing claim stops the post" "base-303.json: refused, Refused: Proof URI returned HTTP 404."
has "post-only draft posted" "posts/mainnet-37.json: posted https://x.com/i/status/"
has "post-only draft for a closed bounty skipped" "posts/base-404.json: skipped, the bounty is closed or cancelled"
has "post-only draft on an unlisted chain skipped" "posts/arbitrum-5.json: skipped, chain must be one of base, mainnet"
[ "$(posts)" = 2 ] && ok "exactly two posts made" || no "posts made: $(posts)"
[ "$(ls $T/rec1 | sort | tr '\n' ' ')" = "base-101.json mainnet-37.json " ] && ok "both posts recorded" || no "records: $(ls $T/rec1)"

# ---- the same files again: nothing is posted twice ----
run $T/rec1 0
has "claimed request not reposted" "base-101.json: already claimed"
has "post-only draft not reposted" "posts/mainnet-37.json: already posted, https://x.com/i/status/"
[ "$(posts)" = 2 ] && ok "second run posted nothing" || no "second run posted: $(posts)"

# ---- a post that landed but whose claim failed is reused, not reposted ----
rm $T/requests/*.json $T/posts/*.json
printf '{"chain":"base","bounty":"108","id":"5","url":"https://x.com/i/status/5","postedAt":%s}\n' $(( $(date +%s) - 90000 )) > $T/rec1/base-108.json
req $T/requests/base-108.json '{"chain":"base","bounty":108,"title":"t","description":"d","proof_uri":"'$IMG'","post":{"text":"already out"}}'
run $T/rec1 0
has "recorded post reused for the claim" "base-108.json: claimed"
if grep '"bounty":"108"' $T/stub.log | grep -v dry-run | grep -q 'Post on X: https://x.com/i/status/5"'; then ok "reused link in the claim"; else no "reused link missing"; fi
[ "$(posts)" = 2 ] && ok "no new post for a recorded bounty" || no "posts: $(posts)"

# ---- daily cap: 3 posts in 24 hours ----
rm $T/requests/*.json
req $T/posts/base-501.json '{"chain":"base","bounty":501,"post":{"text":"third post today"}}'
req $T/posts/base-502.json '{"chain":"base","bounty":502,"post":{"text":"fourth post today"}}'
req $T/posts/base-505.json '{"chain":"base","bounty":505,"post":{"text":"open bounty, agent at its claim cap"}}'
run $T/rec1 0
has "third post allowed" "posts/base-501.json: posted"
has "fourth post waits for the cap" "posts/base-502.json: waiting, the daily post cap is reached (3 of 3 in 24 hours)"
has "agent's claim cap does not block a post-only draft" "posts/base-505.json: waiting, the daily post cap"
[ "$(posts)" = 3 ] && ok "cap held at three" || no "posts: $(posts)"

# ---- X refusals ----
rm $T/posts/*.json
req $T/posts/base-601.json '{"chain":"base","bounty":601,"post":{"text":"DUPLICATE text"}}'
run $T/rec2 1
has "X refusal reported" "posts/base-601.json: X refused the post (HTTP 403, Forbidden: You are not allowed to create a Tweet with duplicate content.)"
[ -z "$(ls $T/rec2)" ] && ok "refused post not recorded" || no "refused post recorded"
req $T/posts/base-601.json '{"chain":"base","bounty":601,"post":{"text":"wrong keys"}}'
run $T/rec2 1 X_API_SECRET=cs-wrong-0000
has "bad keys reported" "posts/base-601.json: X refused the post (HTTP 401, Unauthorized: Unauthorized)"
run $T/rec2 0 X_ACCESS_TOKEN_SECRET=
has "missing keys switch posting off" "posts/base-601.json: skipped, posting to X is not set up (X keys missing)"
out=$(env -u POST_RECORDS_DIR node $T/agent/sign-requests.mjs $T/requests $T/posts 2>&1); echo "$out" >> $LOG
has "no records folder switches posting off" "posting needs POST_RECORDS_DIR"
[ "$(posts)" = 3 ] && ok "no posts from refused or unconfigured runs" || no "posts: $(posts)"

# ---- secrets ----
if grep -qF -e ck-test-1234 -e cs-test-5678 -e at-test-9012 -e ats-test-3456 -e 5de4111afa1a4b94 $LOG; then no "a key appears in the output"; else ok "no key in any output"; fi
if grep -q '"xKeyInEnv":true' $T/stub.log; then no "X keys reached claim.mjs"; else ok "X keys never reach claim.mjs"; fi

echo "$pass passed, $fail failed (log: $LOG)"
[ $fail = 0 ]
