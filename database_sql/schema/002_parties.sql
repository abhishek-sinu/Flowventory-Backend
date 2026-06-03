-- Flowventory schema migration 002: Parties (customers/suppliers)

CREATE TABLE IF NOT EXISTS parties (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    party_type ENUM('customer', 'supplier', 'both') NOT NULL DEFAULT 'customer',
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(20) NULL,
    email VARCHAR(150) NULL,
    gstin VARCHAR(20) NULL,
    pan VARCHAR(20) NULL,
    billing_address TEXT NULL,
    shipping_address TEXT NULL,
    city VARCHAR(80) NULL,
    state VARCHAR(80) NULL,
    pincode VARCHAR(12) NULL,
    opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    balance_nature ENUM('receivable', 'payable') NOT NULL DEFAULT 'receivable',
    current_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_parties_gstin (gstin),
    KEY idx_parties_name (name),
    KEY idx_parties_type (party_type),
    KEY idx_parties_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
