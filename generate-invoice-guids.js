#!/usr/bin/env node

/**
 * Generate deterministic GUIDs for invoices
 *
 * This script adds unique invoice_guid fields to OCR and ledger invoice data.
 * GUIDs are deterministic (based on invoice properties) so they remain consistent
 * across runs and can be used for reliable merging and identification.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Load vendor registry for vendor GUID lookup
const vendorsPath = path.join(__dirname, 'vendors.json');
const vendorRegistry = JSON.parse(fs.readFileSync(vendorsPath, 'utf8'));

// Build vendor lookup maps
const vendorByVendorId = new Map();
const vendorByAlias = new Map();

vendorRegistry.vendors.forEach(vendor => {
  if (vendor.vendor_id) {
    vendorByVendorId.set(vendor.vendor_id, vendor);
  }
  vendor.aliases.forEach(alias => {
    vendorByAlias.set(alias.toLowerCase().trim(), vendor);
  });
});

/**
 * Get vendor GUID from registry
 */
function getVendorGuid(vendorName, vendorId) {
  // Try by vendor_id first
  if (vendorId && vendorByVendorId.has(vendorId)) {
    return vendorByVendorId.get(vendorId).guid;
  }
  // Then try by name
  if (vendorName) {
    const normalized = vendorName.toLowerCase().trim();
    if (vendorByAlias.has(normalized)) {
      return vendorByAlias.get(normalized).guid;
    }
  }
  return null;
}

/**
 * Generate a deterministic GUID for an invoice based on its properties
 */
function generateInvoiceGuid(invoice, source) {
  // Create a unique key from invoice properties
  const keyParts = [
    source, // 'ocr' or 'ledger'
    invoice.invoice_number || '',
    invoice.vendor_id || invoice.vendor_name || '',
    invoice.invoice_date || '',
    // Include amount to differentiate similar invoices
    String(invoice.invoice_total || invoice.amount || 0),
    // For OCR, include source page for uniqueness
    source === 'ocr' ? String(invoice.meta_source_page || '') : '',
    // For ledger, include batch number
    source === 'ledger' ? String(invoice.batch_number || '') : ''
  ];

  const keyString = keyParts.join('|');

  // Create SHA-256 hash and take first 16 chars for a readable GUID
  const hash = crypto.createHash('sha256').update(keyString).digest('hex');

  // Format: inv-{source}-{hash}
  // e.g., inv-ocr-a1b2c3d4e5f6g7h8 or inv-ldg-a1b2c3d4e5f6g7h8
  const prefix = source === 'ocr' ? 'inv-ocr' : 'inv-ldg';
  return `${prefix}-${hash.substring(0, 16)}`;
}

/**
 * Process OCR invoices
 */
function processOcrInvoices() {
  const ocrPath = path.join(__dirname, 'ocr-invoices.json');
  console.log('Processing OCR invoices...');

  const ocrData = JSON.parse(fs.readFileSync(ocrPath, 'utf8'));
  let addedCount = 0;
  let updatedCount = 0;

  ocrData.invoices.forEach(invoice => {
    // Add vendor_guid
    const vendorGuid = getVendorGuid(invoice.vendor_name, invoice.vendor_id);
    if (vendorGuid) {
      invoice.vendor_guid = vendorGuid;
    }

    // Generate invoice GUID
    const newGuid = generateInvoiceGuid(invoice, 'ocr');

    if (!invoice.invoice_guid) {
      invoice.invoice_guid = newGuid;
      addedCount++;
    } else if (invoice.invoice_guid !== newGuid) {
      // GUID exists but is different - keep existing for stability
      updatedCount++;
    }
  });

  // Write back
  fs.writeFileSync(ocrPath, JSON.stringify(ocrData, null, 2));
  console.log(`  OCR: Added ${addedCount} new GUIDs, ${updatedCount} existing GUIDs preserved`);
  console.log(`  Total OCR invoices: ${ocrData.invoices.length}`);

  return ocrData;
}

/**
 * Process ledger invoices
 */
function processLedgerInvoices() {
  const ledgerPath = path.join(__dirname, 'ledger-invoices.json');
  console.log('Processing Ledger invoices...');

  const ledgerData = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  let addedCount = 0;
  let updatedCount = 0;

  ledgerData.invoices.forEach(invoice => {
    // Add vendor_guid
    const vendorGuid = getVendorGuid(invoice.vendor_name, invoice.vendor_id);
    if (vendorGuid) {
      invoice.vendor_guid = vendorGuid;
    }

    // Generate invoice GUID
    const newGuid = generateInvoiceGuid(invoice, 'ledger');

    if (!invoice.invoice_guid) {
      invoice.invoice_guid = newGuid;
      addedCount++;
    } else if (invoice.invoice_guid !== newGuid) {
      updatedCount++;
    }
  });

  // Write back
  fs.writeFileSync(ledgerPath, JSON.stringify(ledgerData, null, 2));
  console.log(`  Ledger: Added ${addedCount} new GUIDs, ${updatedCount} existing GUIDs preserved`);
  console.log(`  Total Ledger invoices: ${ledgerData.invoices.length}`);

  return ledgerData;
}

/**
 * Generate summary statistics
 */
function generateSummary(ocrData, ledgerData) {
  console.log('\n=== Invoice GUID Summary ===');

  // Count invoices by vendor
  const vendorStats = new Map();

  [...ocrData.invoices, ...ledgerData.invoices].forEach(inv => {
    const vguid = inv.vendor_guid || 'unknown';
    if (!vendorStats.has(vguid)) {
      vendorStats.set(vguid, { ocr: 0, ledger: 0 });
    }
    const stats = vendorStats.get(vguid);
    if (inv.invoice_guid?.startsWith('inv-ocr')) {
      stats.ocr++;
    } else if (inv.invoice_guid?.startsWith('inv-ldg')) {
      stats.ledger++;
    }
  });

  console.log('\nInvoices by vendor:');
  vendorStats.forEach((stats, vguid) => {
    if (vguid !== 'unknown') {
      const vendor = vendorRegistry.vendors.find(v => v.guid === vguid);
      const name = vendor ? vendor.display_name : vguid;
      console.log(`  ${name}: ${stats.ocr} OCR, ${stats.ledger} Ledger`);
    }
  });

  if (vendorStats.has('unknown')) {
    const unknown = vendorStats.get('unknown');
    console.log(`  [Unknown vendor]: ${unknown.ocr} OCR, ${unknown.ledger} Ledger`);
  }
}

// Main execution
console.log('Invoice GUID Generator\n');
console.log('This script adds deterministic GUIDs to invoice data for reliable identification.\n');

const ocrData = processOcrInvoices();
const ledgerData = processLedgerInvoices();
generateSummary(ocrData, ledgerData);

console.log('\nDone! Invoice GUIDs have been added to the JSON files.');
console.log('These GUIDs will be included in all JSON exports.');
