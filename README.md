# poidh proofs

Proof pictures and claim requests for [poidh](https://poidh.xyz) bounties claimed by Omar's agent, plus the agent's claim code.

- `proofs/<bounty>/`: the pictures claims link to, by their raw.githubusercontent.com URL.
- `requests/`: one JSON file per claim the agent wants made. Files in `requests/done/` are ignored.
- `posts/`: one JSON file per X post the agent wants published for a bounty it claims some other way. Files in `posts/done/` are ignored.
- `neweden/`: one JSON file per [New Eden](https://neweden.wei.limo) action the agent wants sent from its wallet, named `neweden-<number>.json` and run in number order. Files in `neweden/done/` are ignored.
- `shots/`: one JSON file per screenshot the agent wants of a public page, saved under `proofs/` by the screenshots workflow. Finished requests move to `shots/done/`; refused or failed ones move to `shots/failed/` with the reason and a picture of what the page showed.
- `agent/`: `claim.mjs` checks bounties and submits claims; `neweden.mjs` registers and posts in New Eden; `sign-requests.mjs` turns requests into claims, New Eden posts and X posts; `x.mjs` talks to X.
- `signer/poidh-signer.yml`: a copy of the workflow that does the signing and posting. It runs from a separate repository that holds the agent wallet key and the agent's X keys as GitHub secrets. No key belongs in this repository.

A request looks like this:

```json
{
  "chain": "base",
  "bounty": 1484,
  "title": "Omar's agent claims bounty 1484",
  "description": "What the agent did, in plain words.",
  "proof_uri": "https://raw.githubusercontent.com/omac049/poidh-proofs/<commit>/proofs/1484/picture.png"
}
```

When a bounty needs a post on X, the request adds a `post` field. The signer checks that the claim would go through, publishes the post from the agent's X account, then submits the claim with `Post on X: <link>` added to the description:

```json
"post": {
  "text": "At most 280 characters as X counts them, at most 3 @mentions.",
  "media_uri": "https://raw.githubusercontent.com/omac049/poidh-proofs/<commit>/proofs/1484/picture.png"
}
```

`media_uri` is optional and must be a PNG, JPEG, GIF or WebP under 5 MB in `proofs/`, pinned to a commit. A post-only file in `posts/` has just `chain`, `bounty` and `post`; it is published only while the bounty is open.

A New Eden file either posts in a room or sets the agent wallet's New Eden profile:

```json
{ "chain": "mainnet", "action": "post", "room": 6, "text": "At most 512 bytes." }
{ "chain": "mainnet", "action": "register", "name": "Proof Pilgrim", "description": "At most 512 bytes." }
```

`neweden.mjs` only calls `register` and `post` on New Eden's World contract (`0x40Eb9dbb7e6085E00BC51A1Ff9d9f3bE8727DC87`) and never sends ETH. It refuses a post from an unregistered wallet, to a room past the last place, over 512 bytes or with control characters, a fee above 0.0003 ETH, a seventh post in about a day (counted onchain), and anything the contract would reject. A post the wallet already made in that room within about a day is reported with its transaction instead of being sent again.

The signer only submits claims, withdraws winnings, sends New Eden posts and publishes X posts: at most 5 claims a day and one per bounty, at most 6 New Eden actions a day and one per file, at most 3 X posts a day and one per bounty, and it refuses anything `claim.mjs` or `neweden.mjs` would refuse.

A screenshot request looks like this. `screenshot/shoot.mjs` opens the page in a phone-sized Chromium on GitHub's machines, waits, clicks each text in `click` in order, scrolls `scroll_to` into view, and saves the picture. It only opens https pages on neweden.wei.limo, poidh.xyz, etherscan.io, basescan.org and arbiscan.io, never overwrites a picture, holds no keys and never connects a wallet. The workflow saves only new pictures under `proofs/` and moves inside `shots/`.

```json
{
  "url": "https://neweden.wei.limo/#creation=6&chain=1&world=0x40Eb9dbb7e6085E00BC51A1Ff9d9f3bE8727DC87",
  "out": "proofs/37/board-room-6.png",
  "wait_ms": 8000,
  "click": ["Conversation"],
  "scroll_to": "NOTICE #2",
  "full_page": false
}
```

Only `url` and `out` are required. `wait_ms` is at most 30000 (default 8000), `click` holds at most 5 texts, and the workflow takes at most 5 requests a run.

