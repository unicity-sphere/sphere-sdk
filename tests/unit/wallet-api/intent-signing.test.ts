/**
 * E.4/#87 seed-holder message vectors (sphere-sdk#501). These EXACT literals are the cross-repo
 * contract — the wallet-api backend recovers + verifies signatures over the same strings
 * (`tests/integration/intents.test.ts` M2.11/M2.12 pins the identical vectors). Any drift here or
 * there wedges checkpointing, loudly and pre-mint. Keep both sides in lock-step.
 */
import { describe, expect, it } from 'vitest';

import { completeSignMessage, progressSignMessage } from '../../../wallet-api/intent-signing';

const TID = '00000000-0000-4000-8000-000000000000';

describe('intent-signing message vectors (E.4/#87 cross-repo contract)', () => {
  it('pins the progress-append message (sha256-hex of the exact envelope bytes)', () => {
    // sha256('enc1.AAAA') = 67ca…ff805 — byte-identical to the wallet-api M2.11 vector.
    expect(progressSignMessage(TID, 3, 'enc1.AAAA')).toBe(
      `wallet-api.progress.v1:${TID}:3:67ca567f7d63debafac96df43259ec03a8e84dbf8b116e7ba9a6493dc40ff805`
    );
  });

  it('pins the terminal-close message', () => {
    expect(completeSignMessage(TID)).toBe(`wallet-api.complete.v1:${TID}`);
  });
});
