# ProofCheck — a wallet & contract risk snapshot agent

**Built for the zkVerify Agent Games, Wildcard track.**
Agent owner: [@ajatsudrajdat](https://x.com/ajatsudrajdat) · Sibling entry: NGADUKUN-1 (Proof Gatekeeper + Steal the VFY)

## The problem

Every day, people send crypto to addresses they know nothing about: a seller
in a marketplace chat, a "support" account in DMs, a contract linked from a
post. The chain already knows a lot about that address — whether it has ever
done anything, whether it is a wallet or a contract, whether it holds
anything — but that information sits behind block explorers and raw RPC
calls that most people never make.

**ProofCheck turns that first check into one request.** Give it an address;
it reads the live chain state and answers in plain language.

## Who it helps

- A buyer about to pay a seller they met online.
- A user about to interact with an unfamiliar contract.
- A community moderator vetting a wallet that just showed up.

## What it does

`GET /check?address=0x...&chain=ethereum` (or the same as a POST) returns:

- whether the address is a personal wallet (EOA) or a contract, and the
  contract's code size;
- its balance and how many transactions it has ever sent;
- plain-language flags (e.g. *"No on-chain history at all — treat as an
  unproven counterparty"*, *"Funded but has never sent a transaction"*) and an
  overall signal: `OK`, `NOTICE`, or `CAUTION`;
- the **block number** every figure was read at, and a **SHA-256 report
  hash** of the report's contents.

Supported chains: Ethereum, Base, Arbitrum (public RPC endpoints, no API
keys).

## The checkable claim (verifiability)

A risk report is only useful if you can trust the report itself. ProofCheck
pins every read to one block and hashes the resulting report. Anyone can
re-read the same address at the same block and recompute the hash: if the
numbers had been edited after the fact, the hash would not match. The report
is a claim with a receipt — the same "don't trust, verify" pattern as the
arena tracks of the Agent Games, and a natural fit for zkVerify-style proof
verification if the snapshot is later attested on-chain.

## How it works / key decisions

- **Zero dependencies.** Node's built-in HTTP server and `fetch` speaking
  JSON-RPC directly. Nothing to install, nothing to patch — the whole agent
  is one readable file (`server.js`).
- **One block, three reads.** Balance, transaction count, and contract code
  are all read at the same block height, so a report never mixes states from
  different moments.
- **Honest heuristics.** The flags are deliberately simple and explain
  themselves. ProofCheck says, in every report, that it is *a snapshot, not
  a verdict*: it cannot see off-chain behaviour, approvals granted on other
  chains, or intent. It is a first check, not the only check.
- **Public RPCs with failover.** Each chain lists two public endpoints; if
  one fails, the next is tried.

## What it cannot do

- It does not label scams. A fresh wallet is a *caution*, not an accusation —
  every legitimate user was new once.
- It does not inspect token approvals, transaction contents, or other
  chains unless asked one chain at a time.
- Historical reads depend on the public RPCs' retention; the hash pins what
  was reported, and figures are always read live at request time.

## Run it

```bash
npm start          # listens on $PORT (default 8080)
curl localhost:8080/health
curl "localhost:8080/check?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&chain=ethereum"
```

## Example report (abridged)

```json
{
  "agent": "ProofCheck",
  "chain": "ethereum",
  "blockNumber": 23800000,
  "address": "0x...",
  "kind": "wallet (EOA)",
  "balance": "12.500000 ETH",
  "transactionsSent": 341,
  "riskSignal": "OK",
  "flags": [{ "level": "ok", "text": "Established wallet: holds a balance and has a real sending history." }],
  "reportHash": "0x..."
}
```
