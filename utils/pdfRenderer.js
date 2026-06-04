import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Theme colors aligned with the Flowventory app (indigo / slate).
const THEME = {
    primary: '#4F46E5', // indigo-600
    primarySoft: '#EEF2FF', // indigo-50
    headerBand: '#E0E7FF', // indigo-100
    border: '#C7D2FE', // indigo-200
    line: '#D1D5DB', // gray-300
    text: '#111827', // gray-900
    muted: '#6B7280', // gray-500
};

// Default invoice terms (hard-coded for now; can be moved to settings later).
const DEFAULT_TERMS = [
    'Kindly inform of any issues related to the invoice within 2 days.',
    'Payment against on delivery.',
    "Goods once sold won't be taken back; if any manufacturing defects, inform within 2 days of delivery.",
];

/**
 * Load the single (default) company profile used as the letterhead on every document.
 * Returns an empty object when none is configured so PDFs still render.
 */
export async function getCompanyProfile() {
    try {
        const [rows] = await db.query(
            `
            SELECT company_name, legal_name, gstin, pan, email, phone,
                   address, city, state, pincode, logo_url
            FROM company_profiles
            ORDER BY is_default DESC, id ASC
            LIMIT 1
            `
        );
        return rows[0] || {};
    } catch (err) {
        console.error('Failed to load company profile for PDF:', err.message);
        return {};
    }
}

/**
 * Fetch the company logo as a Buffer. Supports remote http(s) URLs as well as
 * local files saved under /uploads. Returns null on any failure so the PDF
 * still renders without a logo.
 */
export async function loadLogoBuffer(logoUrl) {
    if (!logoUrl || typeof logoUrl !== 'string') return null;
    const value = logoUrl.trim();
    if (!value) return null;

    try {
        // Local upload path (e.g. "/uploads/logo.png" or "uploads/logo.png").
        if (!/^https?:\/\//i.test(value)) {
            const relative = value.replace(/^\/+/, '');
            const filePath = path.join(__dirname, '..', relative);
            const uploadsRoot = path.join(__dirname, '..', 'uploads');
            const resolved = path.resolve(filePath);
            // Prevent path traversal: only allow files inside /uploads.
            if (!resolved.startsWith(path.resolve(uploadsRoot))) return null;
            if (!fs.existsSync(resolved)) return null;
            return fs.readFileSync(resolved);
        }

        // Remote URL.
        return await fetchRemoteImage(value);
    } catch (err) {
        console.error('Failed to load logo image:', err.message);
        return null;
    }
}

function fetchRemoteImage(url, redirectsLeft = 3) {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        const request = client.get(url, { timeout: 5000 }, (response) => {
            const status = response.statusCode || 0;

            // Follow a limited number of redirects.
            if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
                response.resume();
                const next = new URL(response.headers.location, url).toString();
                resolve(fetchRemoteImage(next, redirectsLeft - 1));
                return;
            }

            if (status !== 200) {
                response.resume();
                resolve(null);
                return;
            }

            const contentType = String(response.headers['content-type'] || '');
            if (contentType && !/^image\//i.test(contentType)) {
                response.resume();
                resolve(null);
                return;
            }

            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                // Cap at 5 MB to avoid abuse / huge downloads.
                if (size > 5 * 1024 * 1024) {
                    request.destroy();
                    resolve(null);
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', () => resolve(null));
        });

        request.on('timeout', () => {
            request.destroy();
            resolve(null);
        });
        request.on('error', () => resolve(null));
    });
}

/** Convert a non-negative number to Indian-format words (rupees & paise). */
export function amountInWords(amount) {
    const num = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
    const rupees = Math.floor(num);
    const paise = Math.round((num - rupees) * 100);

    const words = numberToWords(rupees);
    let result = words ? `${words} Rupees` : 'Zero Rupees';
    if (paise > 0) {
        result += ` and ${numberToWords(paise)} Paise`;
    }
    return `${result} only`;
}

