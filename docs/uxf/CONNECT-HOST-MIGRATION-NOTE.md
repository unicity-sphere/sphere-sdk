# ConnectHost — UXF-1 Intent `schemaVersion` Migration Note

> Task: **T.7.C.5** — ConnectHost coordination + external repo type-widening (C5).
> Status: shipped on `feature/uxf-packaging-format`.
> Audience: integrators of `ConnectHost` (sphere app, agentsphere, third-party
> wallet hosts).

## TL;DR

`ConnectHost` now passes a fourth argument to the `onIntent` callback (and
to `setIntentAutoApprove` handlers): a string literal **`schemaVersion`**
that tells the wallet UI whether the incoming intent payload uses the new
**UXF-1** packaging format or the **pre-UXF (legacy)** shape.

```ts
type IntentSchemaVersion = 'uxf-1' | 'legacy';

onIntent(
  action: string,
  params: Record<string, unknown>,
  session: ConnectSession,
  schemaVersion?: IntentSchemaVersion,   // <-- NEW (4th arg)
): Promise<{ result?: unknown; error?: { code: number; message: string } }>;
```

The argument is **optional at the type level**, which means existing
three-parameter callbacks compile and run unchanged. The default value
emitted by the host when nothing UXF-1-specific is detected is
**`'legacy'`** — full backward compatibility.

## Why

UXF-1 widens intents to multi-asset payloads (`additionalAssets[]`,
mixed coin + NFT bundles, top-level `bundle` envelopes). Wallet UIs
that render the confirmation modal have to know *which schema* they are
looking at so they can:

- pick the right confirmation layout (single-asset vs. multi-asset
  summary panel),
- run schema-appropriate validation before signing,
- tag the resulting on-chain artefacts with the format used.

Previously, integrators had to sniff `params` themselves and risked
drifting from the SDK’s canonical detection rules. The host now does
this once, centrally, and forwards the result.

## Detection rules (canonical)

The host returns `'uxf-1'` if **any** of the following hold for `params`:

1. `params.schemaVersion === 'uxf-1'` (explicit declaration by the dApp).
2. `params.additionalAssets` is a non-empty array
   (multi-asset extension — coin or NFT entries).
3. `params.bundle`, `params.uxfBundle`, or `params.uxf` is present and
   non-null (a UXF envelope is being shipped end-to-end).

Otherwise — including when `params` is `undefined`, `null`, or any other
non-object — the host returns `'legacy'`. Detection is **pure**, never
throws, and never mutates the dApp-supplied `params` object.

The detector is also exported as a standalone function for hosts that
want to apply the same rule outside the callback path:

```ts
import { detectIntentSchemaVersion } from '@unicitylabs/sphere-sdk/connect';
```

## How to migrate

### 1. Widen the callback type

If your existing code declares `onIntent` as a strictly three-parameter
function, widen the signature:

```ts
// before
const onIntent = async (
  action: string,
  params: Record<string, unknown>,
  session: ConnectSession,
) => { /* … */ };

// after
import type { IntentSchemaVersion } from '@unicitylabs/sphere-sdk/connect';

const onIntent = async (
  action: string,
  params: Record<string, unknown>,
  session: ConnectSession,
  schemaVersion: IntentSchemaVersion = 'legacy',
) => { /* … */ };
```

The default `= 'legacy'` keeps your code tolerant to older SDK versions
that do not yet emit the argument.

### 2. Branch on the schema version

```ts
if (schemaVersion === 'uxf-1') {
  return openUxfConfirmModal(action, params, session);
}
return openLegacyConfirmModal(action, params, session);
```

If you do not need to branch yet, you can simply ignore the new argument
— the legacy code path remains correct because every legacy payload is
still tagged `'legacy'`.

### 3. Apply the same change to auto-approve handlers

`ConnectHost.setIntentAutoApprove(action, handler)` forwards the same
`schemaVersion` argument to the registered handler. Widen its signature
the same way if you want to gate auto-approval on schema version:

```ts
host.setIntentAutoApprove('send', async (action, params, session, schemaVersion) => {
  if (schemaVersion === 'uxf-1') {
    // …new auto-approve policy for multi-asset bundles
  }
  // …existing legacy policy
});
```

## Compatibility matrix

| Caller declares `onIntent` with… | Result on this SDK version |
| --- | --- |
| 3 parameters (legacy)            | Works. The 4th argument is silently dropped by JS call semantics. |
| 4 parameters, optional 4th       | Works. Receives `'legacy'` for old payloads, `'uxf-1'` for new. |
| 4 parameters, **required** 4th   | Works at runtime; the SDK always emits the argument. (TypeScript may complain at the call site if the consumer downcasts.) |

The wire protocol is **unchanged** — `schemaVersion` is purely a
host→wallet-UI hint derived from the existing `SphereIntentRequest`
payload. dApps do not need to send anything new (though setting
`params.schemaVersion = 'uxf-1'` is now the canonical way to opt in
explicitly).

## Affected external repos

- **sphere app** — wallet UI host. Update the `onIntent` callback in
  the Connect bridge (`apps/web/src/connect/host.ts` or equivalent) to
  read the 4th argument and route to the UXF-1 confirmation flow.
- **agentsphere** — agent host. Update the agent’s `onIntent` policy
  hook in the Connect bridge to gate auto-approval on
  `schemaVersion === 'uxf-1'` if it must restrict to one shape.
- Any third-party Connect host: same pattern — widen the callback type
  and branch on the new argument.

## See also

- `connect/host/ConnectHost.ts` — `detectIntentSchemaVersion` + emission
  site in `handleIntentRequest`.
- `connect/types.ts` — `IntentSchemaVersion`, `ConnectHostConfig.onIntent`.
- `tests/unit/connect/connect-host-uxf-intent-schema.test.ts` —
  contract test for the new field.
