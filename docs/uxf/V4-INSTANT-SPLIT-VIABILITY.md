# V4 InstantSplit — Production Viability Analysis (#207)

**Status**: V4 (`InstantSplitBundleV4`, `types/instant-split.ts:136`) is **NOT** production-viable as-is. The 2s burn-proof wait that V5 sustains is fundamental to the protocol-level `SplitMintReason` validation; V4's "skip burn proof, ship mint commitments immediately" model is incompatible with the SDK's split semantics. Recommended action: keep V4 dev-mode only, document the constraint, and revisit only if the SDK adopts a redesigned split-proof model.

## Background

PR #207 raised the question of whether V4 could be flipped from dev-mode to production. The hope: ~0.3s sender critical path (vs. ~2.3s in V5) by deferring the burn-proof wait to the receiver's chain-walker.

Prerequisite asserted by the user: the SDK's token-digest computation must be **proof-independent**. We verified this — `Token.toJSON()` (`@unicitylabs/state-transition-sdk/lib/token/Token.d.ts`) and the underlying `MintTransaction` / `TransferTransaction` shapes nest `inclusionProof` as a separate sibling of `data`, and the deterministic identity of a transition is `RequestId.create(publicKey, sourceStateHash)` — neither depends on a proof being present. ✓

But the second constraint, which makes V4 fail in production: **`SplitMintReason` requires a proven burn**.

## SDK constraint — `SplitMintReason` requires a `burnedToken`

`TokenSplitBuilder.createSplitMintCommitments(trustBase, burnTransaction)`
(`node_modules/@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder.js:71-74`):

```js
async createSplitMintCommitments(trustBase, burnTransaction) {
    const burnedToken = await this.token.update(trustBase,
        new TokenState(new BurnPredicate(...), null),
        burnTransaction);
    return Promise.all(this.tokens.map((request) =>
        MintTransactionData.create(..., new SplitMintReason(burnedToken, ...))
            .then((data) => MintCommitment.create(data))));
}
```

Two things make V4 incompatible:

1. **`token.update(trustBase, ..., burnTransaction)`** — verifies the burn transaction's inclusion proof. With only a burn *commitment* (V4's shape), this verification fails. The SDK is the gate; the aggregator is downstream.

2. **`SplitMintReason` carries the burned token state** — a `Token` instance reflecting the post-burn state. That instance cannot be constructed without a proven burn (`token.update()` returns the new `Token`).

Even if we could route around (1) by injecting a synthetic "unverified burned token", the aggregator's mint-commitment validation re-derives the `SplitMintReason` proof chain and would reject mints whose burn isn't anchored. V4's only way around this is "dev mode" — which is exactly the regime where this validation is skipped.

## Failure model if V4 ships in production

Hypothetical V4-production sender flow:
1. Create burn commitment (no proof).
2. Construct mint commitments referencing the unproven burn.
3. Submit mint commitments first → **aggregator rejects** because `SplitMintReason` doesn't validate.

If the aggregator's rejection were silent or asynchronous, the failure model gets worse:
- Sender's UI marks the transfer as "succeeded" after Nostr delivery.
- Receiver runs the chain-walker, sees burn → unprovable, mint → rejected, and has a permanently un-finalizable mint commitment.
- No mechanism on the receiver to undo or detect — the source token state, meanwhile, is in `committedOnChainTokenIds`.

This is the same "stranded receive" pathology #144 / #199 fought to eliminate. V5's 2s burn-proof wait is what prevents the sender from advertising a transfer that can't complete.

## What would V4-production actually require?

Hypothetical redesign that would let V4 work:
- A new aggregator commitment shape that accepts a mint without `SplitMintReason`, then anchors the mint to the eventual burn proof in a later validation round.
- Equivalent SDK support (a `MintTransactionData` variant without `SplitMintReason`, plus a "post-anchor" step that links mint → burn after the burn proves).
- Receiver-side detection + cleanup for the "burn never proved" failure mode (e.g., the sender's burn request collided with another spend of the same source token).

This is a substantial protocol change spanning aggregator, state-transition SDK, and wallet. It is not the kind of change that can be done as a follow-up to #207. If it is desirable, it warrants its own design doc + multi-quarter rollout, independent of UXF self-sufficiency work.

## V4-pending in UXF — orthogonal capability

PR-A's `pending-authenticator` element type (#202) and the null-inclusionProof tolerances in `uxf/assemble.ts` + `uxf/deconstruct.ts` make V4-pending tokens *expressible* in UXF: the synthetic shape with null genesis proof + sender-signed authenticator is the same regardless of whether the burn has proof yet.

So if a V4 redesign ever lands, UXF will already accept its tokens. The current blocker is the SDK / aggregator layer, not the serialization layer.

## Recommendation

- V4 stays dev-mode only (`devMode: true` in `InstantSplitOptions`).
- The dev-mode comment in `types/instant-split.ts:134` already calls this out: "V4 only works in dev mode. Production requires V5 with proper SplitMintReason."
- No PR #207 work changes this. The viability question raised in #207 is **answered: not feasible** at the current protocol level.
- If/when the protocol redesign happens, revisit this doc.

## References

- `types/instant-split.ts:136` — `InstantSplitBundleV4`
- `node_modules/@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder.js:71-74` — `createSplitMintCommitments` (the SDK constraint)
- `node_modules/@unicitylabs/state-transition-sdk/lib/token/fungible/SplitMintReason.d.ts` — proof-bound mint reason
- `modules/payments/InstantSplitExecutor.ts:240-256` — V5 sender's burn-proof wait
- Issue #207 — original scope question
