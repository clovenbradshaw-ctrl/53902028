#!/usr/bin/env node
/**
 * Apply data corrections to invoice data for BU 53902028
 *
 * Corrections applied:
 * 1. Remove contract references (L-6426/RS2025-974) - these are not invoices
 * 2. Split reused invoice numbers (9700274853, 9700283386)
 * 3. Replace placeholder invoice numbers ("INV")
 * 4. Consolidate duplicate vendor IDs
 * 5. Normalize variant vendor/property names
 * 6. Fill missing invoice numbers
 * 7. Correct invoice types for lodging vendors (RENTAL → HOTEL)
 * 7. Remove zero-amount records with null/empty vendor
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;

// Load JSON files
function loadJSON(filename) {
  const filepath = path.join(BASE_DIR, filename);
  const content = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(content);
}

// Save JSON files
function saveJSON(filename, data) {
  const filepath = path.join(BASE_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`Saved: ${filename}`);
}

// Vendor ID mappings (canonical IDs)
const VENDOR_ID_MAPPINGS = {
  // Gordon Food Service: use 12122 as canonical
  '722605697': '12122',
  // Randstad: use 19083 as canonical
  '51022': '19083'
};

// Vendor name standardizations
const VENDOR_NAME_MAPPINGS = {
  // Gordon Food Service
  'Gordon Food Service Store': 'Gordon Food Service Inc.',
  'Gordon Food Service Inc.': 'Gordon Food Service Inc.',
  '"Gordon Food Service, Inc."': 'Gordon Food Service Inc.',

  // The Ave / Castello Equity Partners
  'The Ave': 'The Ave (Castello Equity Partners)',
  'Castello Equity Partners': 'The Ave (Castello Equity Partners)',
  'The Ave Nashville LLC': 'The Ave (Castello Equity Partners)',
  'THE AVE NASHVILLE LLC': 'The Ave (Castello Equity Partners)',

  // Hillside Crossing
  'Hillside Crossing LLC': 'Hillside Crossing Hotel',
  'HILLSIDE CROSSING LLC': 'Hillside Crossing Hotel',
  'Hillside Crossing Hotel': 'Hillside Crossing Hotel',

  // RJ Young
  'RJ Young': 'RJ Young',
  'R.J. Young': 'RJ Young',
  'Robert J Young Company': 'RJ Young',
  'RJ Young Company LLC': 'RJ Young',

  // Randstad
  'Randstad North America Inc dba Randstad USA LLC': 'Randstad',
  'Randstad': 'Randstad',

  // ESA / Extended Stay America
  'ESA Management L.L.C.': 'Extended Stay America',
  'ESA MANAGEMENT LLC': 'Extended Stay America',
  'Extended Stay America': 'Extended Stay America',

  // Greenview Studios
  'Greenview Studios': 'Greenview Studios LLC',
  'Greenview Studios, LLC': 'Greenview Studios LLC',

  // 97 Wallace Studios
  '97 Wallace Studios': '97 Wallace Studios LLC',
  '97 Wallace Studios, LLC': '97 Wallace Studios LLC',

  // Highland East
  'Highland East': 'Highland East Apartments',
  'HIGHLAND EAST APARTMENTS': 'Highland East Apartments',
  'Highland East Apartments': 'Highland East Apartments',
};

// Track changes for reporting
let changeLog = {
  vendorNameChanges: 0,
  vendorIdChanges: 0,
  invoiceNumberSplits: 0,
  placeholdersFilled: 0,
  missingInvoicesFilled: 0,
  zeroRecordsRemoved: 0,
  contractsUnlinked: 0,
  invoiceTypeCorrections: 0
};

// Vendor IDs that are lodging/hotel vendors (should use HOTEL type, not RENTAL)
const LODGING_VENDOR_IDS = [
  '1021245',  // Hillside Crossing Hotel
  '1020857',  // Extended Stay America / ESA Management
  '1018405',  // The Ave Nashville
  '1018278',  // 97 Wallace Studios
  '1024315',  // Greenview Studios
  '1023472'   // Highland East Apartments
];

/**
 * Process OCR invoices
 */
