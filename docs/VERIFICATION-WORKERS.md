# Parallel token verification (opt-in)

Every token that arrives is fully verified before it enters the balance: the genesis, then
each transfer in its provenance, against the trust base. That walk is sequential by default
and runs on the calling thread — correct everywhere, and the baseline any other verifier
must match.

Since `@unicitylabs/state-transition-sdk@2.0.2` the independent per-transfer work can be
fanned out to a pool of workers. Sphere exposes that as **opt-in configuration**: pass
`verification` to `Sphere.init()` (or to `EngineConfig` if you build the engine yourself)
and the engine verifies through the pool instead.

The entry-script contract is **unchanged by sphere-sdk 0.15.0's bump to state-transition-sdk
3.0.1**: across 2.1.0 and 3.0.1 the base SDK's `IWorker`, `WorkerTokenVerifier` and the two
`*TransferTransactionVerifierWorker` bases declare the same members with the same signatures
(the whole `.d.ts` diff is one doc-comment link), and only the main-thread side of the engine
moved. The scripts below did change, because they were
incomplete before — the worker base has required **two** verifiers since 2.1.0, and an entry
script supplying only `predicateVerifier` does not compile (`TS2515`). Read [Same major on both
sides](#same-major-on-both-sides) as well: the bump makes an already-latent version mismatch
produce a wrong verdict rather than an error.

**When it is worth it:** long provenance chains — a token that has changed hands many
times — and batch receives, where several such tokens verify at once. A freshly minted
token has nothing to parallelise; leave the option off and nothing changes.

## You own the worker script

The entry script is yours to author and bundle, because only your bundler knows how to emit
a worker. Sphere never spawns one for you.

A worker entry script supplies **two** verifiers, because verifier instances cannot cross the
worker boundary and each side therefore builds its own:

> **Both must be equivalent to the engine's.** The worker builds its `predicateVerifier` and its
> `unicityCertificateVerifier`; the engine builds its own. If either differs, the transfers
> verified in the worker and the genesis verified on the main thread are judged under different
> rules, and the token verdict silently diverges from the sequential one — a wrong **verdict**,
> not an error. `PredicateVerifierService.create()` matches what the engine builds; for the
> certificate verifier, mirror the engine's construction as shown below (the seal cache is a
> per-instance memo, not a rule, so its size is yours to choose and omitting it only costs
> speed).

### Same major on both sides

`tsup` marks `/^@unicitylabs\//` **external** in every sphere-sdk bundle, so the engine resolves
*your* copy of `@unicitylabs/state-transition-sdk` at runtime — and so does your worker entry
script, which imports it directly. Normally that is the point: one copy, one set of rules.

It becomes a trap when the two resolve to different majors. sphere-sdk 0.15.0 pins `3.0.1`
exactly, and v3 changed what a sparse-Merkle leaf commits to — the leaf value is
`H(transactionHash, referenceTime)` where 2.x used the bare transaction hash. **A 2.x worker
paired with a 3.x engine does not throw. It returns a verdict computed under the old rule**, and
the pool path then disagrees with the sequential path on real tokens.

