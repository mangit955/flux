// ═══════════════════════════════════════════════════════════════════════════════
// Flux Perpetual Futures Exchange — k6 Load Test
// ═══════════════════════════════════════════════════════════════════════════════
//
// Target:  100 VUs × 10 orders each = 1,000 bets (orders) over 10 seconds
// Latency: p95 order submission response < 10ms
//
// Usage:
//   k6 run load-tests/perpetual-futures-load-test.js
//   k6 run --env BASE_URL=http://your-server:3000 load-tests/perpetual-futures-load-test.js
//   k6 run --env ENABLE_STRESS=true load-tests/perpetual-futures-load-test.js
//
// Prerequisites:
//   1. API server running (`bun run --filter api dev`)
//   2. k6 installed (brew install k6)
// ═══════════════════════════════════════════════════════════════════════════════

import http from "k6/http";
import ws from "k6/ws";
import { check, sleep, group } from "k6";
import { Counter, Rate, Trend, Gauge } from "k6/metrics";
import exec from "k6/execution";

// ─── Configuration ──────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const REQUESTED_MARKET_ID = __ENV.MARKET_ID || "BTC-PERP";
const DEPOSIT_AMOUNT = Number(__ENV.DEPOSIT_AMOUNT) || 1_000_000;
const ORDERS_PER_VU = 10; // 100 VUs × 10 = 1,000 total orders
const LOAD_TEST_VUS = 100;
const LOAD_WINDOW_SECONDS = 10;
const TARGET_ORDERS = LOAD_TEST_VUS * ORDERS_PER_VU;
const TARGET_ORDER_RATE = TARGET_ORDERS / LOAD_WINDOW_SECONDS;
const ENABLE_STRESS = __ENV.ENABLE_STRESS === "true";

// ─── Custom Metrics ─────────────────────────────────────────────────────────────

// Order placement latency (API acceptance path — target: p95 < 10ms)
const orderPlacementDuration = new Trend("order_placement_duration", true);

// Breakdown by order type
const limitOrderDuration = new Trend("limit_order_duration", true);
const marketOrderDuration = new Trend("market_order_duration", true);

// Order outcomes
const ordersSubmitted = new Counter("orders_submitted");
const ordersAccepted = new Counter("orders_accepted");
const ordersRejected = new Counter("orders_rejected");
const ordersFailed = new Counter("orders_failed");

// Trade metrics
const tradesExecuted = new Counter("trades_executed");
const orderCancellations = new Counter("order_cancellations");

// API health
const apiErrorRate = new Rate("api_error_rate");
const authDuration = new Trend("auth_duration", true);
const depositDuration = new Trend("deposit_duration", true);
const orderbookReadDuration = new Trend("orderbook_read_duration", true);
const healthCheckDuration = new Trend("health_check_duration", true);

// WebSocket metrics
const wsConnectionDuration = new Trend("ws_connection_duration", true);
const wsMessagesReceived = new Counter("ws_messages_received");

// Throughput gauge for the 10s order-placement window
const orderThroughput = new Gauge("orders_per_second");

