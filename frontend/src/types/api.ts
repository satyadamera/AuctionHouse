/** Shapes returned by the Auctra REST API (see backend/src/docs/openapi.ts). */
export type Role = 'USER' | 'SELLER' | 'ADMIN';
export type AuctionStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
}

export interface AuctionSummary {
  id: number;
  title: string;
  status: AuctionStatus;
  category: { id: number; name: string; slug: string };
  seller: { id: number; name: string };
  coverImage: string | null;
  startingPrice: string;
  currentHighestBid: string | null;
  minimumNextBid: string;
  bidCount: number;
  startTime: string;
  endTime: string;
  isFeatured: boolean;
  version: number;
}

export interface AuctionDetail extends AuctionSummary {
  description: string;
  minimumBidIncrement: string;
  originalEndTime: string;
  images: { id: number; url: string; alt: string | null }[];
  seller: { id: number; name: string; avatarUrl: string | null; memberSince: string };
  currentHighestBidder: { id: number; name: string } | null;
  winner: { id: number; name: string } | null;
  finalPrice: string | null;
  cancelReason: string | null;
  moderationStatus: string;
  completedAt: string | null;
  createdAt: string;
}

export interface Bid {
  id: number;
  amount: string;
  bidder: { id: number; name: string };
  createdAt: string;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  liveCount: number;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  auctionId: number | null;
  isRead: boolean;
  createdAt: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  serverTime?: string;
}

export interface MyBid {
  auction: AuctionSummary;
  myHighestBid: string;
  myBidCount: number;
  lastBidAt: string;
  finalPrice: string | null;
  position: 'WINNING' | 'OUTBID' | 'WON' | 'LOST' | 'CANCELLED';
}

export interface Listing extends AuctionSummary {
  finalPrice: string | null;
  hasWinner: boolean;
  moderationStatus: string;
  cancelReason: string | null;
}

export interface PlaceBidResult {
  bid: Bid;
  state: LiveState;
  version: number;
  replayed: boolean;
  extended: boolean;
}

export interface LiveState {
  status: AuctionStatus;
  currentHighestBid: string | null;
  currentHighestBidder: { id: number; name: string } | null;
  minimumNextBid: string;
  bidCount: number;
  endTime: string;
}
