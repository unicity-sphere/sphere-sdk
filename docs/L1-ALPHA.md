# Sending the ALPHA coin

ALPHA is the coin of Unicity's base blockchain. It is separate from the tokens on the main network and is reached through `sphere.payments.l1`. The connection to the blockchain server (Fulcrum) is **lazy** — it isn't opened until the first ALPHA operation.

```typescript
// ALPHA is enabled by default; no extra setup needed.
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  // Optional defaults applied automatically:
  //   electrumUrl:    network-specific
  //   defaultFeeRate: 10 sat/byte
  //   enableVesting:  true
});

// To disable ALPHA entirely:
// const { sphere } = await Sphere.init({ ...providers, l1: null });
```

## Balance

```typescript
const balance = await sphere.payments.l1!.getBalance();
console.log('Total:',    balance.total);
console.log('Vested:',   balance.vested);
console.log('Unvested:', balance.unvested);
```

All amounts are strings, in satoshis. "Vested" vs "unvested" reflects how the coins were originally created (see [ARCHITECTURE.md](../ARCHITECTURE.md#2b-the-alpha-blockchain-l1)).

## Send

```typescript
const result = await sphere.payments.l1!.send({
  to: 'alpha1qxyz...',
  amount: '100000',   // in satoshis
  feeRate: 5,         // optional, sat/byte
});

if (result.success) {
  console.log('TX Hash:', result.txHash);
}
```

## UTXOs, history, fee estimate

```typescript
const utxos   = await sphere.payments.l1!.getUtxos();
const history = await sphere.payments.l1!.getHistory(10);
const { fee, feeRate } = await sphere.payments.l1!.estimateFee('alpha1...', '50000');
```
