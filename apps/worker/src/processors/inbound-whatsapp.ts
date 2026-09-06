import type { PrismaClient } from "@prisma/client";
import { parseInbound, type WhatsAppProvider } from "@wcb/whatsapp";
import type { PaymentProvider } from "@wcb/payments";

import { handleInbound } from "../flow/handler";

/**
 * Turns one stored webhook event into conversation. The API already verified
 * the signature and persisted the raw payload; everything slow happens here.
 */
export async function processInboundWhatsapp(
  prisma: PrismaClient,
  provider: WhatsAppProvider,
  payments: PaymentProvider,
  webhookEventId: string,
): Promise<void> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event) throw new Error(`webhook event ${webhookEventId} not found`);
  if (event.processedAt) return;

  const { messages, statuses } = parseInbound(event.payload);

  for (const message of messages) {
    // Record the inbound message first, so a failure in the flow below still
    // leaves an audit trail of what the customer actually sent.
    const customer = await prisma.customer.findUnique({
      where: { waPhone: message.from },
      select: { id: true },
    });

    await prisma.whatsappMessage.upsert({
      where: { providerMessageId: message.providerMessageId },
      update: {},
      create: {
        customerId: customer?.id ?? null,
        direction: "INBOUND",
        providerMessageId: message.providerMessageId,
        type: message.type,
        payload: message as unknown as object,
        status: "DELIVERED",
      },
    });

    await handleInbound(prisma, provider, payments, message);
    await provider.markRead(message.providerMessageId);
  }

  // Delivery receipts for messages we sent.
  for (const s of statuses) {
    await prisma.whatsappMessage
      .update({
        where: { providerMessageId: s.id },
        data: {
          status: mapStatus(s.status),
          deliveredAt: s.status === "delivered" ? new Date() : undefined,
          readAt: s.status === "read" ? new Date() : undefined,
          errorCode: s.errorCode,
          errorMessage: s.errorTitle,
        },
      })
      .catch(() => undefined); // receipt for a message we never stored
  }

  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { processedAt: new Date(), attempts: { increment: 1 } },
  });
}

function mapStatus(s: string): "SENT" | "DELIVERED" | "READ" | "FAILED" {
  switch (s) {
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return "SENT";
  }
}
