import { describe, expect, it } from "bun:test";
import { createApiApp } from "./app";

describe("api app", () => {
  it("registers users, deposits collateral, submits orders, and exposes fills", async () => {
    const app = createApiApp({ environment: "development" });

    const maker = await json<{ userId: string }>(
      await app.fetch(post("/auth/register", {
        email: "maker@example.com",
        password: "pw",
      })),
    );
    const taker = await json<{ userId: string }>(
      await app.fetch(post("/auth/register", {
        email: "taker@example.com",
        password: "pw",
      })),
    );
    const makerLogin = await json<{ token: string }>(
      await app.fetch(post("/auth/login", {
        email: "maker@example.com",
        password: "pw",
      })),
    );
    const takerLogin = await json<{ token: string }>(
      await app.fetch(post("/auth/login", {
        email: "taker@example.com",
        password: "pw",
      })),
    );

    expect(maker.userId).not.toBe(taker.userId);

    await app.fetch(authPost("/deposits", makerLogin.token, {
      asset: "USDC",
      amount: 10_000,
    }));
    await app.fetch(authPost("/deposits", takerLogin.token, {
      asset: "USDC",
      amount: 10_000,
    }));
    await app.fetch(authPost("/orders", makerLogin.token, {
      marketId: "BTC-PERP",
      side: "SELL",
      type: "LIMIT",
      quantity: 1,
      price: 100,
      timeInForce: "GTC",
    }));
    await app.fetch(authPost("/orders", takerLogin.token, {
      marketId: "BTC-PERP",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 100,
      timeInForce: "GTC",
    }));
    await app.runtime.drain();

    const makerFills = await json<Array<{ fee: number; realizedPnl: number }>>(
      await app.fetch(authGet("/fills", makerLogin.token)),
    );
    const takerFills = await json<Array<{ fee: number }>>(
      await app.fetch(authGet("/fills", takerLogin.token)),
    );
    const takerPositions = await json<Array<{ quantity: number }>>(
      await app.fetch(authGet("/positions", takerLogin.token)),
    );
    const makerBalances = await json<Array<{ asset: string; total: number }>>(
      await app.fetch(authGet("/balances", makerLogin.token)),
    );
    const takerBalances = await json<Array<{ asset: string; total: number }>>(
      await app.fetch(authGet("/balances", takerLogin.token)),
    );

    expect(makerFills).toHaveLength(1);
    expect(takerPositions[0]?.quantity).toBe(1);

    // The in-memory runtime must charge the same per-role fees as PersistenceService, or the
    // two runtimes drift and only production is wrong. 1 @ 100 => notional 100.
    expect(makerFills[0]?.fee).toBeCloseTo(100 * 0.0002, 10);
    expect(takerFills[0]?.fee).toBeCloseTo(100 * 0.0005, 10);
    expect(makerFills[0]?.realizedPnl).toBe(0);

    const usdc = (balances: Array<{ asset: string; total: number }>) =>
      balances.find((balance) => balance.asset === "USDC")?.total ?? 0;

    expect(usdc(makerBalances)).toBeCloseTo(10_000 - 100 * 0.0002, 10);
    expect(usdc(takerBalances)).toBeCloseTo(10_000 - 100 * 0.0005, 10);
  });

  it("exposes orderbook data", async () => {
    const app = createApiApp({ environment: "development" });

    // Test empty orderbook initially
    const emptyOrderbook = await json<{
      market: string;
      sequence: number;
      bids: unknown[];
      asks: unknown[];
    }>(
      await app.fetch(get("/markets/BTC-PERP/orderbook")),
    );

    expect(emptyOrderbook.market).toBe("BTC-PERP");
    expect(emptyOrderbook.bids).toEqual([]);
    expect(emptyOrderbook.asks).toEqual([]);

    // Add some orders to create orderbook data
    const user = await json<{ userId: string }>(
      await app.fetch(post("/auth/register", {
        email: "user@example.com",
        password: "pw",
      })),
    );
    const login = await json<{ token: string }>(
      await app.fetch(post("/auth/login", {
        email: "user@example.com",
        password: "pw",
      })),
    );

    await app.fetch(authPost("/deposits", login.token, {
      asset: "USDC",
      amount: 10_000,
    }));

    // Add a bid and ask
    await app.fetch(authPost("/orders", login.token, {
      marketId: "BTC-PERP",
      side: "BUY",
      type: "LIMIT",
      quantity: 1,
      price: 99,
      timeInForce: "GTC",
    }));
    await app.fetch(authPost("/orders", login.token, {
      marketId: "BTC-PERP",
      side: "SELL",
      type: "LIMIT",
      quantity: 1,
      price: 101,
      timeInForce: "GTC",
    }));
    
    await app.runtime.drain();

    const orderbook = await json<{
      market: string;
      sequence: number;
      bids: Array<{ priceTicks: number; totalQtyLots: number }>;
      asks: Array<{ priceTicks: number; totalQtyLots: number }>;
    }>(
      await app.fetch(get("/markets/BTC-PERP/orderbook")),
    );

    expect(orderbook.market).toBe("BTC-PERP");
    expect(orderbook.bids).toHaveLength(1);
    expect(orderbook.asks).toHaveLength(1);
    expect(orderbook.bids[0]?.priceTicks).toBe(99);
    expect(orderbook.asks[0]?.priceTicks).toBe(101);
  });

  it("creates guest sessions that can use authenticated trading workflows", async () => {
    const app = createApiApp({ environment: "development" });

    const guest = await json<{ token: string; userId: string }>(
      await app.fetch(post("/auth/guest", {})),
    );

    expect(guest.token).toBeTruthy();
    expect(guest.userId).toBeTruthy();

    const balance = await json<{ userId: string; total: number }>(
      await app.fetch(authPost("/deposits", guest.token, {
        asset: "USDC",
        amount: 10_000,
      })),
    );
    const order = await json<{ userId: string; status: string }>(
      await app.fetch(authPost("/orders", guest.token, {
        marketId: "BTC-PERP",
        side: "BUY",
        type: "LIMIT",
        quantity: 1,
        price: 99,
        timeInForce: "GTC",
      })),
    );
    const orders = await json<Array<{ userId: string }>>(
      await app.fetch(authGet("/orders", guest.token)),
    );

    expect(balance.userId).toBe(guest.userId);
    expect(balance.total).toBe(10_000);
    expect(order.userId).toBe(guest.userId);
    expect(order.status).toBe("PENDING");
    expect(orders).toHaveLength(1);
    expect(orders[0]?.userId).toBe(guest.userId);
  });

  it("does not expose fake deposits outside development", async () => {
    const app = createApiApp({ environment: "production" });
    const guest = await json<{ token: string }>(
      await app.fetch(post("/auth/guest", {})),
    );

    const response = await app.fetch(authPost("/deposits", guest.token, {
      asset: "USDC",
      amount: 10_000,
    }));

    expect(response.status).toBe(404);
  });
});

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function authPost(path: string, token: string, body: unknown): Request {
  const request = post(path, body);
  request.headers.set("authorization", `Bearer ${token}`);
  return request;
}

function authGet(path: string, token: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function get(path: string): Request {
  return new Request(`http://localhost${path}`);
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBeLessThan(400);
  return (await response.json()) as T;
}
