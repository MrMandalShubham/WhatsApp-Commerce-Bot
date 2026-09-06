import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __wcbPrisma: PrismaClient | undefined;
}

/** Single client per process; survives hot reload in development. */
export const prisma =
  globalThis.__wcbPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalThis.__wcbPrisma = prisma;
