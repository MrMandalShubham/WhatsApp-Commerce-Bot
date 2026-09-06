export const QUEUES = {
  INBOUND_WHATSAPP: "inbound-whatsapp",
  OUTBOUND_WHATSAPP: "outbound-whatsapp",
  PAYMENTS: "payments",
  NOTIFICATIONS: "notifications",
  MAINTENANCE: "maintenance",
} as const;

export const JOBS = {
  PROCESS_INBOUND: "process-inbound",
  PROCESS_PAYMENT: "process-payment",
  ORDER_NOTIFICATION: "order-notification",
  SEND_MESSAGE: "send-message",
  SEND_TEMPLATE: "send-template",
  RELEASE_EXPIRED_RESERVATIONS: "release-expired-reservations",
  EXPIRE_ABANDONED_CARTS: "expire-abandoned-carts",
  PURGE_RIDER_PINGS: "purge-rider-pings",
  PURGE_WEBHOOK_EVENTS: "purge-webhook-events",
  REVOKE_STALE_TRACKING_LINKS: "revoke-stale-tracking-links",
} as const;
