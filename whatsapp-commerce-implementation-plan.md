# WhatsApp Commerce Bot Implementation Plan

## Project Objective
Build a WhatsApp-first ordering system for a retail shop where customers can browse products, select items, place orders, choose online payment or cash on delivery, and receive delivery tracking updates inside WhatsApp wherever possible.[cite:8][cite:10][cite:15]

The practical delivery model is not a pure “all features live natively inside chat” system. The recommended approach is a WhatsApp-first commerce flow backed by a custom order management backend, payment-link integration, and courier tracking updates pushed back into WhatsApp through templates and webhook-driven events.[cite:10][cite:12][cite:15][cite:19]

## Target Customer Journey
The customer journey should be designed as a low-friction conversational commerce flow:[cite:8][cite:17][cite:19]

1. Customer starts a conversation with the business on WhatsApp.[cite:17]
2. Customer sees products using WhatsApp catalog, list messages, buttons, or guided flow steps.[cite:8][cite:12][cite:19]
3. Customer selects items and confirms quantity, address, and contact details.[cite:12][cite:17]
4. Customer chooses COD or online payment.[cite:19]
5. If online payment is chosen, the system sends a secure payment link; if COD is chosen, the order is placed directly.[cite:12][cite:18][cite:19]
6. The backend creates the order, reserves stock, and triggers order confirmation.[cite:10][cite:15]
7. Once shipped, the customer receives status updates such as packed, shipped, out for delivery, and delivered via WhatsApp messages.[cite:10][cite:14][cite:16]

## Product Scope
The first production version should include the following capabilities:[cite:10][cite:17][cite:21]

- Product catalog browsing in WhatsApp.[cite:8][cite:19]
- Cart or order-intent capture through interactive chat flows.[cite:8][cite:12]
- Customer profile capture, including mobile number, name, address, and notes.[cite:12][cite:17]
- Payment choice: COD or online payment link.[cite:18][cite:19]
- Order management and fulfillment tracking in a backend panel.[cite:10][cite:21]
- WhatsApp notifications for confirmation, shipping, delivery, and exceptions.[cite:10][cite:14][cite:16]
- Basic support functions such as order lookup, order status, and escalation to human staff.[cite:10][cite:15]

The first version should not attempt advanced AI-driven free-form ordering. Structured menus and guided order flows are safer, faster to deliver, easier to test, and more reliable for real customer operations.[cite:12][cite:17]

## Platform Reality and Constraints
WhatsApp Business Platform supports catalog-based commerce interactions and webhook-driven event handling, which makes conversational ordering feasible.[cite:8][cite:11][cite:15] However, payment handling often still relies on external payment links or region-specific support rather than a universally available native in-chat payment experience.[cite:12][cite:18][cite:20]

Delivery tracking should be implemented as order-status notifications and tracking-link sharing in WhatsApp. A full live courier tracking map entirely inside the chat experience should not be promised unless the chosen logistics partner explicitly supports an embeddable or WhatsApp-native capability.[cite:10][cite:14][cite:16]

## Recommended Architecture
The system should be implemented as a modular commerce platform with WhatsApp as the primary customer-facing interface.[cite:15][cite:17][cite:21]

### Core Components
| Component | Responsibility |
|---|---|
| WhatsApp Business Platform | Customer messaging, catalog display, interactive replies, template messaging, webhook events.[cite:8][cite:15] |
| Commerce Backend | Product data, cart logic, order creation, payment mode handling, stock checks, status updates.[cite:17][cite:19] |
| Payment Service | Payment link creation, callback verification, payment status reconciliation.[cite:12][cite:18][cite:22] |
| Logistics Service | Shipment booking, AWB/tracking storage, delivery status synchronization.[cite:10][cite:14] |
| Admin Panel | Product management, order dashboard, fulfillment actions, support overrides.[cite:10][cite:21] |
| Database | Products, inventory, customers, addresses, orders, order items, payments, shipments, event logs. |

### Suggested Technology Stack
This stack is suitable for a production-grade build with clean separation of concerns and phased delivery, which aligns with a modular and scalable implementation approach.[cite:1][cite:2]

