# Production Monitoring & Maintenance Scripts

This directory contains scripts for monitoring, diagnosing, and fixing production issues with the exchange system.

## Quick Reference

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `bun run diag` | Check system health | Daily or when investigating issues |
| `REDIS_URL="..." bun run cleanup:pel` | Clear stuck Redis messages | When orders/cancels aren't processing |
| `REDIS_URL="..." bun run monitor` | Real-time production monitor | During deployments or incidents |
| `bun run test:cancel <url> <token>` | Test order cancellation | After fixes or deployments |

## Scripts Overview

### 1. System Diagnostics (`diag.ts`)

**Purpose:** Quick snapshot of system health - outbox status and Redis stream metrics.

**Usage:**
```bash
# Local
bun run diag

# Production
DATABASE_URL="..." REDIS_URL="..." bun run diag
```

**What it checks:**
- Outbox event counts (PENDING, FAILED, PUBLISHED)
- Redis stream lengths
- Consumer group status
- Pending Entry List (PEL) size

**Example output:**
```
Outbox Stats: PENDING=0, FAILED=0, PUBLISHED=47
engine.commands.BTC-PERP length: 100
Commands groups: [ "pending", 0 ]  ✅
```

**Red flags:**
- ❌ `PENDING > 10` - OutboxPublisher may be stuck
- ❌ `FAILED > 5` - Check worker error logs
- ❌ `pending > 100` - PEL is building up, run cleanup

---

### 2. PEL Cleanup (`cleanup-pel.ts`)

**Purpose:** Clear stuck messages from Redis Pending Entry List.

**When to use:**
- Order cancellations not working
- Orders not being created
- `diag` shows high pending count (> 100)
- Worker logs show PEL limit errors

**Usage:**
```bash
# Local cleanup
bun run cleanup:pel

# Production cleanup (use production Redis URL)
REDIS_URL="rediss://..." bun run cleanup:pel
```

**What it does:**
1. Claims all pending messages from Redis consumer groups
2. Acknowledges them (removes from PEL)
3. Reports total messages cleaned

**Example output:**
```
🔧 Starting PEL cleanup...
📊 Cleaning up engine.commands.BTC-PERP...
[REDIS] Claimed and acked 1000 stale messages
Batch 1: Cleaned 1000 messages (total: 1000)
...
✅ Cleaned 5378 pending messages from engine.commands.BTC-PERP
```

**⚠️ Safety:** This script is safe to run anytime. It only clears messages that were already read but not acknowledged.

---

### 3. Production Monitor (`monitor-production.ts`)

**Purpose:** Real-time dashboard of system health with auto-refresh.

**When to use:**
- During deployments
- When investigating performance issues
- To watch system recover after cleanup
- For ongoing health monitoring

**Usage:**
```bash
# Production monitoring
REDIS_URL="rediss://..." DATABASE_URL="postgresql://..." bun run monitor
```

**What it shows:**
- Outbox status (live counts)
- Redis stream lengths per market
- Consumer group pending counts
- Overall system health rating
- Actionable recommendations

**Example output:**
```
🔍 Production System Monitor
============================================================
Time: 2026-06-26T12:00:00.000Z

📦 Outbox Status
------------------------------------------------------------
  PENDING:        0 ✅
  FAILED:         0 ✅
  PUBLISHED:     47 ✅

🔴 Redis Streams
------------------------------------------------------------

  BTC-PERP:
    Commands: 100 messages
      Group: matching-engine:BTC-PERP
        Consumers: 1
        Pending:   0 ✅
        Lag:       0
    Events: 50 messages
      Group: persistence-worker
        Pending: 0 ✅

============================================================
✅ System Health: EXCELLENT - All systems operational

Press Ctrl+C to exit
```

**Health ratings:**
- ✅ EXCELLENT - All systems operational
- ⚡ GOOD - Minor backlog, should clear soon  
- ⚠️  DEGRADED - Check worker logs
- 🚨 CRITICAL - Immediate action required

---

### 4. Order Cancellation Test (`test-cancel-flow.ts`)

**Purpose:** End-to-end test of order creation and cancellation.

**When to use:**
- After running PEL cleanup
- After deploying worker changes
- To verify production is working
- For smoke testing

**Usage:**
```bash
# Local
bun run test:cancel http://localhost:3000 "Bearer YOUR_TOKEN"

# Production
bun run test:cancel https://your-api.railway.app "Bearer YOUR_TOKEN"
```

