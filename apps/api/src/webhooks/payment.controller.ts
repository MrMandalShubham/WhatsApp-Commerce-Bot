import {
  Controller, HttpCode, Logger, Post, Req, UnauthorizedException,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { createPaymentProvider } from "@wcb/payments";

import { env } from "../config/env";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

/**
 * Razorpay callbacks.
 *
 * A client-side redirect is never proof of payment - only a signature-verified
 * callback, checked against the RAW body, moves an order to paid.
 */
@Public()
@Controller("webhooks/payment")
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);
  private readonly payments = createPaymentProvider({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const signature = req.header("x-razorpay-signature");

    if (!this.payments.verifyWebhook(raw, signature)) {
      this.logger.warn("Rejected payment webhook with invalid signature");
      throw new UnauthorizedException("invalid signature");
    }

    const body = req.body as Record<string, unknown>;
    const parsed = this.payments.parseWebhook(body);

    // Razorpay's own event id is the idempotency key; fall back to a body
    // hash when a provider does not send one.
    const providerEventId =
      parsed.eventId ?? createHash("sha256").update(raw).digest("hex").slice(0, 40);

    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_providerEventId: { provider: "RAZORPAY", providerEventId } },
      select: { id: true, processedAt: true },
    });

    if (existing?.processedAt) return { ok: true };

    if (existing) {
      // Stored earlier but never processed - re-enqueue rather than dropping.
      await this.queue.enqueuePaymentEvent(existing.id);
      return { ok: true };
    }

    const event = await this.prisma.webhookEvent.create({
      data: {
        provider: "RAZORPAY",
        providerEventId,
        signatureValid: true,
        payload: body as object,
      },
      select: { id: true },
    });

    await this.queue.enqueuePaymentEvent(event.id);
    return { ok: true };
  }
}
