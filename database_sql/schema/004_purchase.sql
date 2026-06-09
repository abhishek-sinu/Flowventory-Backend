-- Flowventory schema migration 004: Purchase (bills, bill items, payment out)

CREATE TABLE IF NOT EXISTS purchase_invoices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    bill_no VARCHAR(50) NOT NULL,
    party_id BIGINT UNSIGNED NOT NULL,
    bill_date DATE NOT NULL,
    due_date DATE NULL,
    place_of_supply VARCHAR(80) NULL,
    subtotal DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    header_discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    taxable_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    cgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    sgst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    igst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    round_off DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    paid_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    balance_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    status ENUM('draft', 'confirmed', 'partially_paid', 'paid', 'cancelled') NOT NULL DEFAULT 'draft',
    notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_purchase_invoices_bill_no (bill_no),
    KEY idx_purchase_invoices_party (party_id),
    KEY idx_purchase_invoices_date (bill_date),
    KEY idx_purchase_invoices_status (status),
    CONSTRAINT fk_purchase_invoices_party
        FOREIGN KEY (party_id) REFERENCES parties(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    purchase_invoice_id BIGINT UNSIGNED NOT NULL,
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
    KEY idx_purchase_items_invoice (purchase_invoice_id),
    KEY idx_purchase_items_item (item_id),
    CONSTRAINT fk_purchase_items_invoice
        FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id)
        ON UPDATE CASCADE
        ON DELETE CASCADE,
    CONSTRAINT fk_purchase_items_item
        FOREIGN KEY (item_id) REFERENCES items(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_out (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    payment_no VARCHAR(50) NOT NULL,
    party_id BIGINT UNSIGNED NOT NULL,
    purchase_invoice_id BIGINT UNSIGNED NULL,
    payment_date DATE NOT NULL,
    amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    payment_mode ENUM('cash', 'bank', 'upi', 'card', 'cheque', 'other') NOT NULL DEFAULT 'cash',
    reference_no VARCHAR(80) NULL,
    notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_out_payment_no (payment_no),
    KEY idx_payment_out_party (party_id),
    KEY idx_payment_out_invoice (purchase_invoice_id),
    KEY idx_payment_out_date (payment_date),
    CONSTRAINT fk_payment_out_party
        FOREIGN KEY (party_id) REFERENCES parties(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT fk_payment_out_invoice
        FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
