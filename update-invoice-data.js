#!/usr/bin/env node

/**
 * Invoice Data Update Script
 * Updates OCR data according to the requirements
 */

const fs = require('fs');
const path = require('path');

// ==================== CSV PARSING ====================
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(current);
      current = '';
    } else if ((char === '\n' || (char === '\r' && text[i + 1] !== '\n')) && !inQuotes) {
      currentRow.push(current);
      if (currentRow.some(c => c.trim())) rows.push(currentRow);
      currentRow = [];
      current = '';
    } else if (char === '\r' && !inQuotes) {
      // skip
    } else {
      current += char;
    }
  }
  if (current || currentRow.length > 0) {
    currentRow.push(current);
    if (currentRow.some(c => c.trim())) rows.push(currentRow);
  }

  if (rows.length === 0) return { headers: [], data: [] };

  const headers = rows[0].map(h => h.trim().replace(/^\uFEFF/, ''));
  const data = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });

  return { headers, data };
}

function escapeCSVField(field) {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function writeCSV(headers, data, outputPath) {
  const lines = [headers.map(escapeCSVField).join(',')];

  data.forEach(row => {
    const values = headers.map(h => escapeCSVField(row[h]));
    lines.push(values.join(','));
  });

  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
}

// ==================== OCR PARSING ====================
function parseOCR(ocrField) {
  if (!ocrField) return null;
  try {
    // Remove "Image X of Y" prefix if present
    let cleaned = ocrField.replace(/^Image \d+ of \d+\s*\n?/i, '');
    cleaned = cleaned.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    // Try to complete truncated JSON
    if (!cleaned.endsWith('}')) {
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace > 0) {
        cleaned = cleaned.substring(0, lastBrace + 1);
        const openBraces = (cleaned.match(/{/g) || []).length;
        const closeBraces = (cleaned.match(/}/g) || []).length;
        cleaned += '}'.repeat(openBraces - closeBraces);
      }
    }
    return JSON.parse(cleaned);
  } catch (e) {
    return null;
  }
}

function serializeOCR(ocr, pageNumber) {
  // postProcessOCR is just JSON, no prefix
  return JSON.stringify(ocr, null, 2);
}

function serializeRawOCR(ocr, originalField) {
  // Preserve "Image X of Y" prefix if present
  const prefixMatch = originalField?.match(/^(Image \d+ of \d+\s*\n?)/i);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  return prefix + JSON.stringify(ocr, null, 2);
}

function getPageNumber(row) {
  const match = row['File Path']?.match(/_page_(\d+)\.png$/);
  return match ? parseInt(match[1], 10) : null;
}

// ==================== UPDATE RULES ====================

// ESA pages to update (61 total)
const ESA_PAGES = [42, 43, 44, 46, 47, 48, 50, 51, 52, 54, 55, 56, 58, 59, 60, 61, 62, 63, 65, 66, 67, 69, 70, 71, 73, 74, 75, 77, 78, 80, 81, 83, 84, 86, 87, 89, 90, 92, 93, 95, 97, 98, 100, 101, 103, 104, 106, 108, 110, 112, 114, 117, 119, 121, 125, 135, 138, 140, 142, 144, 146];

// Hillside Crossing pages (13 total)
const HILLSIDE_PAGES = [207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219];

// Non-invoice pages to exclude
const EXCLUDE_PAGES = [190, 193, 205, 206];

