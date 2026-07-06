# D12 re-verification — nostr-js-sdk 0.6.0 self-wrap opt-out

**Date:** 2026-07-06
**Context:** [DROP Item 14] flagged that nostr-js-sdk 0.6.0 was suspected to *not* supersede
sphere-sdk's own NIP-17 self-wrap opt-out (`SendMessageOptions.selfWrap`, #555/#558/#614), but no
0.6.0 tarball was extractable on the machine at investigation time (all local `node_modules` were
pinned to 0.5.0). This note re-verifies against a real 0.6.0 install.

## What was checked

- Package: `@unicitylabs/nostr-js-sdk`
- Version installed in `/home/vrogojin/uxf/node_modules`: `0.5.0`
- Version fetched fresh for this check: `0.6.0` (via `npm view @unicitylabs/nostr-js-sdk@0.6.0
  dist.tarball` → `https://registry.npmjs.org/@unicitylabs/nostr-js-sdk/-/nostr-js-sdk-0.6.0.tgz`),
  extracted to a scratch directory (not committed to the repo).

## Finding

`PrivateMessageOptions` (transport-level message options type) in 0.6.0:

```typescript
// dist/types/messaging/types.d.ts:55-58
export interface PrivateMessageOptions {
    /** Optional event ID this message is replying to */
    replyToEventId?: string;
}
```

`createGiftWrap()` (`dist/types/messaging/nip17.d.ts:24`) takes this same `PrivateMessageOptions`
and has no additional self-wrap-related parameter.

A full-package grep (`grep -rn "selfWrap\|self-wrap\|self_wrap" dist/`) across the entire 0.6.0
`dist/` tree returned **zero matches**.

## Verdict

**No `selfWrap` concept exists in nostr-js-sdk 0.6.0.** The suspicion in [DROP Item 14] is
confirmed: self-wrap opt-out lives entirely in sphere-sdk's own transport layer and nostr-js-sdk
0.6 does not add an equivalent. This means:

- **C1** (`SendMessageOptions` as a whitelisted additive core delta, or extension verb) remains a
  live decision — nostr-js-sdk 0.6 does not make it moot.
- The self-wrap guard in sphere-sdk's `transport/nostr/wire.ts` (or successor location post-split)
  must be preserved regardless of the STSDK/nostr-js-sdk version bump in Phase 6.
- No upstream-PR-supersedes-our-feature scenario applies here; if an upstream PR to
  nostr-js-sdk is ever filed for this capability (as floated in [DROP §4.1]), it has not landed as
  of 0.6.0.

## Evidence paths (scratch, not committed)

- Tarball extracted at: `/tmp/claude-1000/-home-vrogojin-uxf/dc1fd1d7-3f6d-4c05-8c74-819648ba0134/scratchpad/nostr-js-sdk-060/package/`
- Type file: `package/dist/types/messaging/types.d.ts` (lines 55-58)
- NIP-17 wrapper signature: `package/dist/types/messaging/nip17.d.ts` (line 24)
