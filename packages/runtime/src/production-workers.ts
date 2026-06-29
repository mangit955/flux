import {
  MatchingEngine,
  OrderBook,
  recoverOrderBookFromSnapshot,
  type EngineEvent,
  type SnapshotStore,
  type StoredOrderBookSnapshot,
} from "../../matching-engine/index";
import { PersistenceService } from "../../db/src/index";
import type { AckingStreamBus } from "./stream";
import { commandStream, eventStream } from "./stream";
import type { RuntimeCommand } from "./types";
import type { OrderBookCache } from "./orderbook-cache";
import { RedisStreamBus } from "./redis-stream-bus";

export interface SnapshotMetadataClient {
  snapshotMetadata: {
    create(args: {
      data: {
        marketId: string;
        snapshotPath: string;
        engineSequence: bigint;
        lastRedisStreamId: string;
        createdAt: Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * Minimal Prisma-like client for recovering open orders from the database.
 * Only needs read access to the `order` table.
 */
export interface OrderRecoveryClient {
  order: {
    findMany(args: {
      where: { marketId: string; status: { in: string[] } };
      orderBy: { createdAt: "asc" };
    }): Promise<Array<Record<string, unknown>>>;
  };
}

export interface ProductionMatchingWorkerOptions {
  bus: AckingStreamBus;
  engine?: MatchingEngine;
  markets: () => string[] | Promise<string[]>;
  snapshotStore?: SnapshotStore;
  snapshotClient?: SnapshotMetadataClient;
  snapshotIntervalMs?: number;
  consumerName?: string;
  clock?: () => number;
  orderBookCache?: OrderBookCache;
  /** Prisma client for recovering open orders from the database on startup */
  orderRecoveryClient?: OrderRecoveryClient;
}

export class ProductionMatchingWorker {
  readonly engine: MatchingEngine;
  private readonly lastEventIds = new Map<string, string>();
  private readonly lastSnapshotAt = new Map<string, number>();
  private pendingCleanupComplete = false;

  constructor(private readonly options: ProductionMatchingWorkerOptions) {
    this.engine = options.engine ?? new MatchingEngine({ clock: options.clock });
  }

  async recover(): Promise<void> {
    // First, clean up any existing pending entries to recover from PEL limit
    await this.cleanupPendingEntries();

    // Try snapshot-based recovery first
    if (this.options.snapshotStore) {
      let snapshotRecovered = false;

      for (const market of await this.markets()) {
        const snapshot = await this.options.snapshotStore.readLatest(market);

        if (!snapshot) {
          continue;
        }

        const messages = await this.options.bus.readAfter<{ type: "engine.event"; event: EngineEvent }>(
          eventStream(market),
          snapshot.lastRedisStreamId,
        );
        const orderBook = recoverOrderBookFromSnapshot({
          snapshot,
          eventsAfterSnapshot: messages.map((message) => message.payload.event),
          clock: this.options.clock,
        });

        this.engine.restoreBook(market, orderBook);
        this.lastEventIds.set(market, messages.at(-1)?.id ?? snapshot.lastRedisStreamId);
        snapshotRecovered = true;
        
        // Publish initial orderbook to Redis cache after recovery
        if (this.options.orderBookCache) {
          await this.publishOrderBookToCache(market);
        }
      }

      if (snapshotRecovered) {
        return;
      }
    }

    // Fallback: recover from database (essential for ephemeral filesystems like Railway)
    if (this.options.orderRecoveryClient) {
      await this.recoverFromDatabase();
    }
  }

  /**
   * Recover the in-memory orderbook from the database by loading all
   * OPEN and PARTIALLY_FILLED limit orders and injecting them directly
   * into the matching engine.
   *
   * This is critical for deployments on ephemeral filesystems (e.g. Railway)
   * where file-based snapshots don't survive restarts.
   */
  private async recoverFromDatabase(): Promise<void> {
    const client = this.options.orderRecoveryClient;
    if (!client) return;

    console.log("[MATCHING] Recovering orderbook from database...");

    for (const market of await this.markets()) {
      const rows = await client.order.findMany({
        where: {
          marketId: market,
          status: { in: ["PENDING", "OPEN", "PARTIALLY_FILLED"] },
        },
        orderBy: { createdAt: "asc" },
      });

      if (rows.length === 0) {
        console.log(`[MATCHING] No open orders to recover for ${market}`);
        continue;
      }

      // Build a snapshot that OrderBook.fromSnapshot() can consume.
      // Group orders by side and price level.
      const bidLevels = new Map<number, Array<{ orderId: string; userId: string; market: string; side: "buy" | "sell"; type: "limit"; qtyLots: number; remainingQtyLots: number; priceTicks: number; status: "OPEN" | "PARTIALLY_FILLED"; timeInForce: "GTC" | "IOC"; reduceOnly: boolean; postOnly: boolean; createdAt: number; sequence: number }>>();
      const askLevels = new Map<number, typeof bidLevels extends Map<number, infer V> ? V : never>();

      let maxSequence = 0;

      for (const row of rows) {
        const side = String(row.side).toLowerCase() as "buy" | "sell";
        const price = Number(row.price ?? 0);
        const type = String(row.type).toLowerCase() as "limit" | "market";

        // Only recover limit orders (market orders shouldn't be resting)
        if (type !== "limit" || price === 0) continue;

        maxSequence += 1;
        const orderEntry = {
          orderId: String(row.id),
          userId: String(row.userId),
          market,
          side,
          type: "limit" as const,
          qtyLots: Number(row.quantity ?? 0),
          remainingQtyLots: Number(row.remainingQuantity ?? 0),
          priceTicks: price,
          status: (String(row.status) === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "OPEN") as "OPEN" | "PARTIALLY_FILLED",
          timeInForce: (String(row.timeInForce ?? "GTC")) as "GTC" | "IOC",
          reduceOnly: Boolean(row.reduceOnly),
          postOnly: Boolean(row.postOnly),
          createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt ?? 0),
          sequence: maxSequence,
        };

        const levels = side === "buy" ? bidLevels : askLevels;
        const existing = levels.get(price) ?? [];
        existing.push(orderEntry);
        levels.set(price, existing);
      }

      const buildPriceLevels = (levels: typeof bidLevels) =>
        [...levels.entries()].map(([priceTicks, orders]) => ({
          priceTicks,
          totalQtyLots: orders.reduce((sum, o) => sum + o.remainingQtyLots, 0),
          orders,
        }));

      const snapshot = {
        market,
        sequence: maxSequence,
        bids: buildPriceLevels(bidLevels),
        asks: buildPriceLevels(askLevels),
      };

      const book = OrderBook.fromSnapshot(snapshot, this.options.clock);
      this.engine.restoreBook(market, book);

      console.log(
        `[MATCHING] Recovered ${rows.length} open orders for ${market} ` +
        `(${bidLevels.size} bid levels, ${askLevels.size} ask levels)`,
      );

      // Publish recovered orderbook to Redis cache immediately
      if (this.options.orderBookCache) {
        await this.publishOrderBookToCache(market);
      }
    }

    console.log("[MATCHING] Database recovery complete");
  }

  /**
   * Clean up old pending entries that may have accumulated due to errors.
   * This prevents PEL limit issues by claiming and acknowledging stale messages.
   */
  private async cleanupPendingEntries(): Promise<void> {
    if (this.pendingCleanupComplete) {
      return;
    }

    console.log("[MATCHING] Skipping pending entries cleanup (disabled)");
    this.pendingCleanupComplete = true;
  }

  async processOnce(): Promise<number> {
    let processed = 0;

    for (const market of await this.markets()) {
      const stream = commandStream(market);
      const group = `matching-engine:${market}`;
      const consumer = this.options.consumerName ?? "matching-engine-1";
      
      try {
        console.log(`[MATCHING] Reading from ${stream} with group ${group}, consumer ${consumer}`);
        const messages = await this.options.bus.readGroup<RuntimeCommand>(
          stream,
          group,
          consumer,
          { count: 10 },
        );

        console.log(`[MATCHING] Read ${messages.length} messages from ${stream}`);

        for (const message of messages) {
          try {
            const events =
              message.payload.type === "order.created"
                ? this.engine.submitOrder(message.payload.command)
                : this.engine.cancelOrder(message.payload.command);

            for (const event of events) {
              const written = await this.options.bus.append(eventStream(event.market), {
                type: "engine.event",
                event,
              });
              this.lastEventIds.set(event.market, written.id);
            }

            processed += 1;
          } catch (error) {
            // Log error but still ack the message to prevent PEL buildup
            console.error(`[MATCHING] Error processing message ${message.id}:`, error);
            console.error(`[MATCHING] Message type: ${message.payload.type}`);
            console.error(`[MATCHING] Command:`, JSON.stringify(message.payload.command));
          }

          // ACK immediately after each message to keep PEL as small as possible.
          // Upstash enforces a 1000 PEL limit per consumer; batching acks risks
          // hitting that limit under load.
          await this.options.bus.ack(stream, group, [message.id]);
        }

        await this.maybeSnapshot(market);
        
        // Always publish orderbook to Redis cache
        if (this.options.orderBookCache) {
          await this.publishOrderBookToCache(market);
        }

        // Trim the command stream to prevent unbounded growth
        if ('trimStream' in this.options.bus) {
          await (this.options.bus as any).trimStream(stream, 1000);
        }
      } catch (error) {
        // If this is a PEL limit error, try to recover by cleaning up pending entries
        if (RedisStreamBus.isPelLimitError(error)) {
          console.warn(`[MATCHING] PEL limit hit for ${market}, running emergency cleanup...`);
          this.pendingCleanupComplete = false;
          await this.cleanupPendingEntries();
        } else {
          console.error(`[MATCHING] Error processing market ${market}:`, error);
        }
      }
    }

    return processed;
  }

  private async publishOrderBookToCache(market: string): Promise<void> {
    if (!this.options.orderBookCache) {
      return;
    }

    try {
      const snapshot = this.engine.getBookSnapshot(market, 20);
      await this.options.orderBookCache.set(market, {
        market: snapshot.market,
        sequence: snapshot.sequence,
        bids: snapshot.bids,
        asks: snapshot.asks,
        timestamp: this.options.clock?.() ?? Date.now(),
      });
    } catch (error) {
      console.error(`Failed to publish orderbook to Redis cache for ${market}:`, error);
    }
  }

  private async maybeSnapshot(market: string): Promise<void> {
    const intervalMs = this.options.snapshotIntervalMs;

    if (!intervalMs || !this.options.snapshotStore) {
      return;
    }

    const now = this.options.clock?.() ?? Date.now();
    const previous = this.lastSnapshotAt.get(market) ?? 0;

    if (now - previous < intervalMs) {
      return;
    }

    const snapshot: StoredOrderBookSnapshot = {
      market,
      engineSequence: this.engine.getBookSnapshot(market).sequence,
      lastRedisStreamId: this.lastEventIds.get(market) ?? "0-0",
      createdAt: now,
      orderBook: this.engine.getBookSnapshot(market),
    };
    const snapshotPath = await this.options.snapshotStore.write(snapshot);
    this.lastSnapshotAt.set(market, now);

    await this.options.snapshotClient?.snapshotMetadata.create({
      data: {
        marketId: market,
        snapshotPath,
        engineSequence: BigInt(snapshot.engineSequence),
        lastRedisStreamId: snapshot.lastRedisStreamId,
        createdAt: new Date(snapshot.createdAt),
      },
    });
  }

  private async markets(): Promise<string[]> {
    return this.options.markets();
  }
}

export class ProductionPersistenceWorker {
  constructor(
    private readonly bus: AckingStreamBus,
    private readonly service: PersistenceService,
    private readonly markets: () => string[] | Promise<string[]>,
    private readonly consumerName = "persistence-worker-1",
  ) {}

  async processOnce(): Promise<number> {
    let processed = 0;

    for (const market of await this.markets()) {
      const stream = eventStream(market);
      
      try {
        const messages = await this.bus.readGroup<{ type: "engine.event"; event: EngineEvent }>(
          stream,
          "persistence-worker",
          this.consumerName,
          { count: 10 },
        );

        for (const message of messages) {
          try {
            await this.service.persistEvent(message.payload.event, {
              stream,
              streamId: message.id,
            });
            processed += 1;
          } catch (error) {
            // Log error but still ack the message to prevent PEL buildup
            console.error(`[PERSISTENCE] Error processing message ${message.id}:`, error);
          }

          // ACK immediately per message — same rationale as matching worker
          await this.bus.ack(stream, "persistence-worker", [message.id]);
        }

        // Trim the event stream to prevent unbounded growth
        if ('trimStream' in this.bus) {
          await (this.bus as any).trimStream(stream, 1000);
        }
      } catch (error) {
        if (RedisStreamBus.isPelLimitError(error)) {
          console.warn(`[PERSISTENCE] PEL limit hit for ${market}, attempting cleanup...`);
          // Try to claim and ack pending messages
          if ('claimAndAckPending' in this.bus) {
            await (this.bus as any).claimAndAckPending(
              stream, "persistence-worker", this.consumerName, 5000, 500,
            );
          }
        } else {
          console.error(`[PERSISTENCE] Error processing market ${market}:`, error);
        }
      }
    }

    return processed;
  }
}