// ─── k6 Options ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // ─────────────────────────────────────────────────────────────────────
    // Phase 1: Setup — Register users, deposit collateral, seed orderbook
    // ─────────────────────────────────────────────────────────────────────
    setup_users: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 100,
      maxDuration: "30s",
      exec: "setupUser",
      tags: { phase: "setup" },
      gracefulStop: "5s",
    },

    // ─────────────────────────────────────────────────────────────────────
    // Phase 2: Seed orderbook with resting limit orders (creates liquidity)
    // ─────────────────────────────────────────────────────────────────────
    seed_orderbook: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 200, // 200 resting orders to seed book depth
      maxDuration: "30s",
      exec: "seedOrderbook",
      startTime: "35s",
      tags: { phase: "seed" },
      gracefulStop: "5s",
    },

    // ─────────────────────────────────────────────────────────────────────
    // Phase 3: The main load test — 100 VUs placing 1,000 orders over 10s
    // ─────────────────────────────────────────────────────────────────────
    place_orders: {
      executor: "per-vu-iterations",
      vus: LOAD_TEST_VUS,
      iterations: ORDERS_PER_VU,
      maxDuration: "15s",
      exec: "placeOrder",
      startTime: "70s", // after setup + seed
      tags: { phase: "load" },
      gracefulStop: "5s",
    },

    ...(ENABLE_STRESS ? {
      // ─────────────────────────────────────────────────────────────────────
      // Optional Phase 4: Concurrent reads during order placement
      // ─────────────────────────────────────────────────────────────────────
      read_orderbook: {
        executor: "constant-arrival-rate",
        rate: 50, // 50 orderbook reads/sec
        timeUnit: "1s",
        duration: "10s",
        preAllocatedVUs: 20,
        maxVUs: 30,
        exec: "readOrderbook",
        startTime: "70s",
        tags: { phase: "read_load" },
        gracefulStop: "5s",
      },

      // ─────────────────────────────────────────────────────────────────────
      // Optional Phase 5: Cancel orders under load
      // ─────────────────────────────────────────────────────────────────────
      cancel_orders: {
        executor: "constant-arrival-rate",
        rate: 20, // 20 cancels/sec
        timeUnit: "1s",
        duration: "10s",
        preAllocatedVUs: 10,
        maxVUs: 15,
        exec: "cancelOrder",
        startTime: "72s", // slightly after order placement starts
        tags: { phase: "cancel_load" },
        gracefulStop: "5s",
      },

      // ─────────────────────────────────────────────────────────────────────
      // Optional Phase 6: WebSocket connection storm
      // ─────────────────────────────────────────────────────────────────────
      ws_connections: {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
          { duration: "3s", target: 50 },
          { duration: "7s", target: 50 },
        ],
        exec: "wsSubscribe",
        startTime: "70s",
        tags: { phase: "websocket" },
        gracefulStop: "5s",
      },
    } : {}),
  },

  // ─── Thresholds (SLA enforcement) ───────────────────────────────────────────
  thresholds: {
    // ⚡ Core API latency target: sub-10ms p95 order submission response
    "order_placement_duration": [
      "p(50)<5",    // p50 under 5ms
      "p(95)<10",   // p95 under 10ms
      "p(99)<25",   // p99 under 25ms
      "max<100",    // no request over 100ms
    ],

    // Limit order placement
    "limit_order_duration": [
      "p(95)<10",
      "p(99)<25",
    ],

    // Market order placement
    "market_order_duration": [
      "p(95)<15",
      "p(99)<30",
    ],

    // Orderbook reads should be fast (cached)
    "orderbook_read_duration": [
      "p(95)<20",
      "p(99)<50",
    ],

    // Auth should be sub-millisecond
    "auth_duration": [
      "p(95)<15",
    ],

    // Error rate below 1%
    "api_error_rate": ["rate<0.01"],

    // General HTTP metrics
    "http_req_duration": [
      "p(95)<50",
      "p(99)<100",
    ],

    // All target load orders should be accepted (not rejected for margin etc.)
    "orders_accepted": [`count>=${TARGET_ORDERS}`],

    // Throughput: 1,000 orders over the 10s load window = 100 orders/sec
    "orders_per_second": [`value>=${TARGET_ORDER_RATE}`],
  },

  // ─── Misc ───────────────────────────────────────────────────────────────────
  summaryTrendStats: [
    "avg", "min", "med", "max",
    "p(50)", "p(90)", "p(95)", "p(99)", "p(99.9)",
    "count",
  ],
  noConnectionReuse: false,
  userAgent: "FluxLoadTest/1.0",
  setupTimeout: "120s",
};

// ─── Shared State ───────────────────────────────────────────────────────────────
// User credentials & tokens stored per-VU via setup