// Page 122 complete JSON replacement
const PAGE_122_JSON = {
  "meta_confidence": 0.98,
  "meta_invoice_type": "HOTEL",
  "meta_is_full_invoice": true,
  "meta_is_continuation_page": false,
  "meta_has_grand_total": true,
  "meta_source_page": 122,
  "meta_source_file": "Finance_BU_53902028_Invoices.pdf",
  "meta_notes": [],

  "invoice_number": "1555056163",
  "invoice_date": "2025-05-18",
  "due_date": "2025-05-18",

  "vendor_name": "Extended Stay America",
  "vendor_id": "1020857",
  "vendor_address": "13024 Ballantyne Corporate Place, Suite 1000, Charlotte, NC 28277",
  "vendor_phone": null,
  "vendor_email": "accountsreceivable@extendedstay.com",

  "payer_name": "The Family Center",
  "payer_address": "139 Thompson Ln., Nashville, TN 37211",

  "bu_code": "53902028.502363",
  "processor_name": "Joseph Marsh",
  "processor_date": "2025-07-10",

  "invoice_total": 542.87,
  "amount_paid": 329.76,
  "amount_due": 542.87,
  "taxes": 69.44,

  "service_start": "2025-05-11",
  "service_end": "2025-05-17",
  "service_description": "Hotel stays for two guest accounts",

  "property_name": "ESA Suites - Nashville - Airport - Music City",
  "property_address": null,
  "unit_count": 2,

  "line_items": [
    {"date": "2025-05-11", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-12", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-13", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-14", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-15", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-16", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-17", "description": "Room night for guest 9700274547", "quantity": 1, "unit_price": 59.99, "amount": 59.99, "category": "room"},
    {"date": "2025-05-11", "description": "Room night for guest 9700274867", "quantity": 1, "unit_price": 68.99, "amount": 82.70, "category": "room"},
    {"date": "2025-05-12", "description": "Room night for guest 9700274867", "quantity": 1, "unit_price": 68.99, "amount": 82.70, "category": "room"},
    {"date": "2025-05-13", "description": "Room night for guest 9700274867", "quantity": 1, "unit_price": 68.99, "amount": 82.70, "category": "room"},
    {"date": "2025-05-14", "description": "Room night for guest 9700274867", "quantity": 1, "unit_price": 176.00, "amount": 204.60, "category": "room"}
  ],

  "cost_allocations": [],
  "confirmation_numbers": ["9700274547", "9700274867"],
  "employee_names": [],
  "reference_numbers": []
};

