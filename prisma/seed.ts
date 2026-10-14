import { PrismaClient, Prisma } from "@prisma/client";
import * as argon2 from "argon2";
import * as crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log("Starting idempotent database seed...");

  // 1. Test User Credentials (Dev only, configurable via env)
  const testEmail = process.env.TEST_USER_EMAIL || "testuser@example.com";
  const testPassword = process.env.TEST_USER_PASSWORD || "DevPassword123!Secure";
  const rawApiKey = process.env.TEST_API_KEY || "smm_test_dev_key_0123456789abcdef";
  const testWebhookSecret =
    process.env.TEST_WEBHOOK_SECRET || "whsec_dev_test_secret_0123456789abcdef";

  // Hash password using Argon2id
  const passwordHash = await argon2.hash(testPassword, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  // Idempotent User Upsert
  const user = await prisma.user.upsert({
    where: { email: testEmail },
    update: {
      passwordHash,
    },
    create: {
      email: testEmail,
      passwordHash,
      balance: new Prisma.Decimal("100.000000"),
      currency: "USD",
    },
  });

  console.log(`✓ Test user verified: ${user.email} (ID: ${user.id})`);

  // Ensure initial seed deposit transaction is recorded
  const initialTx = await prisma.transaction.findFirst({
    where: {
      userId: user.id,
      description: "Initial test seed balance deposit",
    },
  });

  if (!initialTx) {
    await prisma.transaction.create({
      data: {
        userId: user.id,
        amount: new Prisma.Decimal("100.000000"),
        type: "DEPOSIT",
        status: "SUCCESS",
        description: "Initial test seed balance deposit",
      },
    });
    console.log("✓ Recorded initial deposit transaction for test user");
  }

  // 2. Cryptographic API Key Setup (Store SHA-256 hash only)
  const keyHash = crypto.createHash("sha256").update(rawApiKey).digest("hex");
  const keyPrefix = rawApiKey.slice(0, 16) + "...";

  const apiKey = await prisma.apiKey.upsert({
    where: { keyHash },
    update: {
      userId: user.id,
      isActive: true,
    },
    create: {
      userId: user.id,
      keyHash,
      keyPrefix,
      name: "Development Test Key",
      isActive: true,
    },
  });

  console.log(`✓ API key hash registered: ${apiKey.keyPrefix} (Active: ${apiKey.isActive})`);

  // 3. Sample Services (3 distinct catalog offerings)
  const sampleServices = [
    {
      name: "Instagram Followers [High Quality] [Instant]",
      category: "Instagram",
      ratePer1000: new Prisma.Decimal("1.500000"),
      minQuantity: 50,
      maxQuantity: 50000,
      type: "Default",
      description:
        "High quality Instagram followers with instant start and 30-day refill guarantee.",
      supportsDripfeed: true,
      isActive: true,
    },
    {
      name: "YouTube Views [Targeted] [Real Audience]",
      category: "YouTube",
      ratePer1000: new Prisma.Decimal("3.250000"),
      minQuantity: 500,
      maxQuantity: 100000,
      type: "Default",
      description: "Organic high-retention YouTube views. Suitable for monetization.",
      supportsDripfeed: true,
      isActive: true,
    },
    {
      name: "TikTok Likes [Instant] [Non-Drop]",
      category: "TikTok",
      ratePer1000: new Prisma.Decimal("0.850000"),
      minQuantity: 100,
      maxQuantity: 25000,
      type: "Default",
      description: "Ultra-fast TikTok post likes from active accounts.",
      supportsDripfeed: false,
      isActive: true,
    },
  ];

  for (const serviceData of sampleServices) {
    const existing = await prisma.service.findFirst({
      where: {
        name: serviceData.name,
        category: serviceData.category,
      },
    });

    if (existing) {
      await prisma.service.update({
        where: { id: existing.id },
        data: serviceData,
      });
      console.log(`✓ Updated sample service: [${existing.id}] ${existing.name}`);
    } else {
      const created = await prisma.service.create({
        data: serviceData,
      });
      console.log(`✓ Created sample service: [${created.id}] ${created.name}`);
    }
  }

  // 4. Test Webhook Setup
  const testWebhookUrl = "https://webhook.site/smm-test-endpoint";
  const webhookEvents = [
    "order.created",
    "order.processing",
    "order.completed",
    "order.canceled",
    "order.partial",
  ];

  const existingWebhook = await prisma.webhook.findFirst({
    where: {
      userId: user.id,
      url: testWebhookUrl,
    },
  });

  if (existingWebhook) {
    await prisma.webhook.update({
      where: { id: existingWebhook.id },
      data: {
        events: webhookEvents,
        secret: testWebhookSecret,
        isActive: true,
      },
    });
    console.log(`✓ Updated test webhook: ${existingWebhook.url}`);
  } else {
    const createdWebhook = await prisma.webhook.create({
      data: {
        userId: user.id,
        url: testWebhookUrl,
        events: webhookEvents,
        secret: testWebhookSecret,
        isActive: true,
      },
    });
    console.log(`✓ Created test webhook: ${createdWebhook.url} (ID: ${createdWebhook.id})`);
  }

  console.log("\n========================================================");
  console.log("Idempotent Database Seed Complete");
  console.log("========================================================");
  console.log(`Test User Email:     ${testEmail}`);
  console.log(`Test User Password:  ${testPassword}`);
  console.log(`Plaintext API Key:   ${rawApiKey}`);
  console.log(`Test Webhook Secret: ${testWebhookSecret}`);
  console.log("NOTE: Credentials are for local development/testing only.");
  console.log("========================================================\n");
}

main()
  .catch((err) => {
    console.error("Seed execution failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