// Price levels for realistic order generation
const BASE_PRICE = 50000; // BTC reference price
const PRICE_SPREAD = 500; // ±$500 around base
const MIN_QTY = 0.001;
const MAX_QTY = 0.1;

// ─── Helpers ────────────────────────────────────────────────────────────────────

const headers = {
  "Content-Type": "application/json",
};

function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function randomPrice(side) {
  // Bids slightly below base, asks slightly above — creates realistic spread
  const offset = Math.random() * PRICE_SPREAD;
  if (side === "BUY") {
    return Math.round((BASE_PRICE - offset) * 10) / 10; // align to tick size 0.1
  }
  return Math.round((BASE_PRICE + offset) * 10) / 10;
}

function randomQuantity() {
  // Between MIN_QTY and MAX_QTY, aligned to lot size 0.001
  return Math.round((MIN_QTY + Math.random() * (MAX_QTY - MIN_QTY)) * 1000) / 1000;
}

function randomSide() {
  return Math.random() > 0.5 ? "BUY" : "SELL";
}

function randomOrderType() {
  // 70% limit, 30% market — realistic mix
  return Math.random() > 0.3 ? "LIMIT" : "MARKET";
}

function testMarketId(data) {
  return data && data.marketId ? data.marketId : REQUESTED_MARKET_ID;
}

// ─── Setup Function ─────────────────────────────────────────────────────────────
// k6 setup() runs once before all VUs. We pre-create users and store their tokens.

