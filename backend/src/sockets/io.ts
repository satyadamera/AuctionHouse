import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env.js';
import { getDb } from '../database/db.js';
import { logger } from '../utils/logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { setEventPublisher } from '../workers/outboxDispatcher.js';
import { Rooms, type ClientToServerEvents, type ServerToClientEvents } from '../shared/events.js';
import type { Role } from '../database/types.js';

interface SocketData {
  userId?: number;
  role?: Role;
}

export type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let io: IO | undefined;

export function getIO(): IO | undefined {
  return io;
}

/**
 * Socket.IO server.
 *
 * - Authentication is OPTIONAL: anonymous visitors can watch public auctions live. When the client
 *   sends an access token in `auth.token`, the socket also joins its private `user:{id}` room for
 *   notifications. An invalid token is rejected outright (not silently downgraded) so the client
 *   knows to refresh it.
 * - Sockets are read-only for business state. Bids are NEVER accepted over the socket; they go
 *   through the authenticated REST endpoint, which validates and commits them. The socket only
 *   delivers already-committed facts.
 */
export function createSocketServer(httpServer: HttpServer): IO {
  io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    path: '/socket.io',
    cors: { origin: env.corsOrigins, credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
    // Brief disconnects (Wi-Fi blip) restore rooms and replay missed packets when possible.
    connectionStateRecovery: { maxDisconnectionDuration: 60_000, skipMiddlewares: false },
  });

  io.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token) return next();
    try {
      const claims = verifyAccessToken(token);
      socket.data.userId = Number(claims.sub);
      socket.data.role = claims.role;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: AppSocket) => {
    if (socket.data.userId) void socket.join(Rooms.user(socket.data.userId));

    socket.on('auction:join', async (auctionId, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
      const id = Number(auctionId);
      if (!Number.isInteger(id) || id <= 0) return respond({ ok: false, error: 'INVALID_AUCTION_ID' });
      try {
        // Room authorisation: drafts are private to their seller (and admins).
        const a = await getDb().selectFrom('auctions').select(['status', 'seller_id', 'version']).where('id', '=', id).executeTakeFirst();
        if (!a) return respond({ ok: false, error: 'AUCTION_NOT_FOUND' });
        if (a.status === 'DRAFT' && socket.data.userId !== a.seller_id && socket.data.role !== 'ADMIN') {
          return respond({ ok: false, error: 'FORBIDDEN' });
        }
        const room = Rooms.auction(id);
        // socket.io rooms are sets: joining twice is a no-op, so duplicate subscriptions cannot happen.
        await socket.join(room);
        const viewers = await roomSize(room);
        io!.to(room).emit('auction:viewers', { auctionId: id, viewers });
        respond({ ok: true, viewers, version: a.version });
      } catch (err) {
        logger.error({ err }, 'auction:join failed');
        respond({ ok: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('auction:leave', async (auctionId) => {
      const room = Rooms.auction(Number(auctionId));
      await socket.leave(room);
      io!.to(room).emit('auction:viewers', { auctionId: Number(auctionId), viewers: await roomSize(room) });
    });

    socket.on('feed:join', () => void socket.join(Rooms.feed));
    socket.on('feed:leave', () => void socket.leave(Rooms.feed));

    // 'disconnecting' fires while socket.rooms is still populated, so viewer counts can be updated.
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (!room.startsWith('auction:')) continue;
        const auctionId = Number(room.slice('auction:'.length));
        const remaining = (io!.sockets.adapter.rooms.get(room)?.size ?? 1) - 1;
        socket.to(room).emit('auction:viewers', { auctionId, viewers: Math.max(0, remaining) });
      }
    });
  });

  setEventPublisher({
    toRoom(room, event) {
      // The event name is the envelope's type, so contracts stay in one place (shared/events.ts).
      (io!.to(room).emit as (ev: string, payload: unknown) => boolean)(event.type, event);
    },
  });

  return io;
}

async function roomSize(room: string): Promise<number> {
  return io?.sockets.adapter.rooms.get(room)?.size ?? 0;
}

export async function closeSocketServer() {
  setEventPublisher(undefined);
  if (io) {
    await new Promise<void>((resolve) => io!.close(() => resolve()));
    io = undefined;
  }
}
