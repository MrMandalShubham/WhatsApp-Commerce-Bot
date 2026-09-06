/**
 * Builders for the Cloud API message payloads we actually send.
 *
 * The platform limits below are not style choices - Meta rejects the send if
 * you exceed them, so they are enforced here rather than discovered in
 * production:
 *   - reply buttons:  max 3, title <= 20 chars
 *   - list rows:      max 10 across all sections, title <= 24, desc <= 72
 *   - body text:      <= 1024 chars
 *   - header text:    <= 60 chars
 */

export const LIMITS = {
  BUTTONS: 3,
  BUTTON_TITLE: 20,
  LIST_ROWS: 10,
  LIST_TITLE: 24,
  LIST_DESCRIPTION: 72,
  BODY: 1024,
  HEADER: 60,
  FOOTER: 60,
} as const;

export type OutboundMessage = Record<string, unknown> & { to: string };

/** Trim to a hard limit, adding an ellipsis when it actually had to cut. */
export function clamp(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function base(to: string): { messaging_product: "whatsapp"; to: string } {
  return { messaging_product: "whatsapp", to };
}

export function textMessage(to: string, body: string, preview = false): OutboundMessage {
  return {
    ...base(to),
    type: "text",
    text: { body: clamp(body, LIMITS.BODY), preview_url: preview },
  };
}

export interface ButtonSpec {
  id: string;
  title: string;
}

export function buttonMessage(
  to: string,
  body: string,
  buttons: ButtonSpec[],
  opts: { header?: string; footer?: string } = {},
): OutboundMessage {
  if (buttons.length === 0 || buttons.length > LIMITS.BUTTONS) {
    throw new RangeError(
      `WhatsApp allows 1-${LIMITS.BUTTONS} reply buttons, got ${buttons.length}`,
    );
  }
  return {
    ...base(to),
    type: "interactive",
    interactive: {
      type: "button",
      ...(opts.header
        ? { header: { type: "text", text: clamp(opts.header, LIMITS.HEADER) } }
        : {}),
      body: { text: clamp(body, LIMITS.BODY) },
      ...(opts.footer
        ? { footer: { text: clamp(opts.footer, LIMITS.FOOTER) } }
        : {}),
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: clamp(b.title, LIMITS.BUTTON_TITLE) },
        })),
      },
    },
  };
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export function listMessage(
  to: string,
  body: string,
  buttonLabel: string,
  sections: ListSection[],
  opts: { header?: string; footer?: string } = {},
): OutboundMessage {
  const rowCount = sections.reduce((n, s) => n + s.rows.length, 0);
  if (rowCount === 0) throw new RangeError("a list message needs at least one row");
  if (rowCount > LIMITS.LIST_ROWS) {
    throw new RangeError(
      `WhatsApp allows at most ${LIMITS.LIST_ROWS} list rows, got ${rowCount}`,
    );
  }
  return {
    ...base(to),
    type: "interactive",
    interactive: {
      type: "list",
      ...(opts.header
        ? { header: { type: "text", text: clamp(opts.header, LIMITS.HEADER) } }
        : {}),
      body: { text: clamp(body, LIMITS.BODY) },
      ...(opts.footer
        ? { footer: { text: clamp(opts.footer, LIMITS.FOOTER) } }
        : {}),
      action: {
        button: clamp(buttonLabel, LIMITS.BUTTON_TITLE),
        sections: sections.map((s) => ({
          title: clamp(s.title, LIMITS.LIST_TITLE),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: clamp(r.title, LIMITS.LIST_TITLE),
            ...(r.description
              ? { description: clamp(r.description, LIMITS.LIST_DESCRIPTION) }
              : {}),
          })),
        })),
      },
    },
  };
}

/**
 * Renders a "Send location" button. The customer taps it, picks a pin, and the
 * webhook returns a `location` message with latitude/longitude.
 */
export function locationRequestMessage(to: string, body: string): OutboundMessage {
  return {
    ...base(to),
    type: "interactive",
    interactive: {
      type: "location_request_message",
      body: { text: clamp(body, LIMITS.BODY) },
      action: { name: "send_location" },
    },
  };
}

/** A static pin we send to the customer - free-form, so window-gated. */
export function locationMessage(
  to: string,
  latitude: number,
  longitude: number,
  name?: string,
  address?: string,
): OutboundMessage {
  return {
    ...base(to),
    type: "location",
    location: { latitude, longitude, ...(name ? { name } : {}), ...(address ? { address } : {}) },
  };
}

export function templateMessage(
  to: string,
  name: string,
  language: string,
  bodyParams: string[] = [],
  buttonUrlParam?: string,
): OutboundMessage {
  const components: unknown[] = [];
  if (bodyParams.length) {
    components.push({
      type: "body",
      parameters: bodyParams.map((t) => ({ type: "text", text: t })),
    });
  }
  if (buttonUrlParam) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: buttonUrlParam }],
    });
  }
  return {
    ...base(to),
    type: "template",
    template: {
      name,
      language: { code: language },
      ...(components.length ? { components } : {}),
    },
  };
}

export function markAsRead(messageId: string): Record<string, unknown> {
  return { messaging_product: "whatsapp", status: "read", message_id: messageId };
}