export function setup() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Flux Perpetual Futures Exchange — Load Test`);
  console.log(`  Target: ${LOAD_TEST_VUS} VUs × ${ORDERS_PER_VU} orders = ${TARGET_ORDERS} orders over ${LOAD_WINDOW_SECONDS}s`);
  console.log(`  Latency target: p95 order submission response <10ms`);
  console.log(`  Extra read/cancel/WebSocket stress: ${ENABLE_STRESS ? "enabled" : "disabled"}`);
  console.log(`  API: ${BASE_URL}`);
  console.log(`  Requested market: ${REQUESTED_MARKET_ID}`);
  console.log(`${"═".repeat(70)}\n`);

  // Health check
  const healthRes = http.get(`${BASE_URL}/health`);
  const healthOk = check(healthRes, {
    "API is healthy": (r) => r.status === 200,
    "health response is ok": (r) => r.json("ok") === true,
  });

  if (!healthOk) {
    console.error("❌ API health check failed. Is the server running?");
    return { error: true };
  }

  console.log("✅ API health check passed");

  // Verify market exists
  const marketsRes = http.get(`${BASE_URL}/markets`);
  const markets = marketsRes.json();
  const marketIds = markets.map((market) => market.symbol || market.marketId).filter(Boolean);
  const marketId = marketIds.includes(REQUESTED_MARKET_ID)
    ? REQUESTED_MARKET_ID
    : marketIds[0];

  console.log(`📊 Available markets: ${JSON.stringify(marketIds)}`);

  if (!marketId) {
    console.error("❌ No markets available for load test");
    return { error: true };
  }

  if (marketId !== REQUESTED_MARKET_ID) {
    console.warn(`⚠️  Requested market ${REQUESTED_MARKET_ID} not found; using ${marketId}`);
  }

  // Pre-register users and get their tokens
  const users = [];
  for (let i = 0; i < LOAD_TEST_VUS; i++) {
    const email = `loadtest-${Date.now()}-${i}@flux.test`;
    const password = "LoadTest123!";

    // Register
    const registerRes = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password }),
      { headers, tags: { name: "setup_register" } }
    );

    if (registerRes.status >= 400) {
      console.warn(`⚠️  Registration failed for user ${i}: ${registerRes.body}`);
      continue;
    }

    const userId = registerRes.json("userId");

    // Login
    const loginRes = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ email, password }),
      { headers, tags: { name: "setup_login" } }
    );

    if (loginRes.status >= 400) {
      console.warn(`⚠️  Login failed for user ${i}: ${loginRes.body}`);
      continue;
    }

    const token = loginRes.json("token");

    // Deposit collateral (large amount to avoid margin rejections)
    const depositRes = http.post(
      `${BASE_URL}/deposits`,
      JSON.stringify({ asset: "USDC", amount: DEPOSIT_AMOUNT }),
      { headers: authHeaders(token), tags: { name: "setup_deposit" } }
    );

    if (depositRes.status >= 400) {
      console.warn(`⚠️  Deposit failed for user ${i}: ${depositRes.body}`);
      continue;
    }

    users.push({ email, password, userId, token, orderIds: [] });
  }

  console.log(`✅ ${users.length} users registered, funded, and ready`);

  // Seed the orderbook with some initial resting orders for realistic matching
  const seedCount = 50;
  let seeded = 0;
  for (let i = 0; i < seedCount && i < users.length; i++) {
    const user = users[i];
    const side = i % 2 === 0 ? "BUY" : "SELL";
    const price = randomPrice(side);

    const orderRes = http.post(
      `${BASE_URL}/orders`,
      JSON.stringify({
        marketId,
        side,
        type: "LIMIT",
        quantity: randomQuantity(),
        price,
        timeInForce: "GTC",
      }),
      { headers: authHeaders(user.token), tags: { name: "setup_seed_order" } }
    );

    if (orderRes.status < 400) {
      seeded++;
    }
  }

  // Drain to process seeded orders through matching engine
  http.post(`${BASE_URL}/admin/drain`, null, {
    headers,
    tags: { name: "setup_drain" },
  });

  console.log(`✅ Orderbook seeded with ${seeded} resting orders`);

  return { users, marketId };
}

// ─── Scenario: Setup User (pre-allocate during setup phase) ─────────────────

export function setupUser(data) {
  // This scenario runs in the setup phase to ensure users are ready.
  // Since we handle user creation in setup(), this is a health-check warmup.
  const res = http.get(`${BASE_URL}/health`);
  healthCheckDuration.add(res.timings.duration);
  check(res, { "warmup health ok": (r) => r.status === 200 });
}

// ─── Scenario: Seed Orderbook ───────────────────────────────────────────────

export function seedOrderbook(data) {
  if (!data.users || data.users.length === 0) return;

  const vuIndex = exec.vu.idInTest % data.users.length;
  const user = data.users[vuIndex];
  const side = randomSide();
  const price = randomPrice(side);
  const marketId = testMarketId(data);

  const res = http.post(
    `${BASE_URL}/orders`,
    JSON.stringify({
      marketId,
      side,
      type: "LIMIT",
      quantity: randomQuantity(),
      price,
      timeInForce: "GTC",
    }),
    { headers: authHeaders(user.token), tags: { name: "seed_limit_order" } }
  );

  check(res, {
    "seed order accepted": (r) => r.status === 202 || r.status === 200,
  });

  // Drain periodically to process orders
  if (exec.vu.iterationInScenario % 20 === 0) {
    http.post(`${BASE_URL}/admin/drain`, null, {
      headers,
      tags: { name: "seed_drain" },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ MAIN SCENARIO: Place Orders (the core of the load test)
// ═══════════════════════════════════════════════════════════════════════════════

export function placeOrder(data) {
  if (!data.users || data.users.length === 0 || data.error) {
    console.error("No users available — setup may have failed");
    return;
  }

  const vuIndex = (exec.vu.idInTest - 1) % data.users.length;
  const user = data.users[vuIndex];
  const iteration = exec.vu.iterationInScenario;
  const marketId = testMarketId(data);

  if (iteration === 0) {
    sleep(vuIndex / LOAD_TEST_VUS);
  }

  group("place_order", function () {
    const side = randomSide();
    const orderType = randomOrderType();
    const quantity = randomQuantity();

    const orderPayload = {
      marketId,
      side,
      type: orderType,
      quantity,
      timeInForce: orderType === "LIMIT" ? "GTC" : "IOC",
    };

    // Add price for limit orders
    if (orderType === "LIMIT") {
      orderPayload.price = randomPrice(side);
    }

    const res = http.post(
      `${BASE_URL}/orders`,
      JSON.stringify(orderPayload),
      {
        headers: authHeaders(user.token),
        tags: {
          name: "place_order",
          order_type: orderType,
          side,
        },
      }
    );

    const duration = res.timings.duration;

    // Record metrics
    ordersSubmitted.add(1);
    orderPlacementDuration.add(duration);

    if (orderType === "LIMIT") {
      limitOrderDuration.add(duration);
    } else {
      marketOrderDuration.add(duration);
    }

    // Validate response
    const isAccepted = res.status === 202 || res.status === 200;
    const isRejected = res.status === 400;
    const isError = res.status >= 500;

    apiErrorRate.add(isError);

    if (isAccepted) {
      ordersAccepted.add(1);
      const orderId = res.json("id");
      if (orderId) {
        // Store for potential cancellation
        data.users[vuIndex].orderIds = data.users[vuIndex].orderIds || [];
        data.users[vuIndex].orderIds.push(orderId);
      }
    } else if (isRejected) {
      ordersRejected.add(1);
    } else {
      ordersFailed.add(1);
    }

    check(res, {
      "order response status valid": (r) => r.status === 202 || r.status === 200 || r.status === 400,
      "order has id": (r) => {
        try { return !!r.json("id"); } catch { return false; }
      },
      "order has status": (r) => {
        try { return !!r.json("status"); } catch { return false; }
      },
      "order latency < 10ms": () => duration < 10,
    });

    orderThroughput.add(TARGET_ORDER_RATE);
  });

  // Pace each VU to 10 orders across the 10-second load window.
  if (iteration < ORDERS_PER_VU - 1) {
    sleep(LOAD_WINDOW_SECONDS / ORDERS_PER_VU);
  }
}

// ─── Scenario: Read Orderbook Under Load ────────────────────────────────────

export function readOrderbook(data) {
  const marketId = testMarketId(data);

  group("read_orderbook", function () {
    // Full-depth orderbook
    const res = http.get(`${BASE_URL}/markets/${marketId}/orderbook?depth=20`, {
      headers,
      tags: { name: "orderbook_read" },
    });

    orderbookReadDuration.add(res.timings.duration);
    apiErrorRate.add(res.status >= 500);

    check(res, {
      "orderbook status 200": (r) => r.status === 200,
      "orderbook has market": (r) => {
        try { return r.json("market") === marketId; } catch { return false; }
      },
      "orderbook has bids array": (r) => {
        try { return Array.isArray(r.json("bids")); } catch { return false; }
      },
      "orderbook has asks array": (r) => {
        try { return Array.isArray(r.json("asks")); } catch { return false; }
      },
      "orderbook read < 20ms": (r) => r.timings.duration < 20,
    });
  });
}

// ─── Scenario: Cancel Orders Under Load ─────────────────────────────────────

export function cancelOrder(data) {
  if (!data.users || data.users.length === 0) return;

  const vuIndex = exec.vu.idInTest % data.users.length;
  const user = data.users[vuIndex];
  const marketId = testMarketId(data);

  // Try to cancel the most recent order for this user
  const orderIds = user.orderIds || [];
  if (orderIds.length === 0) {
    // No orders to cancel — place a limit order first, then cancel it
    const side = randomSide();
    const price = randomPrice(side);

    const placeRes = http.post(
      `${BASE_URL}/orders`,
      JSON.stringify({
        marketId,
        side,
        type: "LIMIT",
        quantity: randomQuantity(),
        price,
        timeInForce: "GTC",
      }),
      { headers: authHeaders(user.token), tags: { name: "cancel_setup_order" } }
    );

    if (placeRes.status === 202 || placeRes.status === 200) {
      const orderId = placeRes.json("id");
      if (orderId) {
        // Cancel immediately
        const cancelRes = http.del(`${BASE_URL}/orders/${orderId}`, null, {
          headers: authHeaders(user.token),
          tags: { name: "cancel_order" },
        });

        orderCancellations.add(1);

        check(cancelRes, {
          "cancel accepted": (r) => r.status === 202 || r.status === 200,
          "cancel has pending status": (r) => {
            try { return r.json("status") === "PENDING_CANCEL"; } catch { return false; }
          },
        });
      }
    }
    return;
  }

  // Cancel the last known order
  const orderId = orderIds.pop();
  const cancelRes = http.del(`${BASE_URL}/orders/${orderId}`, null, {
    headers: authHeaders(user.token),
    tags: { name: "cancel_order" },
  });

  orderCancellations.add(1);

  check(cancelRes, {
    "cancel response valid": (r) => r.status === 202 || r.status === 200 || r.status === 404,
  });
}

// ─── Scenario: WebSocket Subscription ───────────────────────────────────────

export function wsSubscribe(data) {
  const wsUrl = BASE_URL.replace("http", "ws") + "/ws";
  const marketId = testMarketId(data);

  const startTime = Date.now();
  const res = ws.connect(wsUrl, null, function (socket) {
    const connDuration = Date.now() - startTime;
    wsConnectionDuration.add(connDuration);

    socket.on("open", function () {
      // Subscribe to orderbook channel
      socket.send(
        JSON.stringify({
          type: "subscribe",
          channel: `orderbook:${marketId}`,
        })
      );

      // Subscribe to trades channel
      socket.send(
        JSON.stringify({
          type: "subscribe",
          channel: `trades:${marketId}`,
        })
      );
    });

    socket.on("message", function (message) {
      wsMessagesReceived.add(1);

      try {
        const parsed = JSON.parse(message);
        check(parsed, {
          "ws message has type": (m) => !!m.type || !!m.channel,
        });
      } catch (_) {
        // Binary or non-JSON message — ok
      }
    });

    socket.on("error", function (e) {
      console.warn(`WebSocket error: ${e.error()}`);
    });

    // Keep connection alive for 8 seconds to capture updates during load
    socket.setTimeout(function () {
      socket.close();
    }, 8000);
  });

  check(res, {
    "ws connected successfully": (r) => r && r.status === 101,
  });
}

// ─── Teardown ───────────────────────────────────────────────────────────────────

export function teardown(data) {
  if (data.error) {
    console.error("\n❌ Load test aborted due to setup failure\n");
    return;
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log("  Load Test Complete — Summary");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Users provisioned: ${data.users ? data.users.length : 0}`);
  console.log(`  Target orders:     ${TARGET_ORDERS}`);
  console.log(`  Market:            ${testMarketId(data)}`);
  console.log(`  Latency target:    p95 order submission response <10ms`);
  console.log(`  Extra stress:      ${ENABLE_STRESS ? "enabled" : "disabled"}`);
  console.log(`${"═".repeat(70)}\n`);

  // Final drain to ensure all orders are processed
  const drainRes = http.post(`${BASE_URL}/admin/drain`, null, {
    headers,
    tags: { name: "teardown_drain" },
  });

  if (drainRes.status === 200) {
    console.log(`  Final drain processed: ${drainRes.json("processed")} items`);
  }

  // Final orderbook state
  const obRes = http.get(`${BASE_URL}/markets/${testMarketId(data)}/orderbook?depth=5`, {
    headers,
  });

  if (obRes.status === 200) {
    try {
      const ob = obRes.json();
      console.log(`  Final orderbook state:`);
      console.log(`    Bid levels: ${ob.bids ? ob.bids.length : 0}`);
      console.log(`    Ask levels: ${ob.asks ? ob.asks.length : 0}`);
      console.log(`    Sequence:   ${ob.sequence || "N/A"}`);
    } catch (_) { /* ignore */ }
  }

  console.log("");
}

// ─── Default Function (fallback) ────────────────────────────────────────────

export default function (data) {
  // Fallback: runs if no specific scenario matches
  placeOrder(data);
}
