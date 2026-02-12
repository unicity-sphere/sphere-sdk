import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IpnsSubscriptionClient } from '../../../../../impl/shared/ipfs/ipns-subscription-client';
import { WebSocketReadyState } from '../../../../../transport/websocket';
import type { IWebSocket, WebSocketFactory } from '../../../../../transport/websocket';

// =============================================================================
// Mock WebSocket
// =============================================================================

function createMockWebSocket(): IWebSocket & {
  simulateOpen: () => void;
  simulateMessage: (data: string) => void;
  simulateClose: () => void;
  simulateError: () => void;
} {
  const ws: IWebSocket & {
    readyState: number;
    simulateOpen: () => void;
    simulateMessage: (data: string) => void;
    simulateClose: () => void;
    simulateError: () => void;
  } = {
    readyState: WebSocketReadyState.CONNECTING,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    simulateOpen() {
      this.readyState = WebSocketReadyState.OPEN;
      this.onopen?.({});
    },
    simulateMessage(data: string) {
      this.onmessage?.({ data });
    },
    simulateClose() {
      this.readyState = WebSocketReadyState.CLOSED;
      this.onclose?.({});
    },
    simulateError() {
      this.onerror?.({});
    },
  };
  return ws;
}

// =============================================================================
// Tests
// =============================================================================

