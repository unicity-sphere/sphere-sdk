# Parallel token verification (opt-in)

Every token that arrives is fully verified before it enters the balance: the genesis, then
each transfer in its provenance, against the trust base. That walk is sequential by default
and runs on the calling thread — correct everywhere, and the baseline any other verifier
must match.

Since `@unicitylabs/state-transition-sdk@2.0.2` the independent per-transfer work can be
fanned out to a pool of workers. Sphere exposes that as **opt-in configuration**: pass
`verification` to `Sphere.init()` (or to `EngineConfig` if you build the engine yourself)
and the engine verifies through the pool instead.

**When it is worth it:** long provenance chains — a token that has changed hands many
times — and batch receives, where several such tokens verify at once. A freshly minted
token has nothing to parallelise; leave the option off and nothing changes.

## You own the worker script

The entry script is yours to author and bundle, because only your bundler knows how to emit
a worker. Sphere never spawns one for you.

> **The predicate verifier on both sides must match.** The worker builds its own, and the
> engine builds its own. If they differ, the transfers verified in the worker and the
> genesis verified on the main thread are judged under different rules, and the token
> verdict silently diverges from the sequential one. `PredicateVerifierService.create()` on
> both sides is the safe default.

### Node

```ts
// verification-worker.mjs — its own module; spawned as a worker thread.
import { PredicateVerifierService } from '@unicitylabs/state-transition-sdk/lib/predicate/verification/PredicateVerifierService.js';
import { NodeTransferTransactionVerifierWorker } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/worker/NodeTransferTransactionVerifierWorker.js';

class Worker extends NodeTransferTransactionVerifierWorker {
  #verifier = PredicateVerifierService.create();
  get predicateVerifier() {
    return this.#verifier;
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
import { BrowserTransferTransactionVerifierWorker } from '@unicitylabs/state-transition-sdk/lib/transaction/verification/worker/BrowserTransferTransactionVerifierWorker.js';

class Worker extends BrowserTransferTransactionVerifierWorker {
  private readonly verifier = PredicateVerifierService.create();
  protected get predicateVerifier(): PredicateVerifierService {
    return this.verifier;
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

- **Same verdict.** Both verifiers produce the same aggregated result; only the placement of
  the work differs. The worker path is upstream's implementation, tested there.
- **No effect when unset.** Omit `verification` and the engine runs the sequential verifier
  it always did. No worker module enters your bundle — Sphere imports only the base SDK
  paths it already used.
