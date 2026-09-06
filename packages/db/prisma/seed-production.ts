/**
 * Production seed — essentials only.
 *
 * Deliberately does NOT create products, categories, riders or service areas.
 * Those are real business data: a placeholder service area would silently
 * accept orders outside the shop's actual delivery range, and demo products
 * would be visible to real customers on WhatsApp.
 *
 * Refuses to run without an explicit admin password, so a weak default can
 * never reach production by accident.
 *
 *   SEED_ADMIN_EMAIL=owner@shop.com SEED_ADMIN_PASSWORD='...' tsx prisma/seed-production.ts
 */
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const prisma = new PrismaClient();

const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const NAME = process.env.SEED_ADMIN_NAME ?? "Shop Owner";

/** The ten templates the fulfilment flow sends. Each needs Meta approval. */
const TEMPLATES: Array<{ name: string; body: string }> = [
  { name: "order_confirmation", body: "Your order {{1}} is confirmed." },
  { name: "payment_reminder", body: "Your payment link for order {{1}} is still open." },
  { name: "payment_received", body: "We have received your payment for order {{1}}." },
  { name: "order_packed", body: "Order {{1}} is packed and ready." },
  { name: "shipped", body: "Order {{1}} has left the shop." },
  { name: "out_for_delivery", body: "Order {{1}} is out for delivery." },
  { name: "order_delivered", body: "Order {{1}} has been delivered. Thank you!" },
  { name: "delivery_failed", body: "We could not deliver order {{1}} today." },
  { name: "order_cancelled", body: "Order {{1}} has been cancelled." },
  { name: "refund_processed", body: "Your refund for order {{1}} has been processed." },
];

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must both be set. " +
        "Production must not fall back to a default password.",
    );
  }
  if (PASSWORD.length < 12) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 12 characters.");
  }

  const owner = await prisma.staffUser.upsert({
    where: { email: EMAIL.toLowerCase() },
    update: {},
    create: {
      email: EMAIL.toLowerCase(),
      name: NAME,
      passwordHash: await hash(PASSWORD, {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
      role: "OWNER",
    },
  });

  // Registered as DRAFT: the send path refuses anything that is not APPROVED,
  // so these stay inert until Meta approves each one and it is marked here.
  for (const t of TEMPLATES) {
    await prisma.messageTemplate.upsert({
      where: { name_language: { name: t.name, language: "en" } },
      update: {},
      create: {
        name: t.name,
        language: "en",
        category: "UTILITY",
        status: "DRAFT",
        bodyPreview: t.body,
        variables: ["orderNumber"],
      },
    });
  }

  const counts = {
    staff: await prisma.staffUser.count(),
    templates: await prisma.messageTemplate.count(),
    products: await prisma.product.count(),
    serviceAreas: await prisma.serviceArea.count(),
    riders: await prisma.rider.count(),
  };

  console.log(`owner:     ${owner.email} (${owner.role})`);
  console.log(`templates: ${counts.templates} registered as DRAFT`);
  console.log("");
  console.log("Still required before the shop can take an order:");
  if (counts.serviceAreas === 0) {
    console.log("  - a service area polygon (nothing is deliverable without one)");
  }
  if (counts.products === 0) console.log("  - products, added through the admin panel");
  if (counts.riders === 0) console.log("  - at least one rider");
  console.log("  - Meta approval for each template, then mark it APPROVED here");
}

main()
  .catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
