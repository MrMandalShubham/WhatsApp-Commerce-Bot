import type { Reply } from "@wcb/core";
import {
  buttonMessage,
  listMessage,
  locationRequestMessage,
  textMessage,
  type OutboundMessage,
} from "@wcb/whatsapp";

/** Translates a channel-agnostic reply into a Cloud API payload. */
export function renderReply(to: string, reply: Reply): OutboundMessage {
  switch (reply.kind) {
    case "text":
      return textMessage(to, reply.text);
    case "buttons":
      return buttonMessage(to, reply.text, reply.buttons, {
        header: reply.header,
        footer: reply.footer,
      });
    case "list":
      return listMessage(to, reply.text, reply.buttonLabel, reply.sections, {
        header: reply.header,
        footer: reply.footer,
      });
    case "location_request":
      return locationRequestMessage(to, reply.text);
  }
}
