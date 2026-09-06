import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import {
  displayStatus, etaMinutes, haversineMetres, isPositionStale,
  type FulfillmentStatus, type OrderStatus, type PaymentStatus,
} from "@wcb/core";

import { Public } from "../auth/public.decorator";
import { PositionService } from "../common/position.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Public tracking page data.
 *
 * Token-scoped, expiring, and revoked the moment the order closes. Nothing
 * here exposes an order id, a rider id, or a raw phone number - the URL is
 * shared over WhatsApp and must not become a handle on the rest of the system.
 */
@Public()
@Controller("track")
export class TrackingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly positions: PositionService,
  ) {}

  @Get(":token")
  async track(@Param("token") token: string) {
    const link = await this.prisma.trackingLink.findUnique({
      where: { token },
      include: {
        order: {
          include: {
            address: { select: { latitude: true, longitude: true, landmark: true } },
            delivery: { include: { rider: { select: { id: true, name: true } } } },
          },
        },
      },
    });

    if (!link) throw new NotFoundException("tracking link not found");
    if (link.revokedAt || link.expiresAt < new Date()) {
      throw new NotFoundException("this tracking link has expired");
    }

    await this.prisma.trackingLink.update({
      where: { id: link.id },
      data: { viewCount: { increment: 1 } },
    });

    const order = link.order;
    const rider = order.delivery?.rider ?? null;
    const position = rider ? await this.positions.get(rider.id) : null;

    let eta: number | null = null;
    let stale = true;
    if (position) {
      stale = isPositionStale(new Date(position.at));
      if (order.address?.latitude != null && order.address.longitude != null) {
        const metres = haversineMetres(
          { lat: position.lat, lng: position.lng },
          { lat: Number(order.address.latitude), lng: Number(order.address.longitude) },
        );
        eta = etaMinutes(metres);
      }
    }

    return {
      orderNumber: order.orderNumber,
      status: displayStatus(
        order.paymentStatus as PaymentStatus,
        order.fulfillmentStatus as FulfillmentStatus,
        order.orderStatus as OrderStatus,
      ),
      totalMinor: order.totalMinor,
      rider: rider ? { name: rider.name } : null,
      destination: order.address?.latitude != null
        ? {
            latitude: Number(order.address.latitude),
            longitude: Number(order.address.longitude),
            landmark: order.address.landmark,
          }
        : null,
      // A stale fix is returned with its timestamp rather than dropped, so the
      // page can say "last seen 4 minutes ago" instead of drawing a ghost.
      riderPosition: position
        ? { latitude: position.lat, longitude: position.lng, at: position.at, stale }
        : null,
      etaMinutes: stale ? null : eta,
    };
  }
}
