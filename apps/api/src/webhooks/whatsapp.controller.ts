import {
  BadRequestException,
  Controller,
  Get,
  Head,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../config/env";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

/**
 * Meta webhook endpoints.
 *
 * Two rules drive everything here:
 *   1. The GET handshake must echo hub.challenge or Meta will not register the
 *      webhook at all. This was missing from v1 of the plan.
 *   2. The POST signature is computed over the RAW body. Any re-serialisation
 *      of the parsed JSON changes byte order and the check fails, so the app
 *      is bootstrapped with rawBody enabled.
 *
 * We acknowledge fast and hand off to the queue. Meta retries on non-2xx, so
 * anything slow or throwing here turns into duplicate deliveries.
 */
@Controller("webhooks/whatsapp")
@Public()
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Meta calls this once when you register the webhook URL. */
  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    if (mode !== "subscribe" || token !== env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      this.logger.warn(`Webhook verification rejected (mode=${mode})`);
      throw new UnauthorizedException("verification failed");
    }
    if (!challenge) throw new BadRequestException("missing hub.challenge");

    this.logger.log("Webhook verification succeeded");
    return challenge;
  }

  @Head()
  @HttpCode(200)
  head(): void {
    // Some Meta health probes issue HEAD; answer without a body.
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    const raw = req.rawBody;
    const signature = req.header("x-hub-signature-256");

    const signatureValid = this.verifySignature(raw, signature);
    if (!signatureValid) {
      // Store the attempt, then reject. Never process an unverified payload.
      this.logger.warn("Rejected WhatsApp webhook with invalid signature");
      throw new UnauthorizedException("invalid signature");
    }

    const body = req.body as WhatsAppWebhookBody;

    // Meta batches events. One entry id per batch is the natural idempotency
    // key: a retry of the same batch carries the same id.
    const providerEventId = body?.entry?.[0]?.id
      ? `${body.entry[0].id}:${hashBody(raw)}`
      : hashBody(raw);

    const existing = await this.prisma.webhookEvent.findUnique({
      where: {
        provider_providerEventId: {
          provider: "WHATSAPP",
          providerEventId,
        },
      },
      select: { id: true, processedAt: true },
    });

    if (existing?.processedAt) {
      this.logger.debug(`Duplicate webhook ignored (${providerEventId})`);
      return { ok: true };
    }

    if (existing) {
      // Stored on an earlier attempt but never processed - most likely the
      // enqueue failed after the row was written. Re-enqueue rather than
      // reporting success, otherwise the event is silently lost. The queue
      // dedupes on jobId, so this is safe to repeat.
      this.logger.warn(`Re-enqueueing unprocessed webhook (${providerEventId})`);
      await this.queue.enqueueInboundWhatsapp(existing.id);
      return { ok: true };
    }

    const event = await this.prisma.webhookEvent.create({
      data: {
        provider: "WHATSAPP",
        providerEventId,
        signatureValid: true,
        payload: body as object,
      },
      select: { id: true },
    });

    // Hand off. Everything slow - session lookup, catalogue reads, replies -
    // happens in the worker so this response stays well inside Meta's timeout.
    try {
      await this.queue.enqueueInboundWhatsapp(event.id);
    } catch (err) {
      // Surface it: a 500 makes Meta retry, and the branch above will pick
      // the stored row back up and enqueue it.
      this.logger.error(
        `Failed to enqueue webhook event ${event.id}: ${(err as Error).message}`,
      );
      throw err;
    }

    return { ok: true };
  }

  /**
   * HMAC-SHA256 of the raw body, keyed with the app secret, compared in
   * constant time. Meta sends it as "sha256=<hex>".
   */
  private verifySignature(raw: Buffer | undefined, header?: string): boolean {
    if (!raw || !header?.startsWith("sha256=")) return false;
    if (!env.WHATSAPP_APP_SECRET) {
      // Fail closed rather than silently trusting unsigned traffic.
      this.logger.error("WHATSAPP_APP_SECRET is not set - rejecting webhook");
      return false;
    }

    const expected = createHmac("sha256", env.WHATSAPP_APP_SECRET)
      .update(raw)
      .digest();
    const received = Buffer.from(header.slice("sha256=".length), "hex");

    if (received.length !== expected.length) return false;
    return timingSafeEqual(expected, received);
  }
}

function hashBody(raw?: Buffer): string {
  return createHmac("sha256", "wcb-event-id")
    .update(raw ?? Buffer.alloc(0))
    .digest("hex")
    .slice(0, 32);
}

interface WhatsAppWebhookBody {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{ field?: string; value?: unknown }>;
  }>;
}