So: keep exactly one `@unicitylabs/state-transition-sdk` in the tree, on the major sphere-sdk
pins, and make sure your worker bundle resolves that same copy (check `npm ls
@unicitylabs/state-transition-sdk` for a duplicate nested under another dependency, and check
that your bundler's worker entry is not aliasing a second copy). If you cannot guarantee it,
leave `verification` unset — the sequential verifier runs inside the engine and cannot diverge
from itself.

### Node

```ts
// verification-worker.mjs — its own module; spawned as a worker thread.
import { PredicateVerifierService } from '@unicitylabs/state-transition-sdk/lib/predicate/verification/PredicateVerifierService.js';
import { UnicityCertificateVerifier } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/UnicityCertificateVerifier.js';
import { UnicitySealQuorumSignaturesVerificationRule } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/rule/UnicitySealQuorumSignaturesVerificationRule.js';
import { VerifiedSealCache } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/VerifiedSealCache.js';
import { Secp256k1SignatureVerifier } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/Secp256k1SignatureVerifier.js';
import { NodeTransferTransactionVerifierWorker } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/worker/NodeTransferTransactionVerifierWorker.js';

class Worker extends NodeTransferTransactionVerifierWorker {
  #predicates = PredicateVerifierService.create();
  // Mirrors what the engine builds (token-engine/factory.ts).
  #certificates = new UnicityCertificateVerifier(
    new UnicitySealQuorumSignaturesVerificationRule(
      new Secp256k1SignatureVerifier(),
      new VerifiedSealCache(256), // omit to verify every seal afresh
    ),
  );

  get predicateVerifier() {
    return this.#predicates;
  }

  get unicityCertificateVerifier() {
    return this.#certificates;
  }
}

new Worker().bootstrap();
```

```ts
import { Worker } from 'node:worker_threads';
import { NodeWorker } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/worker/NodeWorker.js';

const { sphere } = await Sphere.init({
  ...providers,
  verification: {
    createWorker: () =>
      new NodeWorker(new Worker(new URL('./verification-worker.mjs', import.meta.url))),
    poolSize: 4, // optional, default 4
  },
});
```

### Browser

```ts
// verification-worker.ts — bundled as a worker entry by your build.
import { PredicateVerifierService } from '@unicitylabs/state-transition-sdk/lib/predicate/verification/PredicateVerifierService.js';
import { UnicityCertificateVerifier } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/UnicityCertificateVerifier.js';
import { UnicitySealQuorumSignaturesVerificationRule } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/rule/UnicitySealQuorumSignaturesVerificationRule.js';
import { VerifiedSealCache } from '@unicitylabs/state-transition-sdk/lib/api/bft/verification/VerifiedSealCache.js';
import { Secp256k1SignatureVerifier } from '@unicitylabs/state-transition-sdk/lib/crypto/secp256k1/Secp256k1SignatureVerifier.js';
import { BrowserTransferTransactionVerifierWorker } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/worker/BrowserTransferTransactionVerifierWorker.js';

class Worker extends BrowserTransferTransactionVerifierWorker {
  private readonly predicates = PredicateVerifierService.create();
  // Mirrors what the engine builds (token-engine/factory.ts).
  private readonly certificates = new UnicityCertificateVerifier(
    new UnicitySealQuorumSignaturesVerificationRule(
      new Secp256k1SignatureVerifier(),
      new VerifiedSealCache(256), // omit to verify every seal afresh
    ),
  );

  protected get predicateVerifier(): PredicateVerifierService {
    return this.predicates;
  }

  protected get unicityCertificateVerifier(): UnicityCertificateVerifier {
    return this.certificates;
  }
}

new Worker().bootstrap();
```

```ts
const { sphere } = await Sphere.init({
  ...providers,
  verification: {
    // Vite/webpack emit the worker from this URL form; a browser Worker already
    // matches the shape Sphere expects.
    createWorker: () => new Worker(new URL('./verification-worker.ts', import.meta.url), { type: 'module' }),
  },
});
```

## Lifecycle

Workers spawn **lazily** — the first verification creates one, up to `poolSize`, and they
are reused after that. Building an engine costs nothing, which matters because Sphere
rebuilds it on every address switch and API-key change.

`sphere.destroy()` terminates the pool. So does an address switch or `setOracleApiKey()`,
for the engine being replaced. If you drive `createSphereTokenEngine` yourself, call
`engine.dispose()` when you are done with it — otherwise the threads outlive the wallet.

## What is guaranteed

- **Same verdict — given the same rules on both sides.** Both verifiers produce the same
  aggregated result; only the placement of the work differs. The worker path is upstream's
  implementation, tested there. The guarantee is conditional on the two verifiers matching and
  on both sides resolving the same base-SDK major — see [Same major on both
  sides](#same-major-on-both-sides).
- **No effect when unset.** Omit `verification` and the engine runs the sequential verifier
  it always did. No worker module enters your bundle — Sphere imports only the base SDK
  paths it already used.
