-- Flowventory schema migration 009: Header-level (invoice-wide) discount
-- Adds a dedicated header_discount_amount column to the shared sales_invoices and
-- purchase_invoices tables so the header discount can be round-tripped exactly on
-- edit (the existing discount_amount column stores line + header discount combined).

-- sales_invoices (covers SINV-, CN-, EST-, DC- prefixes)
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'sales_invoices'
      AND column_name = 'header_discount_amount'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE sales_invoices ADD COLUMN header_discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER discount_amount',
    'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- purchase_invoices (covers PINV-, DN- prefixes)
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'purchase_invoices'
      AND column_name = 'header_discount_amount'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE purchase_invoices ADD COLUMN header_discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER discount_amount',
    'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
