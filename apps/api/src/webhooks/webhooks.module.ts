import { Module } from "@nestjs/common";

import { PaymentWebhookController } from "./payment.controller";
import { WhatsappWebhookController } from "./whatsapp.controller";

@Module({ controllers: [WhatsappWebhookController, PaymentWebhookController] })
export class WebhooksModule {}
