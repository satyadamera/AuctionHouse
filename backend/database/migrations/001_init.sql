-- ════════════════════════════════════════════════════════════════════════════
-- Auctra schema v1 (MySQL 8, InnoDB, utf8mb4)
--
-- Conventions
--   • Money is DECIMAL(12,2) INR. Never FLOAT/DOUBLE: binary floating point cannot represent 0.10
--     exactly, and bidding compares amounts for ordering and equality.
--   • Timestamps are DATETIME(3) in UTC. The connection forces time_zone='+00:00'; the UI converts
--     to the viewer's local time.
--   • InnoDB is required: it provides transactions and row-level locks (SELECT … FOR UPDATE).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(80)  NOT NULL,
  email          VARCHAR(191) NOT NULL,
  password_hash  VARCHAR(100) NOT NULL,
  role           ENUM('USER','SELLER','ADMIN') NOT NULL DEFAULT 'USER',
  avatar_url     VARCHAR(500) NULL,
  status         ENUM('ACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE categories (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(60)  NOT NULL,
  slug         VARCHAR(60)  NOT NULL,
  description  VARCHAR(300) NULL,
  image_url    VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name),
  UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auctions (
  id                         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  seller_id                  INT UNSIGNED  NOT NULL,
  category_id                INT UNSIGNED  NOT NULL,
  title                      VARCHAR(120)  NOT NULL,
  description                TEXT          NOT NULL,
  starting_price             DECIMAL(12,2) NOT NULL,
  -- Denormalised summary of the highest accepted bid. It is written in the SAME transaction as the
  -- bid row while holding this row's lock, so it can never disagree with the bids table.
  current_highest_bid        DECIMAL(12,2) NULL,
  current_highest_bidder_id  INT UNSIGNED  NULL,
  minimum_bid_increment      DECIMAL(12,2) NOT NULL,
  bid_count                  INT UNSIGNED  NOT NULL DEFAULT 0,
  start_time                 DATETIME(3)   NOT NULL,
  end_time                   DATETIME(3)   NOT NULL,
  -- What the seller chose. end_time only moves later via the optional anti-sniping rule.
  original_end_time          DATETIME(3)   NOT NULL,
  status                     ENUM('DRAFT','SCHEDULED','ACTIVE','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  moderation_status          ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED',
  is_featured                TINYINT(1)    NOT NULL DEFAULT 0,
  winner_id                  INT UNSIGNED  NULL,
  final_price                DECIMAL(12,2) NULL,
  cancel_reason              VARCHAR(500)  NULL,
  ending_soon_notified_at    DATETIME(3)   NULL,
  completed_at               DATETIME(3)   NULL,
  -- Incremented on every state change (bid, start, end, cancel, edit). Socket events and cache
  -- snapshots carry it so clients and the cache can discard anything older than what they have.
  version                    INT UNSIGNED  NOT NULL DEFAULT 1,
  created_at                 DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Lifecycle worker scans: "ACTIVE and end_time <= now", "SCHEDULED and start_time <= now".
  KEY ix_auctions_status_end   (status, end_time),
  KEY ix_auctions_status_start (status, start_time),
  KEY ix_auctions_seller       (seller_id, status),
  KEY ix_auctions_category     (category_id, status),
  KEY ix_auctions_featured     (status, is_featured),
  KEY ix_auctions_leader       (current_highest_bidder_id),
  KEY ix_auctions_winner       (winner_id),
  CONSTRAINT fk_auctions_seller   FOREIGN KEY (seller_id)   REFERENCES users(id)      ON DELETE RESTRICT,
  CONSTRAINT fk_auctions_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
  CONSTRAINT fk_auctions_leader   FOREIGN KEY (current_highest_bidder_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_auctions_winner   FOREIGN KEY (winner_id)   REFERENCES users(id)      ON DELETE SET NULL,
  -- Database-level guards: even buggy application code cannot persist these states.
  CONSTRAINT ck_auctions_starting_price CHECK (starting_price > 0),
  CONSTRAINT ck_auctions_increment      CHECK (minimum_bid_increment > 0),
  CONSTRAINT ck_auctions_window         CHECK (end_time > start_time),
  CONSTRAINT ck_auctions_highest        CHECK (current_highest_bid IS NULL OR current_highest_bid >= starting_price),
  CONSTRAINT ck_auctions_leader_pair    CHECK ((current_highest_bid IS NULL) = (current_highest_bidder_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE auction_images (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  auction_id     INT UNSIGNED NOT NULL,
  image_url      VARCHAR(500) NOT NULL,
  alt_text       VARCHAR(200) NULL,
  display_order  INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auction_images_order (auction_id, display_order),
  CONSTRAINT fk_auction_images_auction FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE bids (
  id                 INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  auction_id         INT UNSIGNED  NOT NULL,
  bidder_id          INT UNSIGNED  NOT NULL,
  amount             DECIMAL(12,2) NOT NULL,
  -- Client-generated idempotency key (UUID). Scoped per bidder: a replay by the same user maps to the
  -- same row, while two different users cannot collide with each other.
  client_request_id  VARCHAR(64)   NOT NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bids_bidder_request (bidder_id, client_request_id),
  KEY ix_bids_auction_time   (auction_id, created_at),
  KEY ix_bids_auction_amount (auction_id, amount),
  KEY ix_bids_bidder_time    (bidder_id, created_at),
  CONSTRAINT fk_bids_auction FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE,
  CONSTRAINT fk_bids_bidder  FOREIGN KEY (bidder_id)  REFERENCES users(id)    ON DELETE RESTRICT,
  CONSTRAINT ck_bids_amount  CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE watchlist (
  user_id     INT UNSIGNED NOT NULL,
  auction_id  INT UNSIGNED NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, auction_id),
  KEY ix_watchlist_auction (auction_id),
  CONSTRAINT fk_watchlist_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_watchlist_auction FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE notifications (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  type        ENUM('BID_ACCEPTED','OUTBID','AUCTION_ENDING_SOON','AUCTION_WON','AUCTION_LOST','AUCTION_SOLD',
                   'AUCTION_ENDED_NO_BIDS','LISTING_APPROVED','LISTING_REJECTED','AUCTION_CANCELLED') NOT NULL,
  title       VARCHAR(150) NOT NULL,
  message     VARCHAR(500) NOT NULL,
  auction_id  INT UNSIGNED NULL,
  is_read     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_notifications_user (user_id, is_read, created_at),
  CONSTRAINT fk_notifications_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_notifications_auction FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE refresh_sessions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  -- SHA-256 of the opaque refresh token; the raw token only ever lives in the HttpOnly cookie.
  token_hash  CHAR(64)     NOT NULL,
  -- Every token produced by rotating one login shares a family; reuse of a rotated token revokes it.
  family_id   CHAR(36)     NOT NULL,
  expires_at  DATETIME(3)  NOT NULL,
  rotated_at  DATETIME(3)  NULL,
  revoked_at  DATETIME(3)  NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_token_hash (token_hash),
  KEY ix_refresh_user (user_id),
  KEY ix_refresh_family (family_id),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_logs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id     INT UNSIGNED NULL,
  action       VARCHAR(60)  NOT NULL,
  entity_type  VARCHAR(40)  NOT NULL,
  entity_id    INT UNSIGNED NULL,
  metadata     JSON         NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audit_entity (entity_type, entity_id),
  KEY ix_audit_actor (actor_id, created_at),
  KEY ix_audit_time (created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Transactional outbox. Rows are inserted in the SAME transaction as the business change they
-- describe, so "bid committed" and "event recorded" can never disagree. The dispatcher publishes
-- them to Socket.IO and invalidates cache after commit. Delivery is at-least-once.
CREATE TABLE outbox_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id      CHAR(36)     NOT NULL,
  type          VARCHAR(60)  NOT NULL,
  auction_id    INT UNSIGNED NULL,
  -- Target user for private events (notification:new). NULL = broadcast to the auction room.
  user_id       INT UNSIGNED NULL,
  version       INT UNSIGNED NULL,
  payload       JSON         NOT NULL,
  attempts      INT UNSIGNED NOT NULL DEFAULT 0,
  last_error    VARCHAR(500) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at  DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbox_event_id (event_id),
  KEY ix_outbox_pending (processed_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