function applyUpdates(row) {
  const pageNum = getPageNumber(row);
  if (!pageNum) return row;

  // Update postProcessOCR, not the original OCR
  let ocr = parseOCR(row.postProcessOCR);
  if (!ocr) {
    // Fall back to OCR if postProcessOCR is empty
    ocr = parseOCR(row.OCR);
  }
  let updated = false;

  // 1. ESA Management L.L.C. → Extended Stay America
  if (ESA_PAGES.includes(pageNum)) {
    // Match ESA Management L.L.C. or any ESA variation, but not already Extended Stay America
    if (ocr && ocr.vendor_name !== 'Extended Stay America' &&
        (ocr.vendor_name === 'ESA Management L.L.C.' ||
         (ocr.vendor_name?.includes('ESA') && !ocr.vendor_name?.includes('Extended')))) {
      ocr.vendor_name = 'Extended Stay America';
      ocr.vendor_id = '1020857';
      ocr.vendor_address = '13024 Ballantyne Corporate Place, Suite 1000, Charlotte, NC 28277';
      updated = true;
      console.log(`  Page ${pageNum}: Updated ESA to Extended Stay America`);
    }
  }

  // 2. Hillside Crossing Hotel → Hillside Crossing LLC
  if (HILLSIDE_PAGES.includes(pageNum)) {
    if (ocr && ocr.vendor_name === 'Hillside Crossing Hotel') {
      ocr.vendor_name = 'Hillside Crossing LLC';
      if (!ocr.vendor_id) ocr.vendor_id = '1021245';
      updated = true;
      console.log(`  Page ${pageNum}: Updated Hillside Crossing Hotel to Hillside Crossing LLC`);
    }
  }

  // 3. Thompson Machinery Commerce Corp. → Thompson Machinery (page 227)
  if (pageNum === 227) {
    if (ocr && ocr.vendor_name === 'Thompson Machinery Commerce Corp.') {
      ocr.vendor_name = 'Thompson Machinery';
      updated = true;
      console.log(`  Page ${pageNum}: Updated Thompson Machinery vendor name`);
    }
  }

  // 4. RJ Young → Robert J Young Company (page 222)
  if (pageNum === 222) {
    if (ocr && ocr.vendor_name === 'RJ Young') {
      ocr.vendor_name = 'Robert J Young Company';
      if (!ocr.vendor_id) ocr.vendor_id = '4777';
      updated = true;
      console.log(`  Page ${pageNum}: Updated RJ Young to Robert J Young Company`);
    }
  }

  // 5. Highland East variants → Highland East Apartments
  if (pageNum === 228) {
    if (ocr && ocr.vendor_name === 'HIGHLAND EAST APARTMENTS') {
      ocr.vendor_name = 'Highland East Apartments';
      updated = true;
      console.log(`  Page ${pageNum}: Normalized HIGHLAND EAST APARTMENTS case`);
    }
  }
  if (pageNum === 229) {
    if (ocr && ocr.vendor_name === 'Highland East') {
      ocr.vendor_name = 'Highland East Apartments';
      updated = true;
      console.log(`  Page ${pageNum}: Updated Highland East to Highland East Apartments`);
    }
  }

  // 6. Page 122 - Replace truncated JSON (always replace regardless of existing ocr)
  if (pageNum === 122) {
    ocr = PAGE_122_JSON;
    updated = true;
    console.log(`  Page ${pageNum}: Replaced truncated JSON with complete data`);
  }

  // Early return for page 122 if ocr was set
  if (pageNum === 122 && ocr) {
    row.postProcessOCR = serializeOCR(ocr, pageNum);
    return row;
  }

  // 7. Page 254 - Mark as continuation page for Grand Tents & Events
  if (pageNum === 254) {
    // Create ocr if it doesn't exist
    if (!ocr) {
      ocr = {
        meta_confidence: 0.5,
        meta_source_page: 254,
        meta_source_file: "Finance_BU_53902028_Invoices.pdf",
        meta_notes: []
      };
    }
    ocr.meta_is_continuation_page = true;
    ocr.vendor_name = 'Grand Tents & Events';
    ocr.invoice_number = '59EE76EB';
    updated = true;
    console.log(`  Page ${pageNum}: Marked as continuation page for Grand Tents & Events`);
  }

  // 8. Non-invoice pages - flag for exclusion
  if (EXCLUDE_PAGES.includes(pageNum)) {
    // Create ocr if it doesn't exist
    if (!ocr) {
      ocr = {
        meta_confidence: 0.2,
        meta_source_page: pageNum,
        meta_source_file: "Finance_BU_53902028_Invoices.pdf",
        meta_notes: []
      };
    }
    ocr.meta_exclude_from_totals = true;
    ocr.meta_document_type = 'internal_form';
    updated = true;
    console.log(`  Page ${pageNum}: Flagged as internal form, excluded from totals`);
  }

  if (updated && ocr) {
    row.postProcessOCR = serializeOCR(ocr, pageNum);
  }

  // 9. Sync invoice amounts from postProcessOCR to raw OCR
  // This ensures the raw OCR field also has correct amounts for continuation pages
  const postOcr = parseOCR(row.postProcessOCR);
  const rawOcr = parseOCR(row.OCR);
  if (postOcr && rawOcr) {
    let rawUpdated = false;

    // Copy invoice_total if raw OCR has 0/null but postProcessOCR has a value
    if ((rawOcr.invoice_total === 0 || rawOcr.invoice_total === null || rawOcr.invoice_total === undefined)
        && postOcr.invoice_total > 0) {
      rawOcr.invoice_total = postOcr.invoice_total;
      rawUpdated = true;
    }

    // Also copy amount_paid and amount_due if they're empty
    if ((rawOcr.amount_paid === 0 || rawOcr.amount_paid === null || rawOcr.amount_paid === undefined)
        && postOcr.amount_paid !== undefined) {
      rawOcr.amount_paid = postOcr.amount_paid;
      rawUpdated = true;
    }
    if ((rawOcr.amount_due === 0 || rawOcr.amount_due === null || rawOcr.amount_due === undefined)
        && postOcr.amount_due !== undefined) {
      rawOcr.amount_due = postOcr.amount_due;
      rawUpdated = true;
    }

    if (rawUpdated) {
      row.OCR = serializeRawOCR(rawOcr, row.OCR);
      console.log(`  Page ${pageNum}: Synced amounts from postProcessOCR to raw OCR (invoice_total: ${rawOcr.invoice_total})`);
    }
  }

  return row;
}

// ==================== MAIN ====================
function main() {
  const inputPath = path.join(__dirname, 'data.csv');
  const outputPath = path.join(__dirname, 'data.csv');

  console.log('Reading CSV file...');
  const csvText = fs.readFileSync(inputPath, 'utf8');

  console.log('Parsing CSV...');
  const { headers, data } = parseCSV(csvText);
  console.log(`Parsed ${data.length} rows`);

  console.log('\nApplying updates...');
  let updateCount = 0;
  const updatedData = data.map(row => {
    const originalPostOCR = row.postProcessOCR;
    const updatedRow = applyUpdates(row);
    if (updatedRow.postProcessOCR !== originalPostOCR) {
      updateCount++;
    }
    return updatedRow;
  });

  console.log(`\nUpdated ${updateCount} rows`);

  console.log('\nWriting updated CSV...');
  writeCSV(headers, updatedData, outputPath);

  console.log('Done!');
}

main();