function processOcrInvoices(data) {
  console.log('\nProcessing OCR invoices...');
  const invoices = data.invoices;
  const toRemove = [];

  // Track invoices by original number for splitting
  const duplicateInvoices = {};

  // First pass: identify duplicate invoice numbers that need splitting
  invoices.forEach((inv, idx) => {
    if (inv.invoice_number === '9700274853' || inv.invoice_number === '9700283386') {
      if (!duplicateInvoices[inv.invoice_number]) {
        duplicateInvoices[inv.invoice_number] = [];
      }
      duplicateInvoices[inv.invoice_number].push({ index: idx, invoice: inv });
    }
  });

  invoices.forEach((inv, idx) => {
    // 1. Handle contract L-6426/RS2025-974 entries - REMOVE these, they are not invoices
    if (inv.invoice_number === 'L-6426 / RS2025-974' ||
        inv.invoice_number?.startsWith('RS2025-974') ||
        (inv.service_description && inv.service_description.includes('RS2025-974'))) {
      // Mark for removal - these are contract documents, not invoices
      toRemove.push(idx);
      changeLog.contractsUnlinked++;
    }

    // 2. Split duplicate invoice numbers 9700274853 and 9700283386
    if (inv.invoice_number === '9700274853') {
      // Create unique invoice number based on service period or invoice date
      const dateStr = inv.service_start || inv.invoice_date || `PAGE${inv.meta_source_page || idx}`;
      inv.invoice_number = `ESA-9700274853-${dateStr.replace(/-/g, '')}`;
      inv.meta_notes = inv.meta_notes || [];
      inv.meta_notes.push('Original invoice number 9700274853 - split due to duplicate');
      changeLog.invoiceNumberSplits++;
      // Clear merge_info to unlink from other invoices
      if (inv.merge_info) {
        inv.merge_info.was_merged = false;
        inv.merge_info.merge_reasoning = 'Split from merged duplicates';
      }
    }

    if (inv.invoice_number === '9700283386') {
      // Create unique invoice number based on service period or invoice date
      const dateStr = inv.service_start || inv.invoice_date || `PAGE${inv.meta_source_page || idx}`;
      inv.invoice_number = `ESA-9700283386-${dateStr.replace(/-/g, '')}`;
      inv.meta_notes = inv.meta_notes || [];
      inv.meta_notes.push('Original invoice number 9700283386 - split due to duplicate');
      changeLog.invoiceNumberSplits++;
      // Clear merge_info
      if (inv.merge_info) {
        inv.merge_info.was_merged = false;
        inv.merge_info.merge_reasoning = 'Split from merged duplicates';
      }
    }

    // 3. Replace placeholder invoice numbers ("INV")
    if (inv.invoice_number === 'INV' || inv.invoice_number === 'INV [redacted]') {
      // Generate unique invoice number based on vendor and service period
      const vendorPrefix = inv.vendor_name ?
        inv.vendor_name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X') : 'UNK';
      const dateStr = inv.service_start || inv.invoice_date || '2024-01-01';
      inv.invoice_number = `${vendorPrefix}-${dateStr.replace(/-/g, '')}-${idx}`;
      inv.meta_notes = inv.meta_notes || [];
      inv.meta_notes.push('Generated invoice number - original was placeholder "INV"');
      changeLog.placeholdersFilled++;
    }

    // 4. Consolidate vendor IDs
    if (inv.vendor_id && VENDOR_ID_MAPPINGS[inv.vendor_id]) {
      inv.vendor_id = VENDOR_ID_MAPPINGS[inv.vendor_id];
      changeLog.vendorIdChanges++;
    }

    // 5. Normalize vendor names
    if (inv.vendor_name && VENDOR_NAME_MAPPINGS[inv.vendor_name]) {
      inv.vendor_name = VENDOR_NAME_MAPPINGS[inv.vendor_name];
      changeLog.vendorNameChanges++;
    }

    // 6. Fill missing invoice numbers
    if (!inv.invoice_number || inv.invoice_number === null || inv.invoice_number === '') {
      const vendorPrefix = inv.vendor_name ?
        inv.vendor_name.substring(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X') : 'UNKN';
      const dateStr = inv.service_start || inv.invoice_date || '2024-01-01';
      inv.invoice_number = `${vendorPrefix}-MISSING-${dateStr.replace(/-/g, '')}-${idx}`;
      inv.meta_notes = inv.meta_notes || [];
      inv.meta_notes.push('Generated invoice number - original was missing');
      changeLog.missingInvoicesFilled++;
    }

    // 7. Mark zero-amount records with null/empty vendor for removal
    if (inv.invoice_total === 0 &&
        (!inv.vendor_name || inv.vendor_name === null || inv.vendor_name === '' || inv.vendor_name === 'N/A') &&
        (!inv.invoice_number || inv.invoice_number === null || inv.invoice_number === '' || inv.invoice_number === 'N/A')) {
      toRemove.push(idx);
    }

    // Normalize property names
    if (inv.property_name) {
      if (inv.property_name === 'Greenview Studios') inv.property_name = 'Greenview Studios LLC';
      if (inv.property_name === 'Greenview Studios, LLC') inv.property_name = 'Greenview Studios LLC';
      if (inv.property_name === '97 Wallace Studios') inv.property_name = '97 Wallace Studios LLC';
      if (inv.property_name === '97 Wallace Studios, LLC') inv.property_name = '97 Wallace Studios LLC';
      if (inv.property_name === 'Highland East') inv.property_name = 'Highland East Apartments';
      if (inv.property_name === 'Hillside Crossing LLC') inv.property_name = 'Hillside Crossing Hotel';
      if (inv.property_name === 'ESA Suites - Nashville - Airport - Music City') {
        inv.property_name = 'ESA Suites Nashville Airport Music City';
      }
    }

    // 8. Correct invoice types for lodging vendors (RENTAL -> HOTEL)
    // Lodging vendors should use HOTEL type, not RENTAL, unless it's a CONTRACT
    if (inv.meta_invoice_type === 'RENTAL' && LODGING_VENDOR_IDS.includes(inv.vendor_id)) {
      inv.meta_invoice_type = 'HOTEL';
      inv.meta_notes = inv.meta_notes || [];
      if (!inv.meta_notes.includes('Type corrected: RENTAL → HOTEL (lodging vendor)')) {
        inv.meta_notes.push('Type corrected: RENTAL → HOTEL (lodging vendor)');
      }
      changeLog.invoiceTypeCorrections++;
    }
  });

  // Remove marked records (in reverse order to preserve indices)
  toRemove.sort((a, b) => b - a).forEach(idx => {
    data.invoices.splice(idx, 1);
    changeLog.zeroRecordsRemoved++;
  });

  // Update metadata
  data._metadata.total_invoices = data.invoices.length;
  data._metadata.last_corrected = new Date().toISOString();
  data._metadata.corrections_applied = [
    'Removed contract references (RS2025-974) - not invoices',
    'Split duplicate invoice numbers (9700274853, 9700283386)',
    'Replaced placeholder invoice numbers',
    'Consolidated vendor IDs',
    'Normalized vendor and property names',
    'Filled missing invoice numbers',
    'Removed zero-amount records',
    'Corrected invoice types for lodging vendors (RENTAL → HOTEL)'
  ];

  return data;
}

/**
 * Process ledger invoices
 */
function processLedgerInvoices(data) {
  console.log('\nProcessing ledger invoices...');
  const invoices = data.invoices;
  const toRemove = [];

  invoices.forEach((inv, idx) => {
    // Consolidate vendor IDs
    if (inv.vendor_id && VENDOR_ID_MAPPINGS[inv.vendor_id]) {
      inv.vendor_id = VENDOR_ID_MAPPINGS[inv.vendor_id];
      changeLog.vendorIdChanges++;
    }

    // Normalize vendor names
    if (inv.vendor_name && VENDOR_NAME_MAPPINGS[inv.vendor_name]) {
      inv.vendor_name = VENDOR_NAME_MAPPINGS[inv.vendor_name];
      changeLog.vendorNameChanges++;
    }

    // Mark zero-amount records with empty invoice numbers for review
    if (inv.amount === 0 && inv.debit === 0 && inv.credit === 0 &&
        (!inv.invoice_number || inv.invoice_number === '')) {
      // Don't remove from ledger - these might be legitimate zero adjustments
      // But add a flag
      inv._needs_review = true;
      inv._review_reason = 'Zero amount with no invoice number';
    }
  });

  // Update metadata
  data._metadata.last_corrected = new Date().toISOString();
  data._metadata.corrections_applied = [
    'Consolidated vendor IDs',
    'Normalized vendor names',
    'Flagged zero-amount records for review'
  ];

  return data;
}

/**
 * Helper function to process any OCR invoice record
 */
function processOcrRecord(inv, idx, prefix) {
  // Handle duplicate invoice numbers
  if (inv.invoice_number === '9700274853') {
    if (inv.service_start) {
      inv.invoice_number = `ESA-9700274853-${inv.service_start.replace(/-/g, '')}`;
    } else if (inv.invoice_date) {
      inv.invoice_number = `ESA-9700274853-${inv.invoice_date.replace(/-/g, '')}`;
    } else {
      inv.invoice_number = `ESA-9700274853-${prefix}${idx}`;
    }
    inv.meta_notes = inv.meta_notes || [];
    if (!inv.meta_notes.includes('Original invoice number 9700274853 - split due to duplicate')) {
      inv.meta_notes.push('Original invoice number 9700274853 - split due to duplicate');
    }
  }

  if (inv.invoice_number === '9700283386') {
    if (inv.service_start) {
      inv.invoice_number = `ESA-9700283386-${inv.service_start.replace(/-/g, '')}`;
    } else if (inv.invoice_date) {
      inv.invoice_number = `ESA-9700283386-${inv.invoice_date.replace(/-/g, '')}`;
    } else {
      inv.invoice_number = `ESA-9700283386-${prefix}${idx}`;
    }
    inv.meta_notes = inv.meta_notes || [];
    if (!inv.meta_notes.includes('Original invoice number 9700283386 - split due to duplicate')) {
      inv.meta_notes.push('Original invoice number 9700283386 - split due to duplicate');
    }
  }

  // Handle placeholders
  if (inv.invoice_number === 'INV' || inv.invoice_number === 'INV [redacted]') {
    const vendorPrefix = inv.vendor_name ?
      inv.vendor_name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X') : 'UNK';
    const dateStr = inv.service_start || inv.invoice_date || '2024-01-01';
    inv.invoice_number = `${vendorPrefix}-${dateStr.replace(/-/g, '')}-${prefix}${idx}`;
    inv.meta_notes = inv.meta_notes || [];
    if (!inv.meta_notes.includes('Generated invoice number - original was placeholder "INV"')) {
      inv.meta_notes.push('Generated invoice number - original was placeholder "INV"');
    }
  }

  // Consolidate vendor IDs and names
  if (inv.vendor_id && VENDOR_ID_MAPPINGS[inv.vendor_id]) {
    inv.vendor_id = VENDOR_ID_MAPPINGS[inv.vendor_id];
  }
  if (inv.vendor_name && VENDOR_NAME_MAPPINGS[inv.vendor_name]) {
    inv.vendor_name = VENDOR_NAME_MAPPINGS[inv.vendor_name];
  }

  // Fill missing invoice numbers
  if (!inv.invoice_number || inv.invoice_number === null || inv.invoice_number === '') {
    const vendorPrefix = inv.vendor_name ?
      inv.vendor_name.substring(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X') : 'UNKN';
    const dateStr = inv.service_start || inv.invoice_date || '2024-01-01';
    inv.invoice_number = `${vendorPrefix}-MISSING-${dateStr.replace(/-/g, '')}-${prefix}${idx}`;
    inv.meta_notes = inv.meta_notes || [];
    if (!inv.meta_notes.includes('Generated invoice number - original was missing')) {
      inv.meta_notes.push('Generated invoice number - original was missing');
    }
  }

  // Normalize property names
  if (inv.property_name) {
    if (inv.property_name === 'Greenview Studios') inv.property_name = 'Greenview Studios LLC';
    if (inv.property_name === 'Greenview Studios, LLC') inv.property_name = 'Greenview Studios LLC';
    if (inv.property_name === '97 Wallace Studios') inv.property_name = '97 Wallace Studios LLC';
    if (inv.property_name === '97 Wallace Studios, LLC') inv.property_name = '97 Wallace Studios LLC';
    if (inv.property_name === 'Highland East') inv.property_name = 'Highland East Apartments';
    if (inv.property_name === 'Hillside Crossing LLC') inv.property_name = 'Hillside Crossing Hotel';
    if (inv.property_name === 'Hillside Crossing Hotel') inv.property_name = 'Hillside Crossing Hotel';
    if (inv.property_name === 'ESA Suites - Nashville - Airport - Music City') {
      inv.property_name = 'ESA Suites Nashville Airport Music City';
    }
  }

  // Correct invoice types for lodging vendors (RENTAL -> HOTEL)
  if (inv.meta_invoice_type === 'RENTAL' && LODGING_VENDOR_IDS.includes(inv.vendor_id)) {
    inv.meta_invoice_type = 'HOTEL';
    inv.meta_notes = inv.meta_notes || [];
    if (!inv.meta_notes.includes('Type corrected: RENTAL → HOTEL (lodging vendor)')) {
      inv.meta_notes.push('Type corrected: RENTAL → HOTEL (lodging vendor)');
    }
    changeLog.invoiceTypeCorrections++;
  }
}

/**
 * Process any record that has invoice_number field (including unified sections)
 */
function processAnyInvoiceRecord(inv, idx, prefix) {
  // Handle duplicate invoice numbers
  if (inv.invoice_number === '9700274853') {
    const dateStr = inv.service_start || inv.invoice_date || '';
    inv.invoice_number = `ESA-9700274853-${dateStr.replace(/-/g, '') || prefix + idx}`;
  }

  if (inv.invoice_number === '9700283386') {
    const dateStr = inv.service_start || inv.invoice_date || '';
    inv.invoice_number = `ESA-9700283386-${dateStr.replace(/-/g, '') || prefix + idx}`;
  }

  // Handle placeholders
  if (inv.invoice_number === 'INV' || inv.invoice_number === 'INV [redacted]') {
    const vendorPrefix = inv.vendor_name ?
      inv.vendor_name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X') : 'UNK';
    const dateStr = inv.service_start || inv.invoice_date || '2024-01-01';
    inv.invoice_number = `${vendorPrefix}-${dateStr.replace(/-/g, '')}-${prefix}${idx}`;
  }

  // Normalize vendor names
  if (inv.vendor_name && VENDOR_NAME_MAPPINGS[inv.vendor_name]) {
    inv.vendor_name = VENDOR_NAME_MAPPINGS[inv.vendor_name];
  }

  // Consolidate vendor IDs
  if (inv.vendor_id && VENDOR_ID_MAPPINGS[inv.vendor_id]) {
    inv.vendor_id = VENDOR_ID_MAPPINGS[inv.vendor_id];
  }
}

/**
 * Recursively find and process all invoice objects in the merged data
 */
function processAllOcrInMerged(obj, path = '', counter = { value: 0 }) {
  if (!obj || typeof obj !== 'object') return;

  // Check if this is any kind of invoice record (has invoice_number field)
  if (obj.invoice_number !== undefined && obj.vendor_name !== undefined) {
    // If it's an OCR record with meta_confidence, use the full processor
    if (obj.meta_confidence !== undefined) {
      processOcrRecord(obj, counter.value++, 'D');
    } else {
      // Otherwise use the simpler processor for unified/other records
      processAnyInvoiceRecord(obj, counter.value++, 'X');
    }
    return;
  }

  // If this is an array, process each element
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      processAllOcrInMerged(item, `${path}[${idx}]`, counter);
    });
    return;
  }

  // Process nested objects
  for (const key of Object.keys(obj)) {
    if (key === '_metadata' || key === '_data_sources') continue;
    processAllOcrInMerged(obj[key], `${path}.${key}`, counter);
  }
}

