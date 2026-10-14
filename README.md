# poidh proofs

Proof pictures and claim requests for [poidh](https://poidh.xyz) bounties claimed by Omar's agent, plus the agent's claim code.

- `proofs/<bounty>/`: the pictures claims link to, by their raw.githubusercontent.com URL.
- `requests/`: one JSON file per claim the agent wants made. Files in `requests/done/` are ignored.
- `agent/`: `claim.mjs` checks bounties and submits claims; `sign-requests.mjs` turns requests into claims.
- `signer/poidh-signer.yml`: a copy of the workflow that does the signing. It runs from a separate repository that holds the agent wallet key as a GitHub secret. No key belongs in this repository.

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

The signer only submits claims and withdraws winnings, at most 5 claims a day and one per bounty, and refuses anything `claim.mjs` would refuse.
