import {
  ExchangeRuntime,
  LiquidationWorker,
  OutboxPublisher,
  PriceCacheMarkPriceSource,
  PrismaApiRuntime,
  PrismaLiquidationStore,
  ProductionMatchingWorker,
  ProductionPersistenceWorker,
  RedisStreamBus,
  RedisOrderBookCache,
  RedisPriceCache,
  type OrderRecoveryClient,
  type OutboxPublisherClient,
  type PrismaApiClient,
  type PrismaLiquidationClient,
  type RuntimeMarket,
} from "../../../packages/runtime/src/index";
import { PersistenceService, PrismaPersistenceStore } from "../../../packages/db/src/index";
import type { PrismaClientLike } from "../../../packages/db/src/index";
import { FileSnapshotStore } from "../../../packages/matching-engine/index";

if (Bun.env.RUNTIME_MODE === "production") {
  await runProductionWorkers();
} else {
  runLocalWorker();
}

function runLocalWorker(): void {
  const runtime = new ExchangeRuntime();
  const intervalMs = Number(Bun.env.WORKER_INTERVAL_MS ?? 100);

  console.log(`Workers polling every ${intervalMs}ms`);

  setInterval(async () => {
    try {
      await runtime.drain(1);
    } catch (error) {
      console.error("worker iteration failed", error);
    }
  }, intervalMs);
}

async function runProductionWorkers(): Promise<void> {
  console.log("🚀 Starting production workers...");
  console.log(`Environment: RUNTIME_MODE=${Bun.env.RUNTIME_MODE}`);
  console.log(`Database URL: ${Bun.env.DATABASE_URL ? 'Set' : 'Missing'}`);
  console.log(`Redis URL: ${Bun.env.REDIS_URL ? 'Set' : 'Missing'}`);
  
  // Start health check server for Railway
  const port = Number(Bun.env.PORT ?? 3000);
  let healthStatus = { status: "starting", lastPoll: new Date().toISOString(), processedTotal: 0 };
  
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json(healthStatus);
      }
      return new Response("Workers Service - Use /health endpoint", { status: 200 });
    },
  });
  console.log(`✓ Health check server listening on port ${port}`);
  
  try {
    const PrismaClient = await loadPrismaClient();
    console.log("✓ Prisma Client loaded");
    
    const client = new PrismaClient({
      datasources: { db: { url: requiredEnv("DATABASE_URL") } },
    });
    console.log("✓ Database client created");
    
    const redisUrl = requiredEnv("REDIS_URL");
    const bus = new RedisStreamBus({ redisUrl });
    console.log("✓ Redis stream bus created");
    
    const orderBookCache = new RedisOrderBookCache({ redisUrl });
    console.log("✓ OrderBook cache created");
    
    const role = Bun.env.WORKER_ROLE ?? "all";
    const intervalMs = Number(Bun.env.WORKER_INTERVAL_MS ?? 100);
    
    const markets = async () => {
      const rows = await client.market.findMany({
        where: { status: "ACTIVE" },
        select: { id: true },
        orderBy: { id: "asc" },
      });

      return rows.map((row: unknown) => String((row as { id: string }).id));
    };
    
    // Test database connection
    const activeMarkets = await markets();
    console.log(`✓ Database connected, found ${activeMarkets.length} active markets:`, activeMarkets);
    
    const outbox = new OutboxPublisher(client, bus);
    const matching = new ProductionMatchingWorker({
      bus,
      markets,
      orderBookCache,
      orderRecoveryClient: client,
    });
    console.log("✓ Matching worker created");
    
    const persistence = new ProductionPersistenceWorker(
      bus,
      new PersistenceService(new PrismaPersistenceStore(client)),
      markets,
    );
    console.log("✓ Persistence worker created");

    const liquidation =
      role === "all" || role === "liquidation"
        ? createLiquidationWorker(client, redisUrl)
        : undefined;

    if (liquidation) {
      console.log("✓ Liquidation worker created");
    }

    console.log("🔄 Recovering matching engine state...");
    await matching.recover();
    console.log("✓ Recovery complete");
    
    console.log(`✅ Production workers started with role=${role}, interval=${intervalMs}ms`);
    healthStatus.status = "running";

    // Track consecutive errors for exponential backoff.
    // Without backoff, a persistent error (e.g. PEL limit) generates
    // hundreds of log lines per second and wastes Redis quota.
    let consecutiveErrors = 0;
    const MAX_BACKOFF_MS = 5000;

    const poll = async () => {
      try {
        let processed = 0;
        if (role === "all" || role === "outbox") {
          const count = await outbox.publishOnce();
          processed += count;
        }
        if (role === "all" || role === "matching") {
          const count = await matching.processOnce();
          processed += count;
        }
        if (role === "all" || role === "persistence") {
          const count = await persistence.processOnce();
          processed += count;
        }
        
        consecutiveErrors = 0; // reset on success
        
        // Update health status
        healthStatus.lastPoll = new Date().toISOString();
        healthStatus.processedTotal += processed;
        
        if (processed > 0) {
          console.log(`[${new Date().toISOString()}] Processed ${processed} items (total: ${healthStatus.processedTotal})`);
        }
      } catch (error) {
        consecutiveErrors += 1;
        healthStatus.status = `error (streak=${consecutiveErrors})`;
        console.error(`[ERROR] Worker iteration failed (streak=${consecutiveErrors}):`, error);
      }

      // Schedule next poll with backoff on errors
      const delay = consecutiveErrors > 0
        ? Math.min(intervalMs * Math.pow(2, consecutiveErrors), MAX_BACKOFF_MS)
        : intervalMs;
      setTimeout(poll, delay);
    };

    // Kick off the first poll
    setTimeout(poll, intervalMs);

    if (liquidation) {
      // Its own, slower cadence: a margin scan reads every open position, which is far too much
      // work for the 100ms command-processing tick.
      const liquidationIntervalMs = Number(Bun.env.LIQUIDATION_INTERVAL_MS ?? 1000);
      const scan = async () => {
        try {
          const actions = await liquidation.processOnce();

          if (actions > 0) {
            console.log(`[LIQUIDATION] ${actions} action(s) taken`);
          }
        } catch (error) {
          console.error("[LIQUIDATION] scan failed:", error);
        }

        setTimeout(scan, liquidationIntervalMs);
      };

      setTimeout(scan, liquidationIntervalMs);
      console.log(`✓ Liquidation scan every ${liquidationIntervalMs}ms`);
    }
  } catch (error) {
    console.error("❌ Failed to start production workers:", error);
    throw error;
  }
}