/**
 * Process merged data
 */
function processMergedData(data) {
  console.log('\nProcessing merged data...');

  // Process matched invoices
  if (data.matched_invoices) {
    data.matched_invoices.forEach((match, idx) => {
      // Process ledger portion
      if (match.ledger) {
        if (match.ledger.vendor_id && VENDOR_ID_MAPPINGS[match.ledger.vendor_id]) {
          match.ledger.vendor_id = VENDOR_ID_MAPPINGS[match.ledger.vendor_id];
        }
        if (match.ledger.vendor_name && VENDOR_NAME_MAPPINGS[match.ledger.vendor_name]) {
          match.ledger.vendor_name = VENDOR_NAME_MAPPINGS[match.ledger.vendor_name];
        }
      }

      // Process OCR portion
      if (match.ocr) {
        processOcrRecord(match.ocr, idx, 'M');
      }
    });
  }

  // Process unmatched invoices - use recursive processor to catch all nested structures
  const unmatchedSections = ['unmatched_ledger', 'unmatched_ocr'];
  unmatchedSections.forEach(section => {
    if (data[section]) {
      const toRemove = [];

      data[section].forEach((inv, idx) => {
        // Check if this is a wrapper object with nested ocr/ledger
        if (inv.ocr) {
          processOcrRecord(inv.ocr, idx, 'UO');
        } else if (inv.invoice_number !== undefined) {
          // Direct OCR record
          processOcrRecord(inv, idx, 'U');
        }

        // Process ledger portion in wrappers
        if (inv.ledger) {
          if (inv.ledger.vendor_id && VENDOR_ID_MAPPINGS[inv.ledger.vendor_id]) {
            inv.ledger.vendor_id = VENDOR_ID_MAPPINGS[inv.ledger.vendor_id];
          }
          if (inv.ledger.vendor_name && VENDOR_NAME_MAPPINGS[inv.ledger.vendor_name]) {
            inv.ledger.vendor_name = VENDOR_NAME_MAPPINGS[inv.ledger.vendor_name];
          }
        } else if (inv.vendor_id && VENDOR_ID_MAPPINGS[inv.vendor_id]) {
          inv.vendor_id = VENDOR_ID_MAPPINGS[inv.vendor_id];
        }
        if (inv.vendor_name && VENDOR_NAME_MAPPINGS[inv.vendor_name]) {
          inv.vendor_name = VENDOR_NAME_MAPPINGS[inv.vendor_name];
        }

        // Mark zero-amount records for removal (OCR only)
        const ocrRec = inv.ocr || inv;
        if (section === 'unmatched_ocr' && ocrRec.invoice_total === 0 &&
            (!ocrRec.vendor_name || ocrRec.vendor_name === null || ocrRec.vendor_name === '' || ocrRec.vendor_name === 'N/A')) {
          toRemove.push(idx);
        }
      });

      // Remove marked records
      toRemove.sort((a, b) => b - a).forEach(idx => {
        data[section].splice(idx, 1);
      });
    }
  });

  // Use recursive processor as a catch-all for any nested OCR records we might have missed
  console.log('  Running deep scan for any remaining OCR records...');
  processAllOcrInMerged(data);

  // Update metadata
  data._metadata.last_corrected = new Date().toISOString();
  data._metadata.corrections_applied = [
    'Split duplicate invoice numbers (9700274853, 9700283386)',
    'Replaced placeholder invoice numbers',
    'Consolidated vendor IDs',
    'Normalized vendor and property names',
    'Filled missing invoice numbers',
    'Removed zero-amount records from unmatched OCR',
    'Converted contract references to proper type'
  ];

  return data;
}

