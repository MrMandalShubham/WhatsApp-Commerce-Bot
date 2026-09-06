import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

const prisma = new PrismaClient();

/** Same argon2id parameters the API uses to verify. */
const hashPassword = (pw: string): Promise<string> =>
  hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

const SEED_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "changeme123";

async function main(): Promise<void> {
  // --- staff ---------------------------------------------------------------
  const owner = await prisma.staffUser.upsert({
    where: { email: "owner@shop.local" },
    update: {},
    create: {
      email: "owner@shop.local",
      name: "Shop Owner",
      passwordHash: await hashPassword(SEED_PASSWORD),
      role: "OWNER",
    },
  });

  // --- categories and products --------------------------------------------
  const groceries = await prisma.category.upsert({
    where: { slug: "groceries" },
    update: {},
    create: { name: "Groceries", slug: "groceries", sortOrder: 1 },
  });

  const snacks = await prisma.category.upsert({
    where: { slug: "snacks" },
    update: {},
    create: { name: "Snacks", slug: "snacks", sortOrder: 2 },
  });

  const products = [
    {
      sku: "GRC-ATTA-5KG",
      title: "Whole Wheat Atta 5 kg",
      categoryId: groceries.id,
      hsnCode: "1101",
      gstRate: "5.00",
      priceMinor: 27500, // Rs 275.00
    },
    {
      sku: "GRC-RICE-5KG",
      title: "Basmati Rice 5 kg",
      categoryId: groceries.id,
      hsnCode: "1006",
      gstRate: "5.00",
      priceMinor: 62000,
    },
    {
      sku: "GRC-OIL-1L",
      title: "Sunflower Oil 1 L",
      categoryId: groceries.id,
      hsnCode: "1512",
      gstRate: "5.00",
      priceMinor: 15500,
    },
    {
      sku: "SNK-BISC-200G",
      title: "Marie Biscuits 200 g",
      categoryId: snacks.id,
      hsnCode: "1905",
      gstRate: "18.00",
      priceMinor: 4000,
    },
    {
      sku: "SNK-CHIPS-100G",
      title: "Potato Chips 100 g",
      categoryId: snacks.id,
      hsnCode: "2005",
      gstRate: "12.00",
      priceMinor: 3000,
    },
  ];

  for (const p of products) {
    const product = await prisma.product.upsert({
      where: { sku: p.sku },
      update: {},
      create: { ...p, currency: "INR" },
    });

    const stock = await prisma.inventory.findFirst({
      where: { productId: product.id, variantId: null },
      select: { id: true },
    });
    if (!stock) {
      await prisma.inventory.create({
        data: { productId: product.id, onHand: 100, reserved: 0 },
      });
    }
  }

  // --- rider ---------------------------------------------------------------
  // Riders sign in through the same staff auth, with the RIDER role.
  const riderUser = await prisma.staffUser.upsert({
    where: { email: "rider@shop.local" },
    update: {},
    create: {
      email: "rider@shop.local",
      name: "Test Rider",
      passwordHash: await hashPassword(SEED_PASSWORD),
      role: "RIDER",
    },
  });

  await prisma.rider.upsert({
    where: { phone: "+919000000001" },
    update: { staffUserId: riderUser.id },
    create: {
      name: "Test Rider",
      phone: "+919000000001",
      vehicleType: "bike",
      staffUserId: riderUser.id,
      cashCeilingMinor: 1000000, // Rs 10,000 in hand before COD is blocked
    },
  });

  // --- message templates ---------------------------------------------------
  const templates = [
    "order_confirmation",
    "payment_reminder",
    "payment_received",
    "order_packed",
    "out_for_delivery",
    "order_delivered",
    "delivery_failed",
    "order_cancelled",
    "refund_processed",
  ];
  for (const name of templates) {
    await prisma.messageTemplate.upsert({
      where: { name_language: { name, language: "en" } },
      update: {},
      create: { name, language: "en", category: "UTILITY", status: "DRAFT" },
    });
  }

  // --- service area --------------------------------------------------------
  // Raw SQL: the polygon column is a PostGIS type Prisma cannot write directly.
  // Rough box around central Bengaluru - replace with the real boundary.
  const existing = await prisma.serviceArea.findFirst({
    where: { name: "Zone 1 - Central" },
  });
  if (!existing) {
    const area = await prisma.serviceArea.create({
      data: {
        name: "Zone 1 - Central",
        codAllowed: true,
        codMaxOrderMinor: 500000, // Rs 5,000 COD ceiling
        deliveryFeeMinor: 3000, // Rs 30
        minOrderValueMinor: 20000, // Rs 200
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE service_areas
         SET polygon = ST_GeogFromText(
           'SRID=4326;POLYGON((77.55 12.93, 77.65 12.93, 77.65 13.02, 77.55 13.02, 77.55 12.93))'
         )
       WHERE id = $1`,
      area.id,
    );
  }

  console.log(
    `seeded: staff=${owner.email} (password: ${SEED_PASSWORD}) products=${products.length} templates=${templates.length}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
