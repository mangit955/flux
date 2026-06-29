#!/usr/bin/env bun
/**
 * Test production order flow: create -> match -> cancel
 */

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const RUNTIME_MODE = "development"; // Force development mode for local testing

if (!DATABASE_URL || !REDIS_URL) {
  console.error("❌ DATABASE_URL and REDIS_URL required");
  process.exit(1);
}

// Force development mode
process.env.RUNTIME_MODE = "development";

const prisma = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Test user ID (create if needed)
const TEST_USER_ID = "test-user-production";
const TEST_MARKET = "BTC-PERP";

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testProductionFlow() {
  console.log("🧪 Testing Order Flow (Local In-Memory Mode)\n");
  console.log("═".repeat(60));
  
  try {
    // 1. Ensure test user exists
    console.log("\n📝 Step 1: Ensuring test user exists...");
    await prisma.user.upsert({
      where: { id: TEST_USER_ID },
      create: {
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        passwordHash: "test-hash",
      },
      update: {},
    });
    console.log(`✅ User ${TEST_USER_ID} ready`);
    
    // 2. Create a BUY order through proper outbox flow
    console.log("\n📝 Step 2: Creating BUY order with outbox event...");
    const buyOrderId = `order-${Date.now()}-buy`;
    const buyCommandId = `cmd-${buyOrderId}`;
    const now = Date.now();
    
    await prisma.$transaction(async (tx) => {
      // Create the order
      await tx.order.create({
        data: {
          id: buyOrderId,
          userId: TEST_USER_ID,
          marketId: TEST_MARKET,
          side: "BUY",
          type: "LIMIT",
          timeInForce: "GTC",
          quantity: "1.0",
          remainingQuantity: "1.0",
          price: "50000.0",
          status: "PENDING",
        },
      });
      
      // Create the outbox event for the order
      await tx.outboxEvent.create({
        data: {
          aggregateType: "order",
          aggregateId: buyOrderId,
          type: "order.created",
          payload: {
            type: "order.created",
            command: {
              commandId: buyCommandId,
              orderId: buyOrderId,
              userId: TEST_USER_ID,
              market: TEST_MARKET,
              side: "buy",
              type: "limit",
              qtyLots: 1.0,
              priceTicks: 50000.0,
              timeInForce: "GTC",
              reduceOnly: false,
              postOnly: false,
              createdAt: now,
            },
          },
          status: "PENDING",
        },
      });
    });
    
    const buyOrder = await prisma.order.findUnique({ where: { id: buyOrderId } });
    console.log(`✅ Created BUY order: ${buyOrder?.id} with outbox event`);
    
    // 3. Wait for outbox publisher to pick it up
    console.log("\n📝 Step 3: Waiting for outbox publisher (5 seconds)...");
    await sleep(5000);
    
    // Check if order moved to OPEN
    const buyOrderAfterOutbox = await prisma.order.findUnique({
      where: { id: buyOrderId },
    });
    console.log(`   Order status: ${buyOrderAfterOutbox?.status}`);
    
    // Check outbox event status
    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: { aggregateId: buyOrderId },
      orderBy: { createdAt: "desc" },
    });
    console.log(`   Outbox event status: ${outboxEvent?.status}`);
    
    // 4. Check Redis streams
    console.log("\n📝 Step 4: Checking Redis streams...");
    const outboxLength = await redis.xlen("order.outbox");
    const commandsLength = await redis.xlen(`engine.commands.${TEST_MARKET}`);
    const eventsLength = await redis.xlen(`engine.events.${TEST_MARKET}`);
    
    console.log(`   order.outbox: ${outboxLength} messages`);
    console.log(`   engine.commands.${TEST_MARKET}: ${commandsLength} messages`);
    console.log(`   engine.events.${TEST_MARKET}: ${eventsLength} messages`);
    
    // 5. Create a matching SELL order with outbox event
    console.log("\n📝 Step 5: Creating SELL order to match...");
    const sellOrderId = `order-${Date.now()}-sell`;
    const sellCommandId = `cmd-${sellOrderId}`;
    const sellNow = Date.now();
    
    await prisma.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          id: sellOrderId,
          userId: TEST_USER_ID,
          marketId: TEST_MARKET,
          side: "SELL",
          type: "LIMIT",
          timeInForce: "GTC",
          quantity: "1.0",
          remainingQuantity: "1.0",
          price: "50000.0",
          status: "PENDING",
        },
      });
      
      await tx.outboxEvent.create({
        data: {
          aggregateType: "order",
          aggregateId: sellOrderId,
          type: "order.created",
          payload: {
            type: "order.created",
            command: {
              commandId: sellCommandId,
              orderId: sellOrderId,
              userId: TEST_USER_ID,
              market: TEST_MARKET,
              side: "sell",
              type: "limit",
              qtyLots: 1.0,
              priceTicks: 50000.0,
              timeInForce: "GTC",
              reduceOnly: false,
              postOnly: false,
              createdAt: sellNow,
            },
          },
          status: "PENDING",
        },
      });
    });
    
    const sellOrder = await prisma.order.findUnique({ where: { id: sellOrderId } });
    console.log(`✅ Created SELL order: ${sellOrder?.id} with outbox event`);
    
    // 6. Wait for matching
    console.log("\n📝 Step 6: Waiting for matching engine (5 seconds)...");
    await sleep(5000);
    
    // Check if orders matched
    const buyOrderAfterMatch = await prisma.order.findUnique({
      where: { id: buyOrderId },
    });
    const sellOrderAfterMatch = await prisma.order.findUnique({
      where: { id: sellOrderId },
    });
    
    console.log(`   BUY order status: ${buyOrderAfterMatch?.status}`);
    console.log(`   SELL order status: ${sellOrderAfterMatch?.status}`);
    
    // Check for fills (trades)
    const fills = await prisma.fill.findMany({
      where: {
        OR: [
          { orderId: buyOrderId },
          { orderId: sellOrderId },
        ],
      },
    });
    console.log(`   Fills created: ${fills.length}`);
    if (fills.length > 0) {
      fills.forEach((f, i) => {
        console.log(`     Fill ${i + 1}: ${f.quantity} @ ${f.price} (${f.liquidityRole})`);
      });
    }
    
    // 7. Test cancellation if order is still open
    if (buyOrderAfterMatch?.status === "OPEN" || buyOrderAfterMatch?.status === "PARTIALLY_FILLED") {
      console.log("\n📝 Step 7: Testing order cancellation...");
      
      // Create cancel command in outbox
      await prisma.outboxEvent.create({
        data: {
          aggregateType: "order",
          aggregateId: buyOrderId,
          type: "order.cancelled",
          payload: {
            type: "order.cancelled",
            command: {
              commandId: `cmd-cancel-${Date.now()}`,
              orderId: buyOrderId,
            },
          },
          status: "PENDING",
        },
      });
      console.log(`   Created cancel command in outbox for order ${buyOrderId}`);
      
      await sleep(5000);
      
      const cancelledOrder = await prisma.order.findUnique({
        where: { id: buyOrderId },
      });
      console.log(`   Final status: ${cancelledOrder?.status}`);
      
      if (cancelledOrder?.status === "CANCELLED") {
        console.log(`   ✅ Order successfully cancelled!`);
      }
    }
    
    // 8. Show summary
    console.log("\n" + "═".repeat(60));
    console.log("\n📊 Test Summary:");
    console.log(`   Orders created: 2`);
    console.log(`   BUY order final status: ${buyOrderAfterMatch?.status}`);
    console.log(`   SELL order final status: ${sellOrderAfterMatch?.status}`);
    console.log(`   Fills executed: ${fills.length}`);
    console.log(`   Redis outbox messages: ${outboxLength}`);
    console.log(`   Redis commands: ${commandsLength}`);
    console.log(`   Redis events: ${eventsLength}`);
    
    if (fills.length > 0) {
      console.log("\n✅ Production order flow is WORKING! 🎉");
    } else if (buyOrderAfterMatch?.status === "OPEN" && sellOrderAfterMatch?.status === "OPEN") {
      console.log("\n⚠️  Orders reached OPEN state but didn't match");
      console.log("   This might indicate matching engine needs debugging");
    } else {
      console.log("\n⚠️  Orders didn't reach matching engine");
      console.log("   Check outbox publisher and worker logs");
    }
    
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
    await redis.quit();
  }
}

testProductionFlow();
