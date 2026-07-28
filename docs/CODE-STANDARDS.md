# Code standards

Enforced by `npm run check:budget` (CI). Not aspirational — measured on the TypeScript AST.

## Budgets

| Metric | Target | Rationale |
|---|---|---|
| File lines | **400** | Above this nobody reads the whole file, so nobody knows what is already there. Duplication follows. |
| Function body lines | **50** | A function you cannot see at once is a function you cannot reason about. |
| Comment ratio | **15%** | See below. |
| Inline comment block | **5 lines** | Longer means the code needs a name, not a paragraph. |

`npm run check:budget` uses a **ratchet**: files already over budget are recorded in
`scripts/code-budget-baseline.json` and tolerated at their recorded size. They may never grow,
and no new violation may appear. Improving a file and running `--update` tightens the baseline
permanently.

**Raising a limit is not an option.** No mechanism pushing back is precisely how one file reached
7,027 lines (see [`PAYMENTS-ANALYSIS.md`](./PAYMENTS-ANALYSIS.md)).

## Comments

Measured at the time this was written: `PaymentsModule.ts` **36%** comments, `AccountingModule.ts`
32%, `Sphere.ts` 33%. The newest file in the payments module, `SendOperations.ts`, was **53%** —
the habit reproduces itself in fresh code, so splitting files does not fix it.

Prose is not free. It costs reading time, it competes with the code for attention, and unlike code
it is never executed — so it rots silently. Three comments in `PaymentsModule` were actively false
when checked: one claimed `switchToAddress()` waits via `waitForPendingOperations()` (`Sphere.ts`
documents that it deliberately does not, and the method had zero callers), one documented
`instantSplitSend` as a caller (deleted in the v1 cutover), and `CLAUDE.md` advertised the file as
"~139KB" when it was 309KB.

### Where knowledge goes instead

| Knowledge | Home | Why |
|---|---|---|
| An invariant | **A test whose name is the invariant** | Executable. Cannot rot. Fails when violated. |
| Why a change was made | **git history / CHANGELOG** | Already versioned. 35 issue numbers were inlined in one file. |
| What a block does | **A function with that name** | The name is checked by the compiler; a comment is not. |
| A design decision | **`docs/`** | One canonical copy instead of a paraphrase per call site. |

### What stays

Short notes on **non-obvious why** that cannot be encoded — a protocol quirk, a counterintuitive
ordering, a deliberate deviation. Prefer pointing at the test that pins it:

```ts
// Ordering is load-bearing — see delivery-journal.test.ts "journals before delivering".
await this.journal(blob);
await this.deliver(blob);
```

Public API JSDoc is the contract and does not count against the block limit — but it documents
**behavior**, never history.

### What goes

- Restating the code (`// increment counter`).
- Issue numbers and incident narrative inline.
- Banner separators framing one function.
- Commented-out code — git has it.
- Paragraphs explaining a block that should be an extracted, named function.

## Applying this to a refactor

Deleting a comment that encodes a real money-safety invariant **loses knowledge**. The rule is a
swap, not a delete: the invariant becomes a named test in the same commit, and the comment is
replaced by a pointer to it. A refactor commit that only removes prose, with no test gaining its
meaning, is a regression.

## Related

- [`PAYMENTS-REFACTOR.md`](./PAYMENTS-REFACTOR.md) — the staged plan
- [`PAYMENTS-ANALYSIS.md`](./PAYMENTS-ANALYSIS.md) — evidence, including how the growth happened