function numberToWords(n) {
    if (n === 0) return '';
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
        'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const twoDigits = (x) => {
        if (x < 20) return ones[x];
        const t = Math.floor(x / 10);
        const o = x % 10;
        return `${tens[t]}${o ? ' ' + ones[o] : ''}`;
    };

    const threeDigits = (x) => {
        const h = Math.floor(x / 100);
        const rest = x % 100;
        let str = '';
        if (h) str += `${ones[h]} Hundred`;
        if (rest) str += `${h ? ' ' : ''}${twoDigits(rest)}`;
        return str;
    };

    let result = '';
    const crore = Math.floor(n / 10000000);
    n %= 10000000;
    const lakh = Math.floor(n / 100000);
    n %= 100000;
    const thousand = Math.floor(n / 1000);
    n %= 1000;
    const hundred = n;

    if (crore) result += `${numberToWords(crore)} Crore `;
    if (lakh) result += `${twoDigits(lakh)} Lakh `;
    if (thousand) result += `${twoDigits(thousand)} Thousand `;
    if (hundred) result += threeDigits(hundred);

    return result.trim();
}

const money = (v) => Number(v || 0).toFixed(2);

/**
 * Render the branded company header (logo + company details + document title).
 * Returns the Y position to continue drawing below the header.
 */
