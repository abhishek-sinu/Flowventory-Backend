-- Flowventory schema migration 005: Settings (company, tax rates, units, bank accounts)

CREATE TABLE IF NOT EXISTS company_profiles (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    company_name VARCHAR(160) NOT NULL,
    legal_name VARCHAR(160) NULL,
    gstin VARCHAR(20) NULL,
    pan VARCHAR(20) NULL,
    email VARCHAR(150) NULL,
    phone VARCHAR(20) NULL,
    address TEXT NULL,
    city VARCHAR(80) NULL,
    state VARCHAR(80) NULL,
    pincode VARCHAR(12) NULL,
    logo_url VARCHAR(255) NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_company_profiles_gstin (gstin),
    KEY idx_company_profiles_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tax_rates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(80) NOT NULL,
    rate_percent DECIMAL(5,2) NOT NULL,
    tax_type ENUM('gst', 'igst', 'cess', 'other') NOT NULL DEFAULT 'gst',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_tax_rates_name_rate (name, rate_percent),
    KEY idx_tax_rates_type (tax_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS units (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    unit_name VARCHAR(40) NOT NULL,
    unit_code VARCHAR(20) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_units_code (unit_code),
    UNIQUE KEY uq_units_name (unit_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bank_accounts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_name VARCHAR(120) NOT NULL,
    bank_name VARCHAR(120) NOT NULL,
    account_number VARCHAR(60) NOT NULL,
    ifsc_code VARCHAR(20) NULL,
    branch_name VARCHAR(120) NULL,
    upi_id VARCHAR(120) NULL,
    opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    current_balance DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_bank_accounts_number (account_number),
    KEY idx_bank_accounts_bank_name (bank_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
