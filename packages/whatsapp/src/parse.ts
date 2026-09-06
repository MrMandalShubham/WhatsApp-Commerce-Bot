import type { InboundMessage } from "./types";

/**
 * Flattens Meta's nested webhook payload into something the flow router can
 * use. Interactive replies arrive in two different shapes (button_reply vs
 * list_reply) and both are normalised to replyId + text.
 */
export function parseInbound(payload: unknown): {
  messages: InboundMessage[];
  statuses: Array<{ id: string; status: string; errorCode?: string; errorTitle?: string }>;
} {
  const value = (payload as WaPayload)?.entry?.[0]?.changes?.[0]?.value;
  const profileName = value?.contacts?.[0]?.profile?.name;

  const messages: InboundMessage[] = (value?.messages ?? []).flatMap((m) => {
    if (!m.from) return [];
    const base: InboundMessage = {
      providerMessageId: m.id ?? `${m.from}:${m.timestamp ?? Date.now()}`,
      from: m.from,
      timestamp: m.timestamp
        ? new Date(Number(m.timestamp) * 1000)
        : new Date(),
      type: m.type ?? "unknown",
      profileName,
    };

    switch (m.type) {
      case "text":
        return [{ ...base, text: m.text?.body }];
      case "interactive": {
        const i = m.interactive;
        const reply = i?.button_reply ?? i?.list_reply;
        return [{ ...base, replyId: reply?.id, text: reply?.title }];
      }
      case "button":
        // Quick-reply on a template.
        return [{ ...base, replyId: m.button?.payload, text: m.button?.text }];
      case "location":
        return [
          {
            ...base,
            location: m.location
              ? {
                  latitude: m.location.latitude,
                  longitude: m.location.longitude,
                  name: m.location.name,
                  address: m.location.address,
                }
              : undefined,
          },
        ];
      default:
        return [base];
    }
  });

  const statuses = (value?.statuses ?? []).flatMap((s) =>
    s.id && s.status
      ? [
          {
            id: s.id,
            status: s.status,
            errorCode: s.errors?.[0]?.code?.toString(),
            errorTitle: s.errors?.[0]?.title,
          },
        ]
      : [],
  );

  return { messages, statuses };
}

interface WaPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string } }>;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          interactive?: {
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
          button?: { payload?: string; text?: string };
          location?: {
            latitude: number;
            longitude: number;
            name?: string;
            address?: string;
          };
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          errors?: Array<{ code?: number; title?: string }>;
        }>;
      };
    }>;
  }>;
}
