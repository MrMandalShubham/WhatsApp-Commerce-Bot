import type { OutboundMessage } from "./messages";
import { markAsRead } from "./messages";
import { WhatsAppSendError, type SendResult, type WhatsAppProvider } from "./types";

export interface CloudApiConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
}

/** Meta error codes that are worth retrying rather than dead-lettering. */
const RETRYABLE_CODES = new Set([
  1,   // unknown/api error
  2,   // service temporarily unavailable
  4,   // application request limit reached
  80007, // rate limit
  130429, // throughput limit
  131000, // generic internal error
  131056, // pair rate limit
]);

export class CloudApiProvider implements WhatsAppProvider {
  private readonly url: string;

  constructor(private readonly cfg: CloudApiConfig) {
    const base = cfg.baseUrl ?? "https://graph.facebook.com";
    const version = cfg.apiVersion ?? "v21.0";
    this.url = `${base}/${version}/${cfg.phoneNumberId}/messages`;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    });

    const body = (await res.json().catch(() => ({}))) as CloudApiResponse;

    if (!res.ok) {
      const code = body?.error?.code;
      throw new WhatsAppSendError(
        body?.error?.message ?? `WhatsApp send failed with ${res.status}`,
        res.status,
        code,
        // 5xx and known transient codes are worth another attempt; a 400 for a
        // malformed template is not - retrying just burns the queue.
        res.status >= 500 || (code !== undefined && RETRYABLE_CODES.has(code)),
      );
    }

    return { providerMessageId: body?.messages?.[0]?.id ?? null, stubbed: false };
  }

  async markRead(providerMessageId: string): Promise<void> {
    await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(markAsRead(providerMessageId)),
    }).catch(() => undefined); // best effort - never fail a job over a read receipt
  }
}

/**
 * Used when no access token is configured. Logs what would have been sent and
 * returns a synthetic id, so the whole conversation flow can be developed and
 * tested before the Meta account exists.
 */
export class StubProvider implements WhatsAppProvider {
  private counter = 0;

  constructor(private readonly sink: (m: OutboundMessage) => void = defaultSink) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sink(message);
    this.counter += 1;
    return { providerMessageId: `stub.${Date.now()}.${this.counter}`, stubbed: true };
  }

  async markRead(): Promise<void> {
    /* no-op */
  }
}

function defaultSink(m: OutboundMessage): void {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), msg: "whatsapp.stub.send", payload: m }),
  );
}

export function createProvider(cfg: Partial<CloudApiConfig>): WhatsAppProvider {
  if (cfg.accessToken && cfg.phoneNumberId) {
    return new CloudApiProvider(cfg as CloudApiConfig);
  }
  console.warn(
    "[whatsapp] no access token configured - using StubProvider (messages are logged, not sent)",
  );
  return new StubProvider();
}

interface CloudApiResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string; code?: number; error_subcode?: number };
}
