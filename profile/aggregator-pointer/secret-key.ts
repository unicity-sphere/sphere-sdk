/**
 * SecretKey wrapper (T-A7) — hides derived secret bytes from
 * serialization paths per SPEC §11.11(d).
 *
 * Every intermediate secret (pointerSecret, signingSeed, xorSeed,
 * padSeed) is wrapped before being handed to any code path that
 * might serialize. toString / toJSON / util.inspect.custom all
 * redact. Raw bytes are retrievable only via explicit .reveal() —
 * call sites that use .reveal() are audit points.
 *
 * This does NOT prevent JS engines from retaining copies; complete
 * zeroization is impossible in GC'd runtimes. See §11.11(a′)
 * MAX_CT_RESIDENT_MS for the retry-window residual-risk model.
 */

const REDACTED = '[REDACTED SecretKey]';

export class SecretKey {
  private readonly _bytes: Uint8Array;
  private readonly _label: string;

  constructor(bytes: Uint8Array, label: string) {
    if (bytes.length === 0) {
      throw new Error('SecretKey cannot wrap empty bytes');
    }
    this._bytes = new Uint8Array(bytes);
    this._label = label;
  }

  /** Return a COPY of the bytes. Audit every call site. */
  reveal(): Uint8Array {
    return new Uint8Array(this._bytes);
  }

  get length(): number {
    return this._bytes.length;
  }

  get label(): string {
    return this._label;
  }

  toString(): string {
    return `${REDACTED} <${this._label}>`;
  }

  toJSON(): string {
    return `${REDACTED} <${this._label}>`;
  }

  // Node.js util.inspect customization — same redaction.
  // Symbol lookup via globalThis avoids hard import of 'util' in browser.
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `${REDACTED} <${this._label}>`;
  }

  /**
   * Best-effort zeroization: overwrites the underlying buffer with zeros.
   * Valid only for the wrapped SecretKey's own buffer — prior copies
   * handed out via reveal() are untouched. Callers that use reveal()
   * are responsible for zeroizing their copy after use.
   */
  zeroize(): void {
    this._bytes.fill(0);
  }
}