- Backend: Node.js with NestJS or Express.
- Database: PostgreSQL.
- ORM: Prisma or Drizzle.
- Queue: BullMQ or a similar job queue for retryable events.
- Admin Panel: Next.js web app.
- Hosting: DigitalOcean, AWS, or another VPS/cloud platform.
- WhatsApp integration: WhatsApp Business Cloud API.[cite:15]
- Payments for India: Razorpay, PayU, or another payment-link provider compatible with business requirements.[cite:18]
- Logistics: Shiprocket, Delhivery, or another courier API depending on client geography and delivery partner.
- Observability: structured logs, order event audit table, webhook failure tracking.

## Functional Modules

### 1. WhatsApp Interaction Layer
This layer handles inbound and outbound messages, customer state, and menu progression.[cite:15][cite:17]

Functions:
- Receive inbound customer messages through webhook subscriptions.[cite:11][cite:15]
- Map user replies to product browsing, cart updates, address capture, and order placement.[cite:8][cite:12]
- Send approved template messages for utility notifications like order confirmation or shipment updates.[cite:10][cite:15]
- Route unsupported or ambiguous cases to a human operator.

### 2. Product Catalog Layer
This module manages catalog synchronization between the shop database and WhatsApp-facing product presentation.[cite:8][cite:19]

Functions:
- Create internal product records.
- Map internal products to WhatsApp catalog items.
- Handle stock availability, variant pricing, images, and basic categories.
- Mark out-of-stock products and stop ordering where required.

### 3. Order Management Layer
This is the core transaction engine of the platform.[cite:10][cite:17][cite:21]

Functions:
- Create cart or draft order.
- Validate product, price, quantity, and address.
- Confirm payment mode.
- Generate final order record.
- Change order state through lifecycle stages: pending, awaiting_payment, paid, confirmed, packed, shipped, out_for_delivery, delivered, cancelled, refund_pending, refunded.

### 4. Payment Layer
This module should support at least two payment modes: COD and online payment link.[cite:12][cite:18][cite:19]

Functions:
- Generate payment link against a specific order.
- Capture gateway callback.
- Verify gateway signature.
- Update order payment state.
- Expire unpaid links after a defined time.
- Allow staff to re-send payment links from admin panel.

### 5. Logistics and Tracking Layer
This module connects order fulfillment with customer communication.[cite:10][cite:14][cite:16]

Functions:
- Create shipment after order confirmation.
- Store courier name, shipment ID, AWB, label URL, and tracking URL.
- Poll or receive courier status updates.
- Translate courier statuses into normalized internal order states.
- Send WhatsApp delivery notifications automatically.

### 6. Admin Operations Layer
This is essential for real business delivery and support.[cite:10][cite:21]

Functions:
- Manage products, prices, variants, and inventory.
- View new and active orders.
- Mark orders as packed or shipped.
- Trigger shipment creation.
- Re-send notification templates.
- Search customer by phone number or order ID.
- Override failed statuses manually when needed.

## Data Model
The first version should include the following core tables.

| Table | Purpose |
|---|---|
| products | Product master data, title, SKU, category, price, image, active status. |
| product_variants | Variant-specific pricing and stock, if required. |
| inventory | Current stock and reservation counts. |
| customers | Customer identity mapped by WhatsApp phone number. |
| customer_addresses | Delivery addresses linked to customer. |
| orders | Order header, totals, payment mode, status, timestamps. |
| order_items | Individual product lines for each order. |
| payments | Payment attempts, gateway IDs, status, amount, callback data. |
| shipments | Courier booking and tracking details. |
| whatsapp_sessions | Customer flow state, last step, context snapshot. |
| whatsapp_messages | Inbound and outbound message log with provider IDs. |
| webhook_events | Raw incoming webhook payloads for replay and audit. |
| order_status_history | Immutable status transition history. |
| staff_users | Admin and operations access control. |

### Important Design Rules
- Keep order status history immutable for auditability.
- Store raw webhook payloads for payment and WhatsApp events for debugging and replay.[cite:11][cite:15]
- Separate shipment status from payment status to avoid mixed logic.
- Normalize external provider states into internal business states.
- Track every outbound WhatsApp template send attempt and delivery outcome when possible.[cite:15]

## API Design
The implementation should expose internal service APIs and webhook endpoints.

