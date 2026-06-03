-- Flowventory schema migration 001: Items

CREATE TABLE IF NOT EXISTS items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    sku VARCHAR(80) NOT NULL,
    category VARCHAR(100) NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'pcs',
    hsn_code VARCHAR(20) NULL,
    sale_price DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    purchase_price DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    opening_stock DECIMAL(14,3) NOT NULL DEFAULT 0.000,
    current_stock DECIMAL(14,3) NOT NULL DEFAULT 0.000,
    low_stock_threshold DECIMAL(14,3) NOT NULL DEFAULT 0.000,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_items_sku (sku),
    KEY idx_items_name (name),
    KEY idx_items_category (category),
    KEY idx_items_stock (current_stock, low_stock_threshold)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