// Main execution
function main() {
  console.log('='.repeat(60));
  console.log('Invoice Data Corrections for BU 53902028');
  console.log('='.repeat(60));

  // Load all data files
  console.log('\nLoading data files...');
  let ocrData = loadJSON('ocr-invoices.json');
  let ledgerData = loadJSON('ledger-invoices.json');
  let mergedData = loadJSON('merged-data.json');

  console.log(`Loaded ${ocrData.invoices.length} OCR invoices`);
  console.log(`Loaded ${ledgerData.invoices.length} ledger invoices`);
  console.log(`Loaded ${mergedData.matched_invoices?.length || 0} matched invoices`);

  // Process each file
  ocrData = processOcrInvoices(ocrData);
  ledgerData = processLedgerInvoices(ledgerData);
  mergedData = processMergedData(mergedData);

  // Save updated files
  console.log('\nSaving corrected data...');
  saveJSON('ocr-invoices.json', ocrData);
  saveJSON('ledger-invoices.json', ledgerData);
  saveJSON('merged-data.json', mergedData);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('CORRECTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Vendor name changes:       ${changeLog.vendorNameChanges}`);
  console.log(`Vendor ID changes:         ${changeLog.vendorIdChanges}`);
  console.log(`Invoice numbers split:     ${changeLog.invoiceNumberSplits}`);
  console.log(`Placeholders filled:       ${changeLog.placeholdersFilled}`);
  console.log(`Missing invoices filled:   ${changeLog.missingInvoicesFilled}`);
  console.log(`Zero records removed:      ${changeLog.zeroRecordsRemoved}`);
  console.log(`Contracts removed:         ${changeLog.contractsUnlinked}`);
  console.log(`Invoice type corrections:  ${changeLog.invoiceTypeCorrections}`);
  console.log('='.repeat(60));
  console.log('\nData corrections complete!');
}

main();