/**
 * The liquidation worker submits its forced closes through `PrismaApiRuntime`, so a liquidation
 * order takes exactly the same path as a user order — margin check, order row, outbox, command
 * stream. Reduce-only orders reserve no collateral, so nothing about the money path changes.
 *
 * Single instance only: two replicas scanning the same positions would each submit a close and
 * double the size being liquidated. TODO #16 (leader election) covers this worker too.
 */
function createLiquidationWorker(
  client: WorkerPrismaClient,
  redisUrl: string,
): LiquidationWorker {
  const apiRuntime = new PrismaApiRuntime({
    client,
    // Never used — the worker calls neither login nor authenticate — but a blank secret must not
    // be silently accepted, in case a future caller does.
    jwtSecret: requiredEnv("JWT_SECRET"),
  });

  return new LiquidationWorker({
    store: new PrismaLiquidationStore(client),
    submitter: apiRuntime,
    markPrices: new PriceCacheMarkPriceSource(new RedisPriceCache({ redisUrl })),
    markets: async () =>
      (await apiRuntime.listMarkets()).filter(
        (market: RuntimeMarket) => market.status === "ACTIVE",
      ),
  });
}

type WorkerPrismaClient = PrismaClientLike &
  OutboxPublisherClient &
  OrderRecoveryClient &
  PrismaApiClient &
  PrismaLiquidationClient & {
    market: {
      findMany(args: unknown): Promise<Array<{ id: string }>>;
    };
    snapshotMetadata: {
      create(args: unknown): Promise<unknown>;
    };
  };

interface PrismaClientConstructor {
  new (options?: unknown): WorkerPrismaClient;
}

async function loadPrismaClient(): Promise<PrismaClientConstructor> {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{ PrismaClient: PrismaClientConstructor }>;
  const mod = await importer("@prisma/client");
  return mod.PrismaClient;
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];

  if (!value) {
    throw new Error(`${name} is required in production worker mode`);
  }

  return value;
}
