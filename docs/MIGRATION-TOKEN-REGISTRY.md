# Migration: the token registry becomes per-Sphere

Tracking issue: [#766](https://github.com/unicity-sphere/sphere-sdk/issues/766)

## Why

`TokenRegistry` is a process-global singleton, and `TokenRegistry.configure()` reaches into
whatever instance exists and repoints it. Every `Sphere.init()` calls it. So a second Sphere
silently rewrites the first one's metadata.

Reproduced, with two Spheres on **separate storage providers**:

```
instance #1 (testnet2), reading its own asset
  BEFORE the mainnet init:  { symbol: 'TCOIN', name: 'TestnetCoin', decimals: 8 }
  AFTER  the mainnet init:  { symbol: 'AAAAAA', name: 'aaaa…aa',    decimals: 0 }
```

`AAAAAA` is `coinId.slice(0, 6).toUpperCase()` and `0` is `decimals ?? 0` — the registry-miss
fallbacks. Nothing on instance #1 restores it: not `switchToAddress`, not `setOracleApiKey`.

Inside the SDK this is presentation only — the money path treats `coinId` as opaque bytes,
`mint()` rejects non-hex, and coin selection byte-compares. **At the consumer boundary it is
not.** Code that reads `decimals` from the registry and feeds it to `parseTokenAmount()`, or
reads a `coinId` from the registry and passes it to `send()`/`mint()`, gets a 10ⁿ scale error
or the wrong coin. Check your own call sites for that shape.

Separately, `Sphere.destroy()` never touched the registry, so every discarded Sphere left an
hourly fetch running. Nothing in `registry/` calls `unref()`, so under Node that also keeps the
event loop alive.

## What changed in this release

- **A `Sphere` now builds and owns its own registry**, and the payments facade presents from
  that one instead of the global. Two Spheres on different networks no longer disturb each
  other's metadata.
- **`Sphere.destroy()` disposes that registry** — timer stopped, no late apply, no late cache
  write. The process-global is deliberately left running, because other code still reads it.
- **`TokenRegistry.create(options)`** builds an independent registry; **`dispose()`**,
  **`isDisposed`** and an instance-level **`waitForReady()`** are new.
- **`createBrowserProviders` / `createNodeProviders` no longer call `TokenRegistry.configure()`.**
- The ten singleton-bound free functions moved to `registry/global-readers.ts`. They are
  re-exported unchanged; no import path changes.

The public surface is otherwise identical — same 126 root exports, same names, same signatures.

## Do you need to change anything?

**Almost certainly not.** One case to check:

> Do you call `createBrowserProviders()` or `createNodeProviders()` and then read the registry,
> **without** calling `Sphere.init()`?

If yes, configure it yourself:

```ts
import { TokenRegistry, NETWORKS } from '@unicitylabs/sphere-sdk';

TokenRegistry.configure({
  remoteUrl: NETWORKS[network].tokenRegistryUrl,
  storage: providers.storage,
});
```

If you call `Sphere.init()` — which configures the global exactly as before — nothing changes.

Note this only ever worked when you imported `TokenRegistry` and the provider factory from the
**same** entry point. In the published package they are separate bundles with separate copies
(`tsup` inlines `registry/` into each entry and sets `splitting: false`), so the factories'
`configure()` call was writing to an object no consumer could read. Removing it is a no-op for
anyone consuming the published package.

## Preparing for what comes next

The global is going away. When it does, `TokenRegistry.getInstance()`, `configure()`,
`resetInstance()`, `destroy()`, the static `waitForReady()` and the ten free functions go with
it, and reads move to the registry your Sphere owns.

You can get ahead of it now:

- **Prefer per-Sphere reads over global reads** for anything network-sensitive — above all
  anywhere a `coinId` or `decimals` from the registry reaches `send()`, `mint()` or an amount
  conversion. Those are the sites where a retargeted registry is a money bug rather than a
  cosmetic one.
- **Don't rely on `getInstance()` in module-scope initialisers.** A module-scope capture binds
  to whichever network configured the global first, which is the bug in miniature.
- **Test teardown that calls `TokenRegistry.resetInstance()`** to stop the background timer can
  eventually drop it: a Sphere-owned registry is disposed by `sphere.destroy()`.

Nothing above is required in this release. It is what will make the removal a small change
rather than a large one.

## Also removed: the Sphere lifecycle globals

`Sphere.getInstance()`, `Sphere.isInitialized()` and the `getSphere` export are **removed**
([#766](https://github.com/unicity-sphere/sphere-sdk/issues/766)). Hold the instance the entry
point returns, and use `sphere.isReady`. Nothing in the fleet used them — the consumer gate
found zero call sites across every sibling repo.

They could not be safely deprecated: after a second Sphere is created *and destroyed*,
`getInstance()` returned `null` while the first was alive and serving money, and a deprecation
note does not stop a wrong answer being consumed.

`Sphere.clear()` and `Sphere.import()` now destroy only Spheres built on the storage they are
given, compared by object identity. Previously they destroyed whichever Sphere was constructed
last — so `Sphere.import({ storage: B })` killed a live wallet on storage A, dropping every
`sphere.on()` handler with no event and no error. The `exists(storage)` behaviour that callers
actually depend on is unchanged.

## Not fixed by this release

Two `FileStorageProvider` objects pointed at one `dataDir` still clobber each other's wallet
file — that provider caches the whole store in memory and rewrites the entire file on every
`set()`, so it affects every key, money journals included, not just one. Tracked as
[#771](https://github.com/unicity-sphere/sphere-sdk/issues/771).
