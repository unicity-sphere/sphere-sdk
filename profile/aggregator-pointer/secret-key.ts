/**
 * SecretKey wrapper (T-A7) — hides derived secret bytes from
 * serialization paths per SPEC §11.11(d).
 *
 * Uses ECMAScript private fields (`#bytes`, `#label`) — genuinely
 * invisible to `Object.keys`, `{...spread}`, `structuredClone`,
 * `JSON.stringify`, `util.inspect` (via the custom hook), and
 * `console.log` (which falls through to toString). TypeScript
 * `private` is erased at compile time and does NOT provide this
 * guarantee; private fields do.
 *
 * Raw bytes are retrievable only via explicit `.reveal()` — each
 * call site is an audit point. `.reveal()` returns a COPY; callers
 * are responsible for zeroizing the copy after use.
 *
 * This does NOT prevent JS engines from retaining copies; complete
 * zeroization is impossible in GC'd runtimes. See §11.11(a′)
 * MAX_CT_RESIDENT_MS for the retry-window residual-risk model.
 */

const REDACTED = '[REDACTED SecretKey]';

// Steelman²⁷: capture Uint8Array constructor at module load so SecretKey
// copy operations cannot be hijacked by late `globalThis.Uint8Array =
// HostileSubclass` pollution. SecretKey holds the four derived secrets
// returned by derivePointerKeyMaterial; both the constructor's defensive
// copy and reveal()'s outgoing copy must use the captured reference.
const UINT8_ARRAY_CTOR = Uint8Array;

export class SecretKey {
  #bytes: Uint8Array;
  #label: string;
  #zeroized = false;

  constructor(bytes: Uint8Array, label: string) {
    if (bytes.length === 0) {
      throw new RangeError('SecretKey cannot wrap empty bytes');
    }
    this.#bytes = new UINT8_ARRAY_CTOR(bytes);
    this.#label = label;
  }

  /**
   * Return a COPY of the bytes. Audit every call site.
   * Throws after zeroize() to prevent silent-zero correctness bombs.
   */
  reveal(): Uint8Array {
    if (this.#zeroized) {
      throw new Error('SecretKey already zeroized; reveal() would return zeros');
    }
    return new UINT8_ARRAY_CTOR(this.#bytes);
  }

  get length(): number {
    return this.#bytes.length;
  }

  get label(): string {
    return this.#label;
  }

  toString(): string {
    return `${REDACTED} <${this.#label}>`;
  }

  toJSON(): string {
    return `${REDACTED} <${this.#label}>`;
  }

  // Node.js util.inspect customization — same redaction.
  // The symbol lookup is string-based to avoid a hard 'util' import in browser.
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `${REDACTED} <${this.#label}>`;
  }

  // Browser devtools / template-literal coercion fallback.
  [Symbol.toPrimitive](_hint: string): string {
    return `${REDACTED} <${this.#label}>`;
  }

  /**
   * Best-effort zeroization: overwrites the underlying buffer with zeros
   * and flags the wrapper so subsequent reveal() throws. Prior copies
   * handed out via reveal() are untouched — callers must zeroize their own.
   */
  zeroize(): void {
    this.#bytes.fill(0);
    this.#zeroized = true;
  }

  isZeroized(): boolean {
    return this.#zeroized;
  }
}
