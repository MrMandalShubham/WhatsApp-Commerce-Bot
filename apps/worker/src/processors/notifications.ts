import type { PrismaClient } from "@prisma/client";
import {
  renderDelivered,
  renderDeliveryFailed,
  renderOutForDelivery,
  renderPacked,
  etaMinutes,
  haversineMetres,
} from "@wcb/core";
import { templateMessage, textMessage, type WhatsAppProvider } from "@wcb/whatsapp";
import IORedis from "ioredis";

const TRACK_BASE = process.env.TRACKING_PUBLIC_URL ?? "http://localhost:3000/track";

/** Which approved template backs each fulfilment event. */
const TEMPLATES: Record<string, string> = {
  PACKED: "order_packed",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "order_delivered",
  FAILED_DELIVERY: "delivery_failed",
};

/**
 * Sends a status update to the customer.
 *
 * This is the one place the 24-hour service window really bites: a fulfilment
 * update almost always fires long after the customer last messaged us, so the
 * free-form path is usually closed and an approved template is the only way
 * through. We check the window ourselves rather than discovering it as a
 * provider error, and we refuse to send a template that is not APPROVED.
 */
export async function processOrderNotification(
  prisma: PrismaClient,
  whatsapp: WhatsAppProvider,
  redis: IORedis,
  orderId: string,
  event: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { id: true, waPhone: true } },
      address: { select: { latitude: true, longitude: true } },
      delivery: { include: { rider: { select: { id: true, name: true } } } },
      codCollection: true,
    },
  });
  if (!order) return;

  const session = await prisma.whatsappSession.findUnique({
    where: { customerId: order.customer.id },
    select: { windowExpiresAt: true },
  });
  const windowOpen =
    session?.windowExpiresAt != null && session.windowExpiresAt > new Date();

  const body = await renderBody(prisma, order, redis, event);
  if (!body) return;

  const templateName = TEMPLATES[event];

  // Outside the window only an approved template may be sent.
  if (!windowOpen) {
    if (!templateName) {
      log("notify.skipped_no_template", { orderNumber: order.orderNumber, event });
      return;
    }
    const template = await prisma.messageTemplate.findFirst({
      where: { name: templateName, language: "en" },
      select: { status: true },
    });
    if (template?.status !== "APPROVED") {
      // Refusing here is deliberate: sending an unapproved template is a
      // provider rejection and a mark against the number's quality rating.
      log("notify.template_not_approved", {
        orderNumber: order.orderNumber,
        template: templateName,
        status: template?.status ?? "MISSING",
      });
      await prisma.whatsappMessage.create({
        data: {
          customerId: order.customer.id,
          direction: "OUTBOUND",
          type: "template",
          templateName,
          payload: { event, blocked: "template not approved" },
          status: "FAILED",
          errorCode: "TEMPLATE_NOT_APPROVED",
          errorMessage: `template ${templateName} is ${template?.status ?? "missing"}`,
        },
      });
      return;
    }
  }

  const message = windowOpen
    ? textMessage(order.customer.waPhone, body)
    : templateMessage(order.customer.waPhone, templateName, "en", [order.orderNumber]);

  const sent = await whatsapp.send(message);
  await prisma.whatsappMessage.create({
    data: {
      customerId: order.customer.id,
      direction: "OUTBOUND",
      providerMessageId: sent.providerMessageId,
      type: windowOpen ? "text" : "template",
      templateName: windowOpen ? null : templateName,
      payload: message as object,
      status: sent.stubbed ? "QUEUED" : "SENT",
      sentAt: new Date(),
    },
  });

  log("notify.sent", {
    orderNumber: order.orderNumber,
    event,
    channel: windowOpen ? "free-form" : `template:${templateName}`,
  });
}

type OrderWithRelations = NonNullable<
  Awaited<ReturnType<PrismaClient["order"]["findUnique"]>>
> & {
  orderNumber: string;
  address?: { latitude: unknown; longitude: unknown } | null;
  delivery?: { rider?: { id: string; name: string } | null } | null;
  codCollection?: { amountCollectedMinor: number } | null;
};

async function renderBody(
  prisma: PrismaClient,
  order: OrderWithRelations,
  redis: IORedis,
  event: string,
): Promise<string | null> {
  switch (event) {
    case "PACKED":
      return renderPacked(order.orderNumber);

    case "OUT_FOR_DELIVERY": {
      const rider = order.delivery?.rider;
      const link = await currentTrackingUrl(prisma, order.id);
      let eta: number | null = null;

      if (rider && order.address?.latitude != null) {
        const raw = await redis.get(`rider:pos:${rider.id}`);
        if (raw) {
          try {
            const pos = JSON.parse(raw) as { lat: number; lng: number };
            eta = etaMinutes(
              haversineMetres(
                { lat: pos.lat, lng: pos.lng },
                {
                  lat: Number(order.address.latitude),
                  lng: Number(order.address.longitude),
                },
              ),
            );
          } catch {
            eta = null;
          }
        }
      }

      return renderOutForDelivery({
        orderNumber: order.orderNumber,
        riderName: rider?.name ?? "Our rider",
        etaMinutes: eta,
        trackingUrl: link ?? TRACK_BASE,
      });
    }

    case "DELIVERED":
      return renderDelivered(order.orderNumber, order.codCollection?.amountCollectedMinor);

    case "FAILED_DELIVERY":
      return renderDeliveryFailed(order.orderNumber, null);

    default:
      return null;
  }
}

/** The live, unrevoked tracking link for this order, if the trip has started. */
async function currentTrackingUrl(
  prisma: PrismaClient,
  orderId: string,
): Promise<string | null> {
  const link = await prisma.trackingLink.findFirst({
    where: { orderId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { token: true },
  });
  return link ? `${TRACK_BASE}/${link.token}` : null;
}

function log(msg: string, extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}