function renderHeader(doc, company, { title, meta }) {
    const left = 40;
    const right = 555;
    const top = 40;
    const padTop = 12;

    // Determine logo presence and the X offset for the text column.
    const logoBuffer = company.__logoBuffer;
    const hasLogo = Boolean(logoBuffer);
    const logoSize = 60;
    const textX = hasLogo ? left + 84 : left + 14;
    const textWidth = 300;

    // Build the detail lines.
    const addressLine = [company.address, company.city, company.state, company.pincode]
        .filter(Boolean)
        .join(', ');
    const detailLines = [];
    if (addressLine) detailLines.push(addressLine);
    const contact = [company.phone ? `Ph: ${company.phone}` : null, company.email || null]
        .filter(Boolean)
        .join('  |  ');
    if (contact) detailLines.push(contact);
    const taxLine = [company.gstin ? `GSTIN: ${company.gstin}` : null, company.pan ? `PAN: ${company.pan}` : null]
        .filter(Boolean)
        .join('  |  ');
    if (taxLine) detailLines.push(taxLine);
    const detailText = detailLines.join('\n');

    // Measure heights so the band can grow to fit the content.
    const nameY = top + padTop;
    doc.font('Helvetica-Bold').fontSize(16);
    const nameHeight = doc.heightOfString(company.company_name || 'Your Company', { width: textWidth });

    const detailsY = nameY + nameHeight + 4;
    doc.font('Helvetica').fontSize(8);
    const detailsHeight = detailText ? doc.heightOfString(detailText, { width: textWidth, lineGap: 1 }) : 0;

    // Band height = whichever is taller: the text column or the logo, plus padding.
    const contentBottom = detailsY + detailsHeight;
    const textColumnHeight = contentBottom - top;
    const logoColumnHeight = hasLogo ? padTop + logoSize : 0;
    const bandHeight = Math.max(textColumnHeight, logoColumnHeight) + padTop;

    // Header band background.
    doc.rect(left, top, right - left, bandHeight).fill(THEME.headerBand);

    // Logo, vertically centered within the band.
    if (hasLogo) {
        try {
            const logoY = top + (bandHeight - logoSize) / 2;
            doc.image(logoBuffer, left + 12, logoY, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
        } catch {
            // Ignore unsupported image formats (pdfkit supports PNG/JPEG only).
        }
    }

    // Company name + details.
    doc.fillColor(THEME.text).font('Helvetica-Bold').fontSize(16)
        .text(company.company_name || 'Your Company', textX, nameY, { width: textWidth });
    if (detailText) {
        doc.font('Helvetica').fontSize(8).fillColor(THEME.muted)
            .text(detailText, textX, detailsY, { width: textWidth, lineGap: 1 });
    }

    // Document title + meta on the right.
    doc.fillColor(THEME.primary).font('Helvetica-Bold').fontSize(18)
        .text(title, right - 230, top + padTop, { width: 216, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(THEME.text);
    const metaText = meta.filter(Boolean).join('\n');
    doc.text(metaText, right - 230, top + 38, { width: 216, align: 'right' });

    return top + bandHeight + 16;
}

/**
 * Renders a complete branded document and ends the stream.
 *
 * @param {object} opts
 * @param {PDFDocument} opts.doc           pdfkit document piped to the response
 * @param {object} opts.company            company profile (with __logoBuffer)
 * @param {string} opts.title              e.g. "TAX INVOICE"
 * @param {string[]} opts.meta             right-aligned header lines (No, Date...)
 * @param {string} opts.partyLabel         e.g. "Bill To", "Supplier"
 * @param {object} opts.party              { name, phone, gstin, address }
 * @param {Array} opts.items               line items
 * @param {object} opts.totals             totals object
 * @param {string} opts.totalLabel         label for the grand total row
 * @param {object} [opts.payment]          optional { paid, balance }
 */
export function renderDocument(opts) {
    const { doc, company, title, meta, partyLabel, party, items, totals, totalLabel, payment } = opts;

    let y = renderHeader(doc, company, { title, meta });

    // Party block.
    doc.fillColor(THEME.text).font('Helvetica-Bold').fontSize(11).text(partyLabel, 40, y);
    y += 16;
    doc.font('Helvetica').fontSize(10);
    doc.text(party.name || '-', 40, y);
    y += 14;
    if (party.phone) { doc.fillColor(THEME.muted).text(`Phone: ${party.phone}`, 40, y); y += 13; }
    if (party.gstin) { doc.fillColor(THEME.muted).text(`GSTIN: ${party.gstin}`, 40, y); y += 13; }
    if (party.address) { doc.fillColor(THEME.muted).text(party.address, 40, y, { width: 300 }); y += 13; }
    doc.fillColor(THEME.text);

    y += 10;

    // Items table.
    const x = 40;
    const w = [24, 188, 56, 60, 72, 55, 70];
    const headers = ['#', 'Item', 'Qty', 'Rate', 'Taxable', 'GST %', 'Line Total'];
    let cursorX = x;

    const tableTop = y;
    doc.font('Helvetica-Bold').fontSize(9);
    headers.forEach((header, i) => {
        doc.rect(cursorX, tableTop, w[i], 22).fillAndStroke(THEME.primary, THEME.primary);
        doc.fillColor('#FFFFFF').text(header, cursorX + 4, tableTop + 7, {
            width: w[i] - 8,
            align: i >= 2 ? 'right' : 'left',
        });
        cursorX += w[i];
    });

    y = tableTop + 22;
    doc.font('Helvetica').fontSize(9);
    items.forEach((line, idx) => {
        cursorX = x;
        const row = [
            String(idx + 1),
            `${line.item_name || '-'}${line.hsn_code ? `\nHSN: ${line.hsn_code}` : ''}`,
            `${Number(line.quantity || 0).toFixed(2)} ${line.unit || ''}`.trim(),
            money(line.rate),
            money(line.taxable_value),
            Number(line.gst_percent || 0).toFixed(2),
            money(line.line_total),
        ];

        const rowHeight = line.hsn_code ? 30 : 22;
        const zebra = idx % 2 === 1;
        row.forEach((cell, i) => {
            if (zebra) {
                doc.rect(cursorX, y, w[i], rowHeight).fillAndStroke(THEME.primarySoft, THEME.border);
            } else {
                doc.rect(cursorX, y, w[i], rowHeight).stroke(THEME.border);
            }
            doc.fillColor(THEME.text).text(cell, cursorX + 4, y + 6, {
                width: w[i] - 8,
                align: i >= 2 ? 'right' : 'left',
                ellipsis: true,
            });
            cursorX += w[i];
        });

        y += rowHeight;
        if (y > 680) {
            doc.addPage();
            y = 60;
        }
    });

    // Totals box.
    y += 12;
    const boxX = 320;
    const boxW = 235;
    const labelOpts = { width: 150, align: 'right' };
    const valueOpts = { width: 70, align: 'right' };
    let ty = y;

    const totalRows = [
        ['Subtotal', money(totals.subtotal)],
        ['Taxable', money(totals.taxable_amount)],
    ];
    if (Number(totals.cgst_amount)) totalRows.push(['CGST', money(totals.cgst_amount)]);
    if (Number(totals.sgst_amount)) totalRows.push(['SGST', money(totals.sgst_amount)]);
    if (Number(totals.igst_amount)) totalRows.push(['IGST', money(totals.igst_amount)]);
    if (Number(totals.round_off)) totalRows.push(['Round Off', money(totals.round_off)]);

    doc.font('Helvetica').fontSize(10).fillColor(THEME.text);
    totalRows.forEach(([label, value]) => {
        doc.text(`${label}:`, boxX, ty, labelOpts);
        doc.text(value, boxX + 158, ty, valueOpts);
        ty += 16;
    });

    // Grand total highlighted band.
    ty += 4;
    doc.rect(boxX, ty, boxW, 26).fill(THEME.primary);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12)
        .text(`${totalLabel}:`, boxX + 8, ty + 7, { width: 140, align: 'right' });
    doc.text(money(totals.total_amount), boxX + 158, ty + 7, valueOpts);
    ty += 34;

    // Amount in words (left side).
    doc.fillColor(THEME.text).font('Helvetica-Bold').fontSize(9).text('Amount in Words:', 40, y);
    doc.font('Helvetica').fontSize(9).fillColor(THEME.muted)
        .text(amountInWords(totals.total_amount), 40, y + 14, { width: 260 });
    let leftY = y + 14 + doc.heightOfString(amountInWords(totals.total_amount), { width: 260 }) + 12;

    // Optional payment / balance.
    if (payment) {
        doc.font('Helvetica').fontSize(10).fillColor(THEME.text);
        doc.text('Received:', boxX, ty, labelOpts);
        doc.text(money(payment.paid), boxX + 158, ty, valueOpts);
        ty += 16;
        doc.text('Balance:', boxX, ty, labelOpts);
        doc.text(money(payment.balance), boxX + 158, ty, valueOpts);
        ty += 16;
    }

    // Bank details (left column).
    const bank = company.__bankAccount;
    if (bank) {
        const bankLines = [];
        if (bank.account_name) bankLines.push(`Account Name : ${bank.account_name}`);
        if (bank.account_number) bankLines.push(`Account No. : ${bank.account_number}`);
        const bankNameLine = [bank.bank_name, bank.branch_name].filter(Boolean).join(', ');
        if (bankNameLine) bankLines.push(`Bank : ${bankNameLine}`);
        if (bank.ifsc_code) bankLines.push(`IFSC Code : ${bank.ifsc_code}`);
        if (bank.upi_id) bankLines.push(`UPI : ${bank.upi_id}`);

        if (bankLines.length) {
            doc.fillColor(THEME.primary).font('Helvetica-Bold').fontSize(9)
                .text('Bank Details:', 40, leftY);
            leftY += 14;
            doc.fillColor(THEME.text).font('Helvetica').fontSize(8.5);
            bankLines.forEach((line) => {
                doc.text(line, 40, leftY, { width: 270 });
                leftY += doc.heightOfString(line, { width: 270 }) + 3;
            });
            leftY += 6;
        }
    }

    // Terms & conditions (left column).
    if (DEFAULT_TERMS.length) {
        doc.fillColor(THEME.primary).font('Helvetica-Bold').fontSize(9)
            .text('Terms & Conditions:', 40, leftY);
        leftY += 14;
        doc.fillColor(THEME.muted).font('Helvetica').fontSize(8);
        DEFAULT_TERMS.forEach((term, idx) => {
            const text = `${idx + 1}. ${term}`;
            doc.text(text, 40, leftY, { width: 270 });
            leftY += doc.heightOfString(text, { width: 270 }) + 2;
        });
    }

    // Signatory block (right column), kept below all left/right content.
    const signY = Math.max(ty + 24, y + 60);
    doc.fillColor(THEME.muted).font('Helvetica').fontSize(9)
        .text(`For ${company.company_name || 'Your Company'}`, boxX, signY, { width: boxW, align: 'center' });
    doc.moveTo(boxX + 40, signY + 40).lineTo(boxX + boxW - 40, signY + 40).stroke(THEME.line);
    doc.text('Authorized Signatory', boxX, signY + 44, { width: boxW, align: 'center' });

    doc.end();
}

/**
 * Convenience: build company context (profile + logo buffer) in one call.
 */
export async function buildCompanyContext() {
    const company = await getCompanyProfile();
    company.__logoBuffer = await loadLogoBuffer(company.logo_url);
    company.__bankAccount = await getPrimaryBankAccount();
    return company;
}

/**
 * Load the primary (active) bank account to print on documents. Returns null
 * when none is configured.
 */
export async function getPrimaryBankAccount() {
    try {
        const [rows] = await db.query(
            `
            SELECT account_name, bank_name, account_number, ifsc_code, branch_name, upi_id
            FROM bank_accounts
            WHERE is_active = 1
            ORDER BY id ASC
            LIMIT 1
            `
        );
        return rows[0] || null;
    } catch (err) {
        console.error('Failed to load bank account for PDF:', err.message);
        return null;
    }
}
