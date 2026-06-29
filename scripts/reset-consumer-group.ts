#!/usr/bin/env bun
/**
 * Reset consumer group to reprocess all messages
 * This forces the matching engine to re-read and re-process all commands
 */

import RedisClient from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("❌ REDIS_URL required");
  process.exit(1);
}

const redis = new RedisClient(REDIS_URL);

async function resetConsumerGroup() {
  console.log("🔄 Resetting Consumer Group...\n");
  console.log("⚠️  This will reset pending entries and allow reprocessing\n");
  
  const markets = ['BTC-PERP', 'ETH-PERP'];
  
  for (const market of markets) {
    const cmdStream = `engine.commands.${market}`;
    const group = `matching-engine:${market}`;
    
    console.log(`📊 ${market}:`);
    
    // Get current state
    const len = await redis.xlen(cmdStream);
    console.log(`  Stream length: ${len} messages`);
    
    if (len === 0) {
      console.log(`  ✓ No messages, skipping\n`);
      continue;
    }
    
    try {
      // Delete all consumers in the group first
      const consumers = await redis.xinfo("CONSUMERS", cmdStream, group);
      console.log(`  Found ${Math.floor(consumers.length / 8)} consumers in group`);
      
      for (let i = 0; i < consumers.length; i += 8) {
        const consumerName = consumers[i + 1];
        if (consumerName) {
          await redis.xgroup("DELCONSUMER", cmdStream, group, String(consumerName));
          console.log(`  ✅ Deleted consumer: ${consumerName}`);
        }
      }
      
      // Now reset the group's position to 0-0
      await redis.xgroup('SETID', cmdStream, group, '0-0');
      console.log(`  ✅ Reset consumer group position to 0-0`);
      console.log(`  ✓ Consumer group will now read all messages from beginning`);
      
    } catch (error: any) {
      console.error(`  ❌ Error:`, error.message);
    }
    
    console.log('');
  }
  
  console.log("✅ Consumer groups reset!\n");
  console.log("⚠️  IMPORTANT: Now restart the workers");
  console.log("   The workers will reprocess all commands and generate events\n");
  
  redis.quit();
}

resetConsumerGroup().catch((error) => {
  console.error("❌ Failed:", error);
  redis.quit();
  process.exit(1);
});