describe('IpnsSubscriptionClient', () => {
  let mockWs: ReturnType<typeof createMockWebSocket>;
  let wsFactory: WebSocketFactory;
  let client: IpnsSubscriptionClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = createMockWebSocket();
    wsFactory = vi.fn().mockReturnValue(mockWs);
    client = new IpnsSubscriptionClient({
      wsUrl: 'wss://example.com/ws/ipns',
      createWebSocket: wsFactory,
      debug: false,
    });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
  });

  describe('subscribe()', () => {
    it('should connect WebSocket when first subscription is added', () => {
      client.subscribe('12D3KooWTestName', vi.fn());
      expect(wsFactory).toHaveBeenCalledWith('wss://example.com/ws/ipns');
    });

    it('should send subscribe message once connected', () => {
      client.subscribe('12D3KooWTestName', vi.fn());
      mockWs.simulateOpen();

      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ action: 'subscribe', names: ['12D3KooWTestName'] }),
      );
    });

    it('should send subscribe for new name on already-open connection', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      vi.mocked(mockWs.send).mockClear();

      client.subscribe('name2', vi.fn());
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ action: 'subscribe', names: ['name2'] }),
      );
    });

    it('should not send duplicate subscribe for same name', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      vi.mocked(mockWs.send).mockClear();

      client.subscribe('name1', vi.fn());
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const unsub = client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      vi.mocked(mockWs.send).mockClear();

      unsub();
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({ action: 'unsubscribe', names: ['name1'] }),
      );
    });

    it('should reject invalid IPNS names', () => {
      const callback = vi.fn();
      const unsub = client.subscribe('', callback);
      expect(wsFactory).not.toHaveBeenCalled();
      unsub(); // should not throw
    });
  });

  describe('message handling', () => {
    it('should notify subscribers on update message', () => {
      const callback = vi.fn();
      client.subscribe('12D3KooWTestName', callback);
      mockWs.simulateOpen();

      mockWs.simulateMessage(JSON.stringify({
        type: 'update',
        name: '12D3KooWTestName',
        sequence: 5,
        cid: 'bafyabc123',
        timestamp: '2026-02-11T00:00:00Z',
      }));

      expect(callback).toHaveBeenCalledWith({
        type: 'update',
        name: '12D3KooWTestName',
        sequence: 5,
        cid: 'bafyabc123',
        timestamp: '2026-02-11T00:00:00Z',
      });
    });

    it('should not notify subscribers for different name', () => {
      const callback = vi.fn();
      client.subscribe('name1', callback);
      mockWs.simulateOpen();

      mockWs.simulateMessage(JSON.stringify({
        type: 'update',
        name: 'name2',
        sequence: 1,
        cid: 'bafyxyz',
        timestamp: '2026-02-11T00:00:00Z',
      }));

      expect(callback).not.toHaveBeenCalled();
    });

    it('should notify global onUpdate callbacks', () => {
      const globalCallback = vi.fn();
      client.onUpdate(globalCallback);

      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();

      mockWs.simulateMessage(JSON.stringify({
        type: 'update',
        name: 'name1',
        sequence: 3,
        cid: 'bafyxyz',
        timestamp: '2026-02-11T00:00:00Z',
      }));

      expect(globalCallback).toHaveBeenCalledTimes(1);
    });

    it('should handle malformed JSON gracefully', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();

      // Should not throw
      mockWs.simulateMessage('not json');
    });

    it('should handle null cid by defaulting to empty string', () => {
      const callback = vi.fn();
      client.subscribe('name1', callback);
      mockWs.simulateOpen();

      mockWs.simulateMessage(JSON.stringify({
        type: 'update',
        name: 'name1',
        sequence: 1,
        cid: null,
        timestamp: '2026-02-11T00:00:00Z',
      }));

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ cid: '' }));
    });
  });

  describe('reconnection', () => {
    it('should schedule reconnect on close', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      mockWs.simulateClose();

      // Advance past initial reconnect delay (5s)
      const newMockWs = createMockWebSocket();
      vi.mocked(wsFactory).mockReturnValue(newMockWs);

      vi.advanceTimersByTime(5000);
      expect(wsFactory).toHaveBeenCalledTimes(2);
    });

    it('should use exponential backoff', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      mockWs.simulateClose();

      // First reconnect at 5s
      const ws2 = createMockWebSocket();
      vi.mocked(wsFactory).mockReturnValue(ws2);
      vi.advanceTimersByTime(5000);
      expect(wsFactory).toHaveBeenCalledTimes(2);

      ws2.simulateClose();

      // Second reconnect at 10s (5 * 2^1)
      const ws3 = createMockWebSocket();
      vi.mocked(wsFactory).mockReturnValue(ws3);
      vi.advanceTimersByTime(10000);
      expect(wsFactory).toHaveBeenCalledTimes(3);
    });

    it('should not reconnect when no subscriptions remain', () => {
      const unsub = client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      unsub(); // removes subscription and disconnects

      // Should not try to reconnect
      vi.advanceTimersByTime(60000);
      expect(wsFactory).toHaveBeenCalledTimes(1);
    });

    it('should resubscribe after reconnect', () => {
      client.subscribe('name1', vi.fn());
      client.subscribe('name2', vi.fn());
      mockWs.simulateOpen();
      mockWs.simulateClose();

      const ws2 = createMockWebSocket();
      vi.mocked(wsFactory).mockReturnValue(ws2);
      vi.advanceTimersByTime(5000);
      ws2.simulateOpen();

      // Should re-subscribe to both names
      expect(ws2.send).toHaveBeenCalledWith(
        expect.stringContaining('name1'),
      );
    });
  });

  describe('keepalive', () => {
    it('should send ping every 30s', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      vi.mocked(mockWs.send).mockClear();

      vi.advanceTimersByTime(30000);
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ action: 'ping' }));
    });

    it('should stop ping on close', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      mockWs.simulateClose();
      vi.mocked(mockWs.send).mockClear();

      vi.advanceTimersByTime(30000);
      // No more pings sent after close
      const pingCalls = vi.mocked(mockWs.send).mock.calls.filter(
        call => call[0] === JSON.stringify({ action: 'ping' }),
      );
      expect(pingCalls.length).toBe(0);
    });
  });

  describe('fallback polling', () => {
    it('should start polling when WS is not connected', async () => {
      const pollFn = vi.fn().mockResolvedValue(undefined);
      client.setFallbackPoll(pollFn, 90000);

      // Poll should fire immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(1);

      // And again after interval
      await vi.advanceTimersByTimeAsync(90000);
      expect(pollFn).toHaveBeenCalledTimes(2);
    });

    it('should stop polling when WS connects', async () => {
      const pollFn = vi.fn().mockResolvedValue(undefined);

      client.subscribe('name1', vi.fn());
      client.setFallbackPoll(pollFn, 90000);

      // Poll fires while connecting
      await vi.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(1);

      // WS connects — polling should stop
      mockWs.simulateOpen();
      pollFn.mockClear();

      await vi.advanceTimersByTimeAsync(90000);
      expect(pollFn).not.toHaveBeenCalled();
    });

    it('should resume polling when WS disconnects', async () => {
      const pollFn = vi.fn().mockResolvedValue(undefined);

      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();

      client.setFallbackPoll(pollFn, 90000);
      // No polling while connected
      await vi.advanceTimersByTimeAsync(0);
      expect(pollFn).not.toHaveBeenCalled();

      // WS disconnects — polling should start
      mockWs.simulateClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(pollFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnect()', () => {
    it('should close WebSocket and clean up', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();

      client.disconnect();
      expect(mockWs.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });

    it('should not reconnect after disconnect', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      client.disconnect();

      vi.advanceTimersByTime(60000);
      expect(wsFactory).toHaveBeenCalledTimes(1);
    });
  });

  describe('isConnected()', () => {
    it('should return false when not connected', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should return true when WebSocket is open', () => {
      client.subscribe('name1', vi.fn());
      mockWs.simulateOpen();
      expect(client.isConnected()).toBe(true);
    });
  });
});
