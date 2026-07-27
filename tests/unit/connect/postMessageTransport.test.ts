/**
 * There was no test file for this transport at all, which is how a one-line origin pin shipped
 * with a regression that would have killed popup mode silently.
 *
 * Two guards live here, and they answer different questions:
 *   - the WINDOW check answers "is this the peer I am talking to", which an origin cannot: an
 *     injected same-origin iframe passes any origin allow-list;
 *   - the ORIGIN check answers "is this peer who it claims to be", and its input is a
 *     caller-supplied URL, not the browser-normalised origin it gets compared against.
 *
 * The SDK's test environment is `node`, so rather than pull in a DOM for one file the global
 * `window` is stubbed with just the two methods the transport uses. The guards are pure logic
 * over three event fields, so nothing is lost by driving them directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostMessageTransport } from '../../../impl/browser/connect/PostMessageTransport';
import { SPHERE_CONNECT_NAMESPACE, SPHERE_CONNECT_VERSION } from '../../../connect/protocol';
import type { SphereConnectMessage } from '../../../connect/protocol';

type Listener = (event: { data: unknown; origin: string; source: unknown }) => void;

let listeners: Listener[] = [];

function frame(): SphereConnectMessage {
  return {
    ns: SPHERE_CONNECT_NAMESPACE,
    v: SPHERE_CONNECT_VERSION,
    type: 'event',
    event: 'wallet:locked',
    data: {},
  } as unknown as SphereConnectMessage;
}

/** A stand-in for a browser window. Only its identity matters to the transport. */
function fakeWindow(): Window {
  return { postMessage: vi.fn(), closed: false } as unknown as Window;
}

/** Deliver a message event as the browser would, with a controllable source and origin. */
function deliver(source: unknown, origin: string): void {
  for (const l of [...listeners]) l({ data: frame(), origin, source });
}

let transports: PostMessageTransport[] = [];
function track(t: PostMessageTransport): PostMessageTransport {
  transports.push(t);
  return t;
}

beforeEach(() => {
  listeners = [];
  transports = [];
  vi.stubGlobal('window', {
    addEventListener: (_type: string, fn: Listener) => listeners.push(fn),
    removeEventListener: (_type: string, fn: Listener) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  });
});

afterEach(() => {
  for (const t of transports) t.destroy();
  vi.unstubAllGlobals();
});

describe('PostMessageTransport — who is allowed to speak to us', () => {
  it('accepts a frame from the target window', () => {
    const target = fakeWindow();
    const t = track(PostMessageTransport.forClient({ target, targetOrigin: 'https://wallet.example' }));
    const seen: SphereConnectMessage[] = [];
    t.onMessage((m) => seen.push(m));

    deliver(target, 'https://wallet.example');

    expect(seen).toHaveLength(1);
  });

  it('drops a frame from a DIFFERENT window on the SAME origin', () => {
    const target = fakeWindow();
    const t = track(PostMessageTransport.forClient({ target, targetOrigin: 'https://wallet.example' }));
    const seen: SphereConnectMessage[] = [];
    t.onMessage((m) => seen.push(m));

    // An injected iframe on the wallet's own origin passes any origin allow-list — which is
    // exactly why the origin cannot be the only guard. These frames decide the client's
    // authoritative identity, the one a dApp is told to compare before resuming a spend.
    deliver(fakeWindow(), 'https://wallet.example');

    expect(seen).toHaveLength(0);
  });

  it('drops a frame from another origin', () => {
    const target = fakeWindow();
    const t = track(PostMessageTransport.forClient({ target, targetOrigin: 'https://wallet.example' }));
    const seen: SphereConnectMessage[] = [];
    t.onMessage((m) => seen.push(m));

    deliver(target, 'https://evil.example');

    expect(seen).toHaveLength(0);
  });

  it('still guards the window when no origin can be pinned (iframe mode defaults to *)', () => {
    const target = fakeWindow();
    const t = track(PostMessageTransport.forClient({ target }));
    const seen: SphereConnectMessage[] = [];
    t.onMessage((m) => seen.push(m));

    deliver(fakeWindow(), 'https://evil.example');
    expect(seen).toHaveLength(0);

    deliver(target, 'https://anything.example');
    expect(seen).toHaveLength(1);
  });

  it('accepts an event with no source, which some environments deliver', () => {
    const target = fakeWindow();
    const t = track(PostMessageTransport.forClient({ target, targetOrigin: 'https://wallet.example' }));
    const seen: SphereConnectMessage[] = [];
    t.onMessage((m) => seen.push(m));

    // Dropping these would break consumers whose environment omits `source`; the origin filter
    // still applies, so this is not a hole so much as a documented limit of the window check.
    deliver(null, 'https://wallet.example');

    expect(seen).toHaveLength(1);
  });
});

describe('PostMessageTransport — targetOrigin is a URL, not an origin', () => {
  // Callers pass whole wallet URLs. `new URL(...).origin` is what the browser reports back in
  // `event.origin`; comparing the raw string dropped every frame and killed popup mode.
  for (const given of [
    'https://wallet.example',
    'https://wallet.example/',
    'https://wallet.example/connect',
    'https://wallet.example:443/connect?origin=x',
  ]) {
    it(`accepts the wallet when constructed with ${given}`, () => {
      const target = fakeWindow();
      const t = track(PostMessageTransport.forClient({ target, targetOrigin: given }));
      const seen: SphereConnectMessage[] = [];
      t.onMessage((m) => seen.push(m));

      deliver(target, 'https://wallet.example');

      expect(seen).toHaveLength(1);
    });
  }

  it('does not brick itself on an unparseable targetOrigin', () => {
    const target = fakeWindow();
    const t = track(PostMessageTransport.forClient({ target, targetOrigin: 'not a url' }));
    const seen: SphereConnectMessage[] = [];
    t.onMessage((m) => seen.push(m));

    // No origin filter is applied — the window check is the real guard, and refusing to parse
    // must not silence a working transport.
    deliver(target, 'https://wallet.example');

    expect(seen).toHaveLength(1);
  });
});
