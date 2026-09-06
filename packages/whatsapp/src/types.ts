import type { OutboundMessage } from "./messages";

export interface SendResult {
  providerMessageId: string | null;
  /** True when the message was logged locally rather than sent to Meta. */
  stubbed: boolean;
}

/**
 * No business logic imports a vendor SDK directly. Swapping the Cloud API for
 * a BSP means writing one more implementation of this, nothing else.
 */
export interface WhatsAppProvider {
  send(message: OutboundMessage): Promise<SendResult>;
  markRead(providerMessageId: string): Promise<void>;
}

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

/** Normalised inbound message, independent of Meta's payload shape. */
export interface InboundMessage {
  providerMessageId: string;
  from: string;
  timestamp: Date;
  type: string;
  /** Free text, or the title of the button/row the customer tapped. */
  text?: string;
  /** id of the tapped reply button or list row. */
  replyId?: string;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  profileName?: string;
}
