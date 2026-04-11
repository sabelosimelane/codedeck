import { describe, expect, it } from 'vitest';
import { buildTerminalWebSocketUrl } from '../../utils/terminalWsUrl';

describe('buildTerminalWebSocketUrl', () => {
  it('bypasses the Vite dev proxy and connects directly to the backend port in local development', () => {
    const url = buildTerminalWebSocketUrl({
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '43000',
        host: 'localhost:43000',
      },
      cwd: '/tmp/project',
      sessionId: 'marketing-1',
      cols: 120,
      rows: 40,
    });

    expect(url).toBe(
      'ws://localhost:43001/ws/terminal?cwd=%2Ftmp%2Fproject&sessionId=marketing-1&cols=120&rows=40'
    );
  });

  it('preserves the current origin host outside local dev-proxy mode', () => {
    const url = buildTerminalWebSocketUrl({
      location: {
        protocol: 'https:',
        hostname: 'codedeck.example.com',
        port: '',
        host: 'codedeck.example.com',
      },
      cwd: '/tmp/project',
      sessionId: 'marketing-1',
      cols: 80,
      rows: 24,
    });

    expect(url).toBe(
      'wss://codedeck.example.com/ws/terminal?cwd=%2Ftmp%2Fproject&sessionId=marketing-1&cols=80&rows=24'
    );
  });
});
