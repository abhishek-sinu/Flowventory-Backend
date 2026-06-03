-- Flowventory schema migration 007: Estimates (quotation documents)

CREATE TABLE IF NOT EXISTS estimate_invoices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    estimate_no VARCHAR(50) NOT NULL,
    party_id BIGINT UNSIGNED NOT NULL,
    estimate_date DATE NOT NULL,
    valid_till DATE NULL,
    place_of_supply VARCHAR(80) NULL,
    subtotal DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    round_off DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    status ENUM('draft', 'sent', 'accepted', 'rejected', 'converted', 'cancelled') NOT NULL DEFAULT 'draft',
    notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_estimate_invoices_no (estimate_no),
    KEY idx_estimate_invoices_party (party_id),
    KEY idx_estimate_invoices_date (estimate_date),
    KEY idx_estimate_invoices_status (status),
    CONSTRAINT fk_estimate_invoices_party
        FOREIGN KEY (party_id) REFERENCES parties(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS estimate_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    estimate_invoice_id BIGINT UNSIGNED NOT NULL,
    item_id BIGINT UNSIGNED NOT NULL,
    item_name VARCHAR(150) NOT NULL,
    hsn_code VARCHAR(20) NULL,
    quantity DECIMAL(14,3) NOT NULL DEFAULT 0.000,
    unit VARCHAR(30) NOT NULL DEFAULT 'pcs',
    rate DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    discount_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    taxable_value DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    line_total DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_estimate_items_invoice (estimate_invoice_id),
    KEY idx_estimate_items_item (item_id),
    CONSTRAINT fk_estimate_items_invoice
        FOREIGN KEY (estimate_invoice_id) REFERENCES estimate_invoices(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    CONSTRAINT fk_estimate_items_item
        FOREIGN KEY (item_id) REFERENCES items(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
