-- Flowventory schema migration 008: Add barcode column to items
-- Code128-friendly alphanumeric barcode, unique when present.

ALTER TABLE items
    ADD COLUMN barcode VARCHAR(64) NULL AFTER sku;

ALTER TABLE items
    ADD UNIQUE KEY uq_items_barcode (barcode);
