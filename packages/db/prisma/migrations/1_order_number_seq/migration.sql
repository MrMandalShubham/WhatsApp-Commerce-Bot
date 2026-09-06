-- Human-facing order numbers (WCB-000001). A sequence rather than a count,
-- so concurrent checkouts cannot collide on the same number.
CREATE SEQUENCE IF NOT EXISTS order_number_seq START WITH 1 INCREMENT BY 1;