### Public or Provider-Facing Endpoints
- `POST /webhooks/whatsapp` — receive WhatsApp webhook events.[cite:11][cite:15]
- `POST /webhooks/payment` — receive payment gateway callbacks.[cite:18]
- `POST /webhooks/logistics` — receive courier status updates.

### Internal or Admin-Facing Endpoints
- `GET /products`
- `POST /products`
- `PATCH /products/:id`
- `GET /orders`
- `GET /orders/:id`
- `POST /orders/:id/send-payment-link`
- `POST /orders/:id/create-shipment`
- `POST /orders/:id/change-status`
- `GET /customers/:phone`
- `GET /reports/orders`

## WhatsApp Conversation Design
A guided conversation is recommended over open text entry.[cite:12][cite:17]

### Main Flow
1. Greeting.
2. Browse categories.
3. View products.
4. Select quantity.
5. Confirm cart.
6. Capture address.
7. Choose payment mode.
8. Confirm order.
9. Send payment link if needed.
10. Send order confirmation.

### Post-Order Flow
- Customer sends “track order”.
- System asks for order ID or identifies recent order by phone.
- System returns current status and tracking link if shipment exists.[cite:10][cite:14]

### Human Handover Conditions
- Product not found.
- Custom pricing request.
- Address validation failure.
- Payment mismatch.
- Customer complaint or return request.
- Multiple failed attempts in one conversation.

## Payment Strategy
For launch, the safest and most practical approach is hybrid payment support:[cite:12][cite:18][cite:19]

- COD for customers who prefer low-friction checkout.
- Online payment link for prepaid orders.
- Optional future support for native payment experiences if fully supported in the target business region and approved for the client account.[cite:18][cite:20]

### Payment Rules
- COD may be restricted by order amount, PIN code, or product type.
- Payment links should expire automatically.
- Orders should not move to paid state without verified callback or admin approval.
- Payment retries should create a new payment attempt record, not overwrite old data.

## Delivery and Tracking Strategy
Delivery status must be event-driven and customer-visible through WhatsApp updates.[cite:10][cite:14][cite:16]

Recommended normalized statuses:
- order_received
- payment_pending
- payment_confirmed
- order_confirmed
- packed
- shipped
- out_for_delivery
- delivered
- failed_delivery
- returned
- cancelled

Each normalized status can optionally trigger a WhatsApp utility template, subject to template approval and business communication rules.[cite:10][cite:15]

## Non-Functional Requirements
The project is business-critical, so non-functional requirements must be treated as part of the core scope.

### Reliability
- Webhook idempotency for all providers.
- Retry queues for transient failures.
- Dead-letter handling for failed external events.
- Raw event storage for replay.

### Security
- Validate provider signatures on webhooks.[cite:15]
- Role-based admin access.
- Secure storage of API secrets.
- Encrypted transport over HTTPS.
- Audit log for critical actions.

### Scalability
A modular, provider-agnostic design is preferable so payment providers, logistics partners, or conversation logic can evolve without rewriting the whole platform.[cite:1][cite:2]

### Observability
- Structured logs per order and message.
- Dashboard counters for new orders, paid orders, failed payments, shipment delays, and webhook failures.
- Alerting for provider downtime and retry exhaustion.

## Delivery Phases
A phased implementation plan is the safest delivery approach for this project, especially for a client-facing production system.[cite:1][cite:2]

### Phase 0: Discovery and Requirement Freeze
Goals:
- Confirm product catalog structure.
- Confirm delivery geography.
- Confirm COD rules.
- Confirm courier partner.
- Confirm return and cancellation policy.
- Confirm who manages fulfillment in daily operations.

Deliverables:
- Approved business requirements document.
- Final order lifecycle definition.
- Template list for WhatsApp messages.
- Provider shortlist for payment and logistics.

### Phase 1: Foundation Setup
Goals:
- Create repo and environments.
- Set up PostgreSQL schema.
- Set up backend framework.
- Configure admin authentication.
- Connect WhatsApp Business Cloud API sandbox or production account.[cite:15]

Deliverables:
- Running backend skeleton.
- Database migrations.
- Basic admin dashboard shell.
- Webhook endpoints responding correctly.

