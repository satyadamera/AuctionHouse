import { useSyncExternalStore } from 'react';

/**
 * Server-corrected "now". The client clock can be minutes off; every auction response carries the
 * server's time, and we keep the offset so countdowns match the server's notion of the end time.
 * (The server still decides — this is purely for display.)
 */
let offsetMs = 0;
export function recordServerTime(serverTimeIso: string | undefined, requestStartedAt: number, receivedAt: number) {
  if (!serverTimeIso) return;
  const midpoint = (requestStartedAt + receivedAt) / 2; // halve the round-trip
  offsetMs = new Date(serverTimeIso).getTime() - midpoint;
}
export const serverNow = () => Date.now() + offsetMs;

// A single shared 1-second ticker for every countdown on the page.
const listeners = new Set<() => void>();
let timer: number | undefined;
let current = serverNow();

function subscribe(l: () => void) {
  listeners.add(l);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      current = serverNow();
      listeners.forEach((fn) => fn());
    }, 1000);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
