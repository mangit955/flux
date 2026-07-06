# Flux Load Tests

Load tests for the Flux Perpetual Futures Exchange, built with [k6](https://k6.io/).

## Target Performance

| Metric | Target |
|---|---|
| Matching hot-path latency | **< 1ms** |
| API Response (p95) | **< 10ms** |
| Throughput | **100+ orders/sec** |
| Users | **100 concurrent** |
| Total Orders | **1,000 in 10s** |
| Error Rate | **< 1%** |

This k6 test measures the HTTP order-submission path: auth, JSON parsing,
margin validation, and enqueueing the order for matching. The `<1ms` target is
for the matching-engine hot path itself; it is not asserted as a per-request
HTTP check.

## Prerequisites

```bash
# Install k6
brew install k6

# Ensure the API server is running
cd .. && bun run --filter api dev
```

## Usage

### Run the full load test

```bash
k6 run perpetual-futures-load-test.js
```

By default this runs the core bet-placement target: 100 users place 1,000
orders over 10 seconds.

### Run with extra stress traffic

```bash
k6 run --env ENABLE_STRESS=true perpetual-futures-load-test.js
```

This adds concurrent orderbook reads, cancellations, and WebSocket connections.
Use it as a heavier mixed-workload test after the core placement test is green.

### Against a specific server

```bash
k6 run --env BASE_URL=http://your-server:3000 perpetual-futures-load-test.js
```

### With custom parameters

```bash
k6 run \
  --env BASE_URL=http://localhost:3000 \
  --env MARKET_ID=BTC-PERP \
  --env DEPOSIT_AMOUNT=1000000 \
  perpetual-futures-load-test.js
```

### Output JSON results

```bash
k6 run --out json=results.json perpetual-futures-load-test.js
```

## Test Phases

The default test runs in 3 sequential phases:

1. **Setup Users** (0–30s) — Register 100 users, deposit USDC collateral
2. **Seed Orderbook** (35–65s) — Place 200 resting limit orders for liquidity
3. **Place Orders** (70–80s) — **100 VUs × 10 orders = 1,000 orders in 10s**

When `ENABLE_STRESS=true`, the test also runs:

4. **Read Orderbook** (70–80s) — 50 orderbook reads/sec concurrent with writes
5. **Cancel Orders** (72–82s) — 20 cancellations/sec under load
6. **WebSocket Storm** (70–80s) — 50 concurrent WebSocket connections

## Key Metrics

| Custom Metric | Description |
|---|---|
| `order_placement_duration` | End-to-end order submission latency |
| `limit_order_duration` | Limit order placement latency |
| `market_order_duration` | Market order placement latency |
| `orderbook_read_duration` | Orderbook query latency |
| `orders_submitted` | Total orders sent |
| `orders_accepted` | Orders with 202/200 status |
| `orders_rejected` | Orders rejected (margin, validation) |
| `trades_executed` | Matched trades from drain |
| `order_cancellations` | Cancel requests sent |
| `ws_messages_received` | WebSocket messages received |

## Thresholds (SLA)

```
order_placement_duration  p50 < 5ms   p95 < 10ms   p99 < 25ms   max < 100ms
limit_order_duration      p95 < 10ms  p99 < 25ms
market_order_duration     p95 < 15ms  p99 < 30ms
orderbook_read_duration   p95 < 20ms  p99 < 50ms
orders_accepted           count >= 1000
orders_per_second         value >= 100
api_error_rate            < 1%
```