**What it does:**
1. Creates a limit order (buy BTC at $30k - won't fill)
2. Waits 2 seconds
3. Verifies order exists and is OPEN
4. Cancels the order
5. Waits 3 seconds
6. Verifies order status is CANCELLED

**Example output:**
```
🧪 Testing Order Cancellation Flow
API: https://your-api.railway.app

1️⃣  Creating test order...
✅ Order created: ord_abc123
   Status: PENDING

2️⃣  Waiting 2 seconds for order to be processed...

3️⃣  Checking order status...
✅ Order status: OPEN

4️⃣  Cancelling order...
✅ Cancel request accepted: PENDING_CANCEL

5️⃣  Waiting 3 seconds for cancellation to be processed...

6️⃣  Verifying order is cancelled...
   Order status: CANCELLED
✅ SUCCESS! Order was cancelled successfully! 🎉

Summary:
  Order ID: ord_abc123
  Initial Status: OPEN
  Final Status: CANCELLED
  Time taken: ~5 seconds
```

**If it fails:**
1. Run diagnostics: `bun run diag`
2. Check for high PEL: run `bun run cleanup:pel`
3. Verify workers are running: check Railway logs
4. Check worker logs for errors

---

## Troubleshooting Guide

### Problem: Orders won't cancel in production

**Symptoms:**
- DELETE /orders/:id returns 202 but order stays OPEN
- Frontend shows "Cancelling..." forever

**Diagnosis:**
```bash
bun run diag
```

Look for:
- High `pending` count in consumer groups (> 100)
- High `PENDING` in outbox (> 10)

**Fix:**
```bash
# 1. Clean up stuck messages (use production Redis URL)
REDIS_URL="rediss://..." bun run cleanup:pel

# 2. Redeploy workers (Railway)
# Go to Railway → workers service → Deploy → Manual Deploy

# 3. Test cancellation
bun run test:cancel https://your-api.railway.app "Bearer ..."
```

---

### Problem: Orders not being created

**Symptoms:**
- POST /orders returns 201 but order never appears in matching engine
- No trades executing

**Diagnosis:**
```bash
bun run diag
```

Look for:
- High `PENDING` in outbox
- Zero `PUBLISHED` (OutboxPublisher not running)

**Fix:**
```bash
# 1. Check if workers are running
curl https://your-workers.railway.app/health

# 2. Restart workers (Railway)
# 3. Run cleanup if needed
bun run cleanup:prod
```

---

### Problem: PEL keeps growing

**Symptoms:**
- `pending` count increases over time
- Worker logs show "PEL limit hit"

**Diagnosis:**
```bash
bun run monitor
```

Watch the `Pending` count in real-time.

**Root causes:**
1. **Worker errors** - Check Railway logs for exceptions
2. **Worker not running** - Check health endpoint
3. **Database connection issues** - Check DATABASE_URL
4. **Redis connection issues** - Check REDIS_URL

**Fix:**
```bash
# 1. Clean up immediately (use production Redis URL)
REDIS_URL="rediss://..." bun run cleanup:pel

# 2. Fix the root cause
# - Check environment variables
# - Check worker logs for errors
# - Verify database connectivity

# 3. Redeploy workers with fix
```

---

## Maintenance Schedule

### Daily
```bash
# Quick health check
bun run diag
```

### Weekly
```bash
# Full monitoring session
bun run monitor
# Watch for 2-3 minutes, ensure pending stays at 0
```

### After Deployments
```bash
# 1. Monitor during deployment
bun run monitor

# 2. Test cancellation
bun run test:cancel https://your-api.railway.app "Bearer ..."

# 3. Final health check
bun run diag
```

### When Issues Reported
```bash
# 1. Diagnose
bun run diag

# 2. Clean up if needed (use production Redis URL)
REDIS_URL="rediss://..." bun run cleanup:pel

# 3. Monitor recovery
REDIS_URL="..." DATABASE_URL="..." bun run monitor

# 4. Test functionality
bun run test:cancel https://your-api.railway.app "Bearer ..."
```

---

## Environment Variables

All scripts require these variables:

```bash
# Database (required for diag, monitor)
DATABASE_URL="postgresql://user:pass@host/db"

# Redis (required for all scripts)
REDIS_URL="rediss://default:token@host:6379"
```

**Production values:**
```bash
# Upstash Redis
REDIS_URL="rediss://default:gQAAAAAAAUgrAAIgcDIyYTNiZWM2YzgyOWI0MzBhYmY1NGRkZGU5YmZiZWU5MQ@growing-mongoose-84011.upstash.io:6379"

# Neon PostgreSQL
DATABASE_URL="postgresql://neondb_owner:npg_k9q6voIShMFU@ep-rapid-glade-at5no3en-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```

**Security:** Never commit credentials. Use `.env` file or pass directly:
```bash
REDIS_URL="..." bun run cleanup:pel
```

---

## Architecture Context

Understanding the flow helps with troubleshooting:

### Order Creation Flow
```
API → outboxEvent (PENDING)
      ↓ [100ms]
OutboxPublisher → Redis stream
      ↓ [100ms]
MatchingWorker → Process order → ACK
      ↓ [100ms]
PersistenceWorker → Update DB → ACK
```

### Order Cancellation Flow
```
API → outboxEvent (PENDING)
      ↓ [100ms]
OutboxPublisher → Redis stream
      ↓ [100ms]
MatchingWorker → Cancel order → ACK
      ↓ [100ms]
PersistenceWorker → Update DB, unlock margin → ACK
```

**Key insight:** If ANY step fails to ACK, the message stays in PEL and blocks future messages when PEL hits 1000.

---

## Related Documentation

- [CLAUDE.md](../CLAUDE.md) - Architecture, runtime modes, and order flow
- [TODO.md](../TODO.md) - Known issues, including the stream traps referenced above
- [README.md](../README.md) - Setup and verification

---

## Support

If scripts fail or you need help:

1. Check Railway logs for workers
2. Verify environment variables are set correctly
3. Ensure Redis and Database are accessible
4. Review the "Known traps" section of the `streams-diag` skill
   (`.claude/skills/streams-diag/SKILL.md`) — dropped commands, the disabled PEL cleanup stub,
   and the single-matching-worker constraint are the usual causes

**Emergency:** If production is down:
```bash
# 1. Clean PEL immediately
REDIS_URL="..." bun run scripts/cleanup-pel.ts

# 2. Restart workers in Railway

# 3. Monitor recovery
REDIS_URL="..." DATABASE_URL="..." bun run scripts/monitor-production.ts
```
