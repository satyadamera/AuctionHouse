/**
 * One shared Socket.IO connection for the whole app.
 *
 * - `auth` is a function, so every (re)connection sends the CURRENT access token.
 * - When the user logs in or out, the socket reconnects so it joins/leaves the private user room.
 * - socket.io-client reconnects automatically with backoff; components listen for 'connect' to
 *   re-join rooms and re-fetch authoritative state (events may have been missed while offline).
 */
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@/types/events';
import { getAccessToken, onAccessTokenChange, refreshSession } from './api';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | null = null;
let lastToken: string | null = null;

export function getSocket(): AppSocket {
  if (socket) return socket;
  socket = io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: (cb) => cb(getAccessToken() ? { token: getAccessToken() } : {}),
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  lastToken = getAccessToken();

  socket.on('connect_error', async (err) => {
    // Expired access token: refresh it, then let the built-in reconnection try again.
    // A middleware rejection is not retried automatically, so reconnect manually afterwards —
    // with the refreshed token, or anonymously if the session is gone.
    if (err.message === 'UNAUTHENTICATED') {
      await refreshSession();
      socket?.connect();
    }
  });

  onAccessTokenChange((t) => {
    const loggedInChanged = Boolean(t) !== Boolean(lastToken);
    lastToken = t;
    // Only a login/logout changes room membership; a silent token refresh does not need a reconnect.
    if (loggedInChanged && socket) {
      socket.disconnect();
      socket.connect();
    }
  });
  return socket;
}