### Phase 2: Catalog and Customer Flow MVP
Goals:
- Add product management.
- Implement catalog browse flow.
- Store customer context and session state.
- Support draft cart and draft order.

Deliverables:
- Product CRUD.
- WhatsApp guided browse flow.
- Session storage.
- Draft order creation.

### Phase 3: Checkout and Payment MVP
Goals:
- Capture address.
- Add COD option.
- Generate payment links for online orders.
- Verify payment callbacks.

Deliverables:
- Checkout flow.
- Payment attempt records.
- Payment status reconciliation.
- Order confirmation messages.

### Phase 4: Fulfillment and Tracking MVP
Goals:
- Create shipment records.
- Connect logistics provider.
- Normalize delivery statuses.
- Trigger automated customer updates.[cite:10][cite:14]

Deliverables:
- Shipment booking integration.
- Tracking data sync.
- Status automation.
- Delivery update templates.

### Phase 5: Admin Operations Hardening
Goals:
- Improve order dashboard.
- Add search and filtering.
- Add manual override tools.
- Add resend/retry tools.
- Add reporting widgets.

Deliverables:
- Production-ready admin panel.
- Operations controls.
- Basic reports.
- Support tooling.

### Phase 6: QA, UAT, and Go-Live
Goals:
- Run end-to-end testing.
- Validate template flows.
- Validate payment and refund edge cases.
- Perform load and retry testing.
- Train client operations staff.

Deliverables:
- UAT checklist.
- Deployment runbook.
- Incident response notes.
- Go-live signoff.

## Testing Plan
The test plan should cover both business and technical reliability.

### Functional Testing
- Product browse flow.
- Quantity selection.
- Address capture.
- COD order placement.
- Online payment success and failure flows.
- Shipment creation.
- Track-order request flow.
- Delivered notification flow.

### Edge Cases
- Duplicate webhooks.[cite:11][cite:15]
- Expired payment links.[cite:12][cite:19]
- Product goes out of stock during checkout.
- Courier status arrives before payment sync.
- Customer reopens conversation after long inactivity.
- Same number places multiple overlapping orders.

### Operational Testing
- Admin retries failed notifications.
- Manual order correction.
- Payment mismatch handling.
- Support handover from bot to human.

## Project Risks and Mitigation
| Risk | Impact | Mitigation |
|---|---|---|
| WhatsApp template approval delays | Go-live delay | Finalize templates early and submit during foundation phase.[cite:15] |
| Payment integration mismatch | Failed checkouts | Start with payment-link model and test gateway callbacks thoroughly.[cite:12][cite:18] |
| Logistics API inconsistency | Broken tracking updates | Normalize courier states internally and keep manual override in admin.[cite:10][cite:14] |
| Free-text customer behavior | Bot confusion | Use guided interactive flows and human handover paths.[cite:12][cite:17] |
| Duplicate provider events | Duplicate orders or status corruption | Use idempotency keys and raw webhook event tracking.[cite:11][cite:15] |

## Recommended MVP Boundary
The MVP should include only the features required to reliably accept and fulfill real orders through WhatsApp.[cite:10][cite:17]

Included in MVP:
- Guided product browsing.
- Order capture.
- COD.
- Payment link flow.
- Order confirmation.
- Shipment tracking updates.
- Basic admin dashboard.

Excluded from MVP:
- AI recommendation engine.
- Natural-language free-form shopping assistant.
- Loyalty wallet.
- Automated returns engine.
- Multi-vendor marketplace behavior.
- Advanced marketing automation.

## Suggested Repository Structure
```text
whatsapp-commerce-bot/
  apps/
    api/
    admin/
    worker/
  packages/
    core/
    integrations/
      whatsapp/
      payments/
      logistics/
    db/
    shared/
  docs/
  infra/
```

## Final Recommendation
This project should be sold and built as a WhatsApp-first commerce platform rather than a simple chatbot. WhatsApp is the customer interface, but the real success of the system depends on a strong backend for orders, payments, logistics, and operations.[cite:10][cite:15][cite:21]

The fastest route to successful client delivery is a phased rollout: first establish reliable ordering and fulfillment, then layer better automation, reporting, and optional AI enhancements later. This approach matches a modular, scalable delivery style and reduces the risk of overpromising on platform limitations.[cite:1][cite:2][cite:12]
