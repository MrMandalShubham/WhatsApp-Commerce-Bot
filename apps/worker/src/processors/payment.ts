import type { PrismaClient } from "@prisma/client";
import { renderPaymentReceived, computeTotals } from "@wcb/core";
import type { PaymentProvider } from "@wcb/payments";
import type { WhatsAppProvider } from "@wcb/whatsapp";
import { textMessage } from "@wcb/whatsapp";

import { transitionOrder } from "../flow/orders";

/**
 * Reconciles a gateway callback against the order.
 *
 * Three rules the plan insists on, enforced here:
 *   - only a verified callback moves an order to paid
 *   - the amount is checked against what we asked for, so a tampered or
 *     partial payment does not confirm an order
 *   - every state change goes through the guarded transition + history
 */
export async function processPaymentEvent(
  prisma: PrismaClient,
  payments: PaymentProvider,
  whatsapp: WhatsAppProvider,
  webhookEventId: string,
): Promise<void> {
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event) throw new Error(`webhook event ${webhookEventId} not found`);
  if (event.processedAt) return;

  const parsed = payments.parseWebhook(event.payload);

  const done = (note?: string) =>
    prisma.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date(), attempts: { increment: 1 }, error: note },
    });

  if (parsed.kind === "unknown") {
    // Razorpay sends events we do not subscribe to logic for. Acknowledge and
    // move on rather than retrying forever.
    await done("unhandled event kind");
    return;
  }

  const order = parsed.referenceId
    ? await prisma.order.findUnique({
        where: { orderNumber: parsed.referenceId },
        include: { customer: { select: { waPhone: true } }, items: true },
      })
    : null;

  if (!order) {
    log("payment.order_not_found", { referenceId: parsed.referenceId, kind: parsed.kind });
    await done("order not found for reference_id");
    return;
  }

  const payment = await prisma.payment.findFirst({
    where: {
      orderId: order.id,
      ...(parsed.providerLinkId ? { providerLinkId: parsed.providerLinkId } : {}),
    },
    orderBy: { attemptNo: "desc" },
  });

  if (parsed.kind === "paid") {
    // Never confirm on an amount that does not match what we billed.
    if (parsed.amountMinor != null && parsed.amountMinor !== order.totalMinor) {
      log("payment.amount_mismatch", {
        orderNumber: order.orderNumber,
        expected: order.totalMinor,
        received: parsed.amountMinor,
      });
      await prisma.auditLog.create({
        data: {
          actorType: "PROVIDER",
          action: "payment.amount_mismatch",
          targetType: "order",
          targetId: order.id,
          before: { expectedMinor: order.totalMinor },
          after: { receivedMinor: parsed.amountMinor },
          reason: "callback amount did not match order total",
        },
      });
      await done("amount mismatch - held for manual review");
      return;
    }

    if (order.paymentStatus === "PAID") {
      await done("already paid");
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "PAID",
            providerPaymentId: parsed.providerPaymentId,
            rawCallback: event.payload as object,
          },
        });
      }
      await transitionOrder(
        tx, order.id,
        { payment: "PAID", fulfillment: "CONFIRMED", order: "CONFIRMED" },
        { actorType: "PROVIDER", reason: `gateway callback ${parsed.eventId ?? ""}`.trim() },
      );
    });

    const totals = computeTotals(
      order.items.map((i) => ({
        title: i.titleSnapshot,
        unitPriceMinor: i.unitPriceMinor,
        quantity: i.quantity,
        gstRatePercent: Number(i.gstRate),
      })),
      order.deliveryFeeMinor,
    );

    // Every outbound send is tracked to a delivery outcome, including ones
    // triggered by a provider callback rather than by the customer.
    const outbound = textMessage(
      order.customer.waPhone,
      renderPaymentReceived(order.orderNumber, totals),
    );
    const sent = await whatsapp.send(outbound);
    await prisma.whatsappMessage.create({
      data: {
        customerId: order.customerId,
        direction: "OUTBOUND",
        providerMessageId: sent.providerMessageId,
        type: "text",
        payload: outbound as object,
        status: sent.stubbed ? "QUEUED" : "SENT",
        sentAt: new Date(),
      },
    });

    log("payment.confirmed", { orderNumber: order.orderNumber, amountMinor: order.totalMinor });
    await done();
    return;
  }

  if (parsed.kind === "failed" || parsed.kind === "expired") {
    const to = parsed.kind === "failed" ? "FAILED" : "EXPIRED";
    await prisma.$transaction(async (tx) => {
      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: to, rawCallback: event.payload as object },
        });
      }
      // A paid order must never be walked backwards by a late failure event,
      // so the guard is allowed to reject this.
      await transitionOrder(
        tx, order.id, { payment: to },
        { actorType: "PROVIDER", reason: `gateway ${parsed.kind}` },
      ).catch((err) => log("payment.transition_rejected", { error: (err as Error).message }));
    });
    await done();
    return;
  }

  await done("no handler for event kind");
}

function log(msg: string, extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}
