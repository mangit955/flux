import { describe, expect, it } from "bun:test";
import { RedisStreamBus, type RedisCommandExecutor } from "./redis-stream-bus";

describe("RedisStreamBus", () => {
  it("appends payloads with XADD", async () => {
    const redis = new FakeRedis();
    const bus = new RedisStreamBus({ redis });
    const message = await bus.append("engine.commands.BTC-PERP", {
      type: "order.created",
    });

    expect(message.id).toBe("1-0");
    expect(redis.commands[0]).toEqual([
      "XADD",
      [
        "engine.commands.BTC-PERP",
        "*",
        "payload",
        JSON.stringify({ type: "order.created" }),
      ],
    ]);
  });

  it("reads consumer-group messages from a RESP3 map reply", async () => {
    // Bun's Redis client negotiates RESP3, where XREADGROUP replies with a map keyed by stream
    // name rather than the RESP2 array below. Decoding only the array form silently returned
    // zero messages for commands Redis had already moved into the PEL, so the matching worker
    // consumed and discarded every order.
    const redis = new FakeRedis({
      XREADGROUP: {
        "engine.commands.BTC-PERP": [["3-0", ["payload", "{\"ok\":true}"]]],
      },
    });
    const bus = new RedisStreamBus({ redis });

    const messages = await bus.readGroup<{ ok: boolean }>(
      "engine.commands.BTC-PERP",
      "matching-engine",
      "consumer-1",
    );

    expect(messages).toEqual([
      {
        id: "3-0",
        stream: "engine.commands.BTC-PERP",
        payload: { ok: true },
      },
    ]);
  });

  it("reads consumer-group messages and acks them", async () => {
    const redis = new FakeRedis({
      XREADGROUP: [["engine.events.BTC-PERP", [["2-0", ["payload", "{\"ok\":true}"]]]]],
    });
    const bus = new RedisStreamBus({ redis });
    const messages = await bus.readGroup<{ ok: boolean }>(
      "engine.events.BTC-PERP",
      "persistence-worker",
      "consumer-1",
    );

    await bus.ack("engine.events.BTC-PERP", "persistence-worker", ["2-0"]);

    expect(messages).toEqual([
      {
        id: "2-0",
        stream: "engine.events.BTC-PERP",
        payload: { ok: true },
      },
    ]);
    expect(redis.commands.at(-1)).toEqual([
      "XACK",
      ["engine.events.BTC-PERP", "persistence-worker", "2-0"],
    ]);
  });
});

class FakeRedis implements RedisCommandExecutor {
  readonly commands: Array<[string, string[]]> = [];

  constructor(private readonly responses: Record<string, unknown> = {}) {}

  async send(command: string, args: string[]): Promise<unknown> {
    this.commands.push([command, args]);
    return this.responses[command] ?? (command === "XADD" ? "1-0" : []);
  }
}
