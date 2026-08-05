import type { AckingStreamBus } from "./stream";
import type { StreamMessage } from "./types";

export interface RedisCommandExecutor {
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisStreamBusOptions {
  redis?: RedisCommandExecutor;
  redisUrl?: string;
  createGroups?: boolean;
}

export class RedisStreamBus implements AckingStreamBus {
  private readonly redis: RedisCommandExecutor;
  private readonly createGroups: boolean;
  private readonly createdGroups = new Set<string>();

  constructor(options: RedisStreamBusOptions = {}) {
    this.redis = options.redis ?? createBunRedis(options.redisUrl);
    this.createGroups = options.createGroups ?? true;
  }

  async append<T>(stream: string, payload: T): Promise<StreamMessage<T>> {
    const id = await this.command("XADD", [
      stream,
      "*",
      "payload",
      JSON.stringify(payload),
    ]);

    return {
      id: String(id),
      stream,
      payload,
    };
  }

  async readAfter<T>(
    stream: string,
    afterId = "0-0",
    limit = 100,
  ): Promise<StreamMessage<T>[]> {
    const rows = await this.command("XRANGE", [
      stream,
      `(${afterId}`,
      "+",
      "COUNT",
      String(limit),
    ]);

    return decodeRedisStreamRows(stream, rows);
  }

  async readGroup<T>(
    stream: string,
    group: string,
    consumer: string,
    options: { count?: number; blockMs?: number } = {},
  ): Promise<StreamMessage<T>[]> {
    if (this.createGroups) {
      await this.ensureGroup(stream, group);
    }

    // Upstash enforces a PEL limit of 1000 per consumer.
    // Use a small COUNT (default 10) and non-blocking reads (BLOCK 0)
    // to minimise PEL pressure.  We already poll on a setInterval so
    // blocking is redundant.
    const count = options.count ?? 10;
    const blockMs = options.blockMs ?? 0;

    const args = [
      "GROUP",
      group,
      consumer,
      "COUNT",
      String(count),
      ...(blockMs > 0 ? ["BLOCK", String(blockMs)] : []),
      "STREAMS",
      stream,
      ">", // This reads only NEW messages after last-delivered-id
    ];

    const rows = await this.command("XREADGROUP", args);

    return decodeXReadGroupRows(stream, rows);
  }

  async ack(stream: string, group: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.command("XACK", [stream, group, ...ids]);
  }

  /**
   * Trim a stream to approximately `maxLen` entries using XTRIM … MAXLEN ~.
   * The ~ (tilde) lets Redis trim a bit less aggressively for performance.
   */
  async trimStream(stream: string, maxLen = 1000): Promise<void> {
    await this.command("XTRIM", [stream, "MAXLEN", "~", String(maxLen)]);
  }

  /**
   * Returns true if the error is an Upstash PEL-limit error.
   */
  static isPelLimitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.message.includes("Pending Entries List limit");
  }

  /**
   * Claim and acknowledge old pending messages for a consumer group.
   * This helps recover from PEL limit issues by cleaning up messages
   * that were never acknowledged due to errors.
   */
  async claimAndAckPending(
    stream: string,
    group: string,
    consumer: string,
    minIdleTimeMs = 60000,
    count = 100,
  ): Promise<number> {
    try {
      // Use XAUTOCLAIM to claim messages that have been idle for too long
      const result = await this.command("XAUTOCLAIM", [
        stream,
        group,
        consumer,
        String(minIdleTimeMs),
        "0-0",
        "COUNT",
        String(count),
      ]);

      // Result format: [nextId, [messages...]]
      if (!Array.isArray(result) || result.length < 2) {
        return 0;
      }

      const messages = result[1];
      if (!Array.isArray(messages) || messages.length === 0) {
        return 0;
      }

      // Extract message IDs and acknowledge them
      const ids = messages
        .filter((msg) => Array.isArray(msg) && msg[0])
        .map((msg) => String(msg[0]));

      if (ids.length > 0) {
        await this.ack(stream, group, ids);
        console.log(`[REDIS] Claimed and acked ${ids.length} stale messages from ${stream}`);
      }

      return ids.length;
    } catch (error) {
      console.error(`[REDIS] Error claiming pending messages from ${stream}:`, error);
      return 0;
    }
  }

  private async ensureGroup(stream: string, group: string): Promise<void> {
    const key = `${stream}:${group}`;

    if (this.createdGroups.has(key)) {
      return;
    }

    try {
      await this.command("XGROUP", [
        "CREATE",
        stream,
        group,
        "0",
        "MKSTREAM",
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!message.includes("BUSYGROUP")) {
        throw error;
      }
    }

    this.createdGroups.add(key);
  }

  private command(command: string, args: string[]): Promise<unknown> {
    return this.redis.send(command, args);
  }
}

function createBunRedis(redisUrl: string | undefined): RedisCommandExecutor {
  const bunWithRedis = Bun as unknown as {
    redis?: RedisCommandExecutor;
    RedisClient?: new (url?: string) => RedisCommandExecutor;
  };

  if (bunWithRedis.RedisClient) {
    return new bunWithRedis.RedisClient(redisUrl);
  }

  if (bunWithRedis.redis) {
    return bunWithRedis.redis;
  }

  throw new Error("Bun Redis client is unavailable in this runtime");
}

function decodeXReadGroupRows<T>(
  fallbackStream: string,
  rows: unknown,
): StreamMessage<T>[] {
  const result: StreamMessage<T>[] = [];

  // XREADGROUP is the one stream reply whose shape depends on the protocol version: RESP2
  // returns [[stream, entries], ...] while RESP3 returns a map keyed by stream name. Bun's
  // Redis client negotiates RESP3, so accepting only the array form silently dropped every
  // message the consumer group had already moved into the PEL — commands were consumed and
  // discarded, and no order could ever match. XRANGE and XAUTOCLAIM are arrays either way.
  for (const [stream, messages] of streamEntries(fallbackStream, rows)) {
    if (Array.isArray(messages)) {
      result.push(...decodeRedisStreamRows<T>(stream, messages));
    }
  }

  return result;
}

function streamEntries(
  fallbackStream: string,
  rows: unknown,
): Array<[string, unknown]> {
  if (Array.isArray(rows)) {
    return rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => [String(row[0] ?? fallbackStream), row[1]]);
  }

  if (rows && typeof rows === "object") {
    return Object.entries(rows as Record<string, unknown>);
  }

  return [];
}

function decodeRedisStreamRows<T>(
  stream: string,
  rows: unknown,
): StreamMessage<T>[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.flatMap((row) => {
    if (!Array.isArray(row)) {
      return [];
    }

    const id = String(row[0]);
    const fields = Array.isArray(row[1]) ? row[1] : [];
    const payloadIndex = fields.findIndex((field) => String(field) === "payload");
    const rawPayload = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;

    if (rawPayload == null) {
      return [];
    }

    return [{
      id,
      stream,
      payload: JSON.parse(String(rawPayload)) as T,
    }];
  });
}
