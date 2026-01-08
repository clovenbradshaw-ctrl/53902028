#!/usr/bin/env node

/**
 * Ledger + OCR Invoice Merge Script
 *
 * This script merges two data sources:
 * 1. ledger.csv - Raw export from Metro Nashville's financial system (source of truth)
 * 2. data.csv - OCR-extracted data from scanned invoice PDFs
 *
 * The merged output clearly identifies which fields came from:
 * - LEDGER: Authoritative financial data (amounts, dates, vendor IDs)
 * - OCR: Supplementary data from scanned documents (line items, confirmation numbers)
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

// ==================== VENDOR NAME NORMALIZATION ====================
/**
 * Maps OCR vendor names to ledger vendor names
 * This is critical for matching invoices between data sources
 */
const VENDOR_MAPPINGS = {
  // ESA variations -> ESA MANAGEMENT LLC
  'extended stay america': 'ESA MANAGEMENT LLC',
  'esa management l.l.c.': 'ESA MANAGEMENT LLC',
  'esa management llc': 'ESA MANAGEMENT LLC',
  'esa management': 'ESA MANAGEMENT LLC',
  'esa suites': 'ESA MANAGEMENT LLC',
  'esa': 'ESA MANAGEMENT LLC',

  // The Ave variations
  'the ave': 'THE AVE NASHVILLE LLC',
  'the ave nashville': 'THE AVE NASHVILLE LLC',
  'the ave nashville llc': 'THE AVE NASHVILLE LLC',

  // Hillside Crossing variations
  'hillside crossing hotel': 'HILLSIDE CROSSING LLC',
  'hillside crossing llc': 'HILLSIDE CROSSING LLC',
  'hillside crossing': 'HILLSIDE CROSSING LLC',

  // Randstad variations
  'randstad': 'Randstad North America Inc dba Randstad USA LLC',
  'randstad usa': 'Randstad North America Inc dba Randstad USA LLC',
  'randstad north america': 'Randstad North America Inc dba Randstad USA LLC',

  // Depaul
  'depaul usa': 'Depaul USA',
  'depaul': 'Depaul USA',

  // Community Care Fellowship
  'community care fellowship, inc.': 'COMMUNITY CARE FELLOWSHIP',
  'community care fellowship': 'COMMUNITY CARE FELLOWSHIP',

  // RJ Young variations
  'rj young': 'RJ Young Company LLC',
  'r.j. young': 'RJ Young Company LLC',
  'robert j young company': 'RJ Young Company LLC',
  'rj young company llc': 'RJ Young Company LLC',

  // Grainger variations
  'grainger': '"W.W. Grainger, Inc. dba Grainger"',
  'w.w. grainger': '"W.W. Grainger, Inc. dba Grainger"',
  'w.w. grainger, inc.': '"W.W. Grainger, Inc. dba Grainger"',
  'w.w. grainger, inc. dba grainger': '"W.W. Grainger, Inc. dba Grainger"',

  // 97 Wallace Studios
  '97 wallace studios, llc': '97 WALLACE STUDIOS',
  '97 wallace studios': '97 WALLACE STUDIOS',

  // Thompson Machinery
  'thompson machinery': 'Thompson Machinery Commerce Corp.',
  'thompson machinery commerce corp.': 'Thompson Machinery Commerce Corp.',

  // Gordon Food Service variations
  'gordon food service inc.': '"Gordon Food Service, Inc."',
  'gordon food service': '"Gordon Food Service, Inc."',
  'gordon food service store': '"Gordon Food Service, Inc."',
  'gordon food service, inc.': '"Gordon Food Service, Inc."',

  // Hamilton variations
  'j hamilton': '"Hamilton, Justen T"',
  'hamilton, justen t': '"Hamilton, Justen T"',
  'justen hamilton': '"Hamilton, Justen T"',

  // Hospitality Hub
  'the hospitality hub of memphis': 'The Hospitality Hub of Memphis',
  'hospitality hub': 'The Hospitality Hub of Memphis',
};

function normalizeVendorForLedgerMatch(vendorName) {
  if (!vendorName) return '';
  const lower = vendorName.toLowerCase().trim();
  return VENDOR_MAPPINGS[lower] || vendorName;
}

function normalizeInvoiceNumber(invoiceNum) {
  if (!invoiceNum) return '';
  // Remove leading zeros, spaces, special characters for comparison
  return String(invoiceNum).trim().replace(/^0+/, '').toUpperCase();
}

function normalizeDate(dateStr) {
  if (!dateStr) return '';
  // Handle various date formats and normalize to YYYY-MM-DD
  const str = String(dateStr).trim();

  // ISO format: 2024-09-01
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // US format: 9/1/2024 or 09/01/2024
  const usMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const month = usMatch[1].padStart(2, '0');
    const day = usMatch[2].padStart(2, '0');
    const year = usMatch[3];
    return `${year}-${month}-${day}`;
  }

  return str;
}

// ==================== LEDGER PARSING ====================
function parseLedgerEntry(row) {
  const explanation = row['Explanation'] || row['Account Number'] || '';
  const docType = row['Document Type'] || '';

  // Parse the amount from the Total field
  let amount = 0;
  const totalStr = row['Total'] || '';
  const amountMatch = totalStr.match(/\$?([\d,]+\.?\d*)/);
  if (amountMatch) {
    amount = parseFloat(amountMatch[1].replace(/,/g, ''));
  }

  // Determine if this is a debit or credit
  const debit = parseFloat((row['Debit'] || '0').replace(/[$,]/g, '')) || 0;
  const credit = parseFloat((row['Credit'] || '0').replace(/[$,]/g, '')) || 0;

  return {
    // Source identification
    data_source: 'LEDGER',

    // Document identification
    document_type: docType,
    document_number: row['Document Number'] || row['Doc Number'] || '',
    batch_type: row['Batch Type'] || '',
    batch_number: row['Batch Num'] || '',
    batch_date: row['Batch Date'] || '',
    line_number: row['Line Number'] || '',

    // Vendor information
    vendor_name: row['Vendor'] || row['address book name'] || '',
    vendor_id: row['Address Book #'] || '',

    // Invoice information
    invoice_number: row['Invoice Number'] || row['Invoice'] || '',
    invoice_date: row['Invoice Date'] || '',
    payment_date: row['Payment Date'] || '',
    gl_date: row['GL Date'] || '',
    effective_date: row['Jl Effective Date'] || '',

    // Financial details
    amount: amount,
    debit: debit,
    credit: credit,

    // Account information
    account_number: row['Account Number'] || '',
    gl_account_string: row['Gl Account String'] || '',
    business_unit: row['Business Unit'] || row['business unit number'] || '',
    fund: row['Fund'] || '',
    object_account: row['Object Account'] || '',
    object_account_descr: row['Object Account Descr'] || '',
    sub_account: row['Sub Account'] || '',
    sub_account_type: row['Sub Acct Type'] || '',

    // Category information
    je_category: row['Je Category Name'] || row['JE Category Name_'] || '',
    explanation: row['Explanation'] || '',
    label: row['Label'] || '',

    // Metadata
    created: row['Created'] || '',
    last_updated_by: row['last updated by'] || '',
    business_unit_title: row['Business Unit Title (from Business Unit)'] || '',

    // Raw row for reference
    _raw_ledger_row: row
  };
}

// ==================== OCR PARSING ====================
function parseOCR(ocrField) {
  if (!ocrField) return null;
  try {
    let cleaned = ocrField.replace(/^Image \d+ of \d+\s*\n?/i, '');
    cleaned = cleaned.replace(/```json\n?/g, '').replace(/```/g, '').trim();
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

// ==================== MERGE LOGIC ====================
function createMergedRecord(ledgerEntry, ocrData, matchInfo) {
  const merged = {
    // === DATA SOURCE TRACKING ===
    _data_sources: {
      ledger: !!ledgerEntry,
      ocr: !!ocrData,
      match_type: matchInfo?.type || 'none',
      match_confidence: matchInfo?.confidence || 0,
      match_notes: matchInfo?.notes || ''
    },

    // === LEDGER DATA (Source of Truth) ===
    ledger: ledgerEntry ? {
      document_type: ledgerEntry.document_type,
      document_number: ledgerEntry.document_number,
      vendor_name: ledgerEntry.vendor_name,
      vendor_id: ledgerEntry.vendor_id,
      invoice_number: ledgerEntry.invoice_number,
      invoice_date: ledgerEntry.invoice_date,
      payment_date: ledgerEntry.payment_date,
      gl_date: ledgerEntry.gl_date,
      amount: ledgerEntry.amount,
      debit: ledgerEntry.debit,
      credit: ledgerEntry.credit,
      object_account: ledgerEntry.object_account,
      object_account_descr: ledgerEntry.object_account_descr,
      business_unit: ledgerEntry.business_unit,
      fund: ledgerEntry.fund,
      je_category: ledgerEntry.je_category,
      explanation: ledgerEntry.explanation,
      batch_type: ledgerEntry.batch_type,
      batch_number: ledgerEntry.batch_number,
      batch_date: ledgerEntry.batch_date,
      created: ledgerEntry.created,
      last_updated_by: ledgerEntry.last_updated_by
    } : null,

    // === OCR DATA (Supplementary) ===
    ocr: ocrData ? {
      meta_confidence: ocrData.meta_confidence,
      meta_invoice_type: ocrData.meta_invoice_type,
      meta_source_page: ocrData.meta_source_page,
      meta_source_file: ocrData.meta_source_file,
      meta_notes: ocrData.meta_notes,

      invoice_number: ocrData.invoice_number,
      invoice_date: ocrData.invoice_date,
      due_date: ocrData.due_date,

      vendor_name: ocrData.vendor_name,
      vendor_id: ocrData.vendor_id,
      vendor_address: ocrData.vendor_address,
      vendor_phone: ocrData.vendor_phone,
      vendor_email: ocrData.vendor_email,

      payer_name: ocrData.payer_name,
      payer_address: ocrData.payer_address,

      bu_code: ocrData.bu_code,
      processor_name: ocrData.processor_name,
      processor_date: ocrData.processor_date,

      invoice_total: ocrData.invoice_total,
      amount_paid: ocrData.amount_paid,
      amount_due: ocrData.amount_due,
      taxes: ocrData.taxes,

      service_start: ocrData.service_start,
      service_end: ocrData.service_end,
      service_description: ocrData.service_description,

      property_name: ocrData.property_name,
      property_address: ocrData.property_address,
      unit_count: ocrData.unit_count,

      line_items: ocrData.line_items,
      cost_allocations: ocrData.cost_allocations,
      confirmation_numbers: ocrData.confirmation_numbers,
      employee_names: ocrData.employee_names,
      reference_numbers: ocrData.reference_numbers,

      merge_info: ocrData.merge_info,
      all_source_file_ids: ocrData.all_source_file_ids,
      all_source_rows: ocrData.all_source_rows
    } : null,

    // === UNIFIED VIEW (best available from either source) ===
    unified: {
      vendor_name: ledgerEntry?.vendor_name || ocrData?.vendor_name || '',
      invoice_number: ledgerEntry?.invoice_number || ocrData?.invoice_number || '',
      invoice_date: ledgerEntry?.invoice_date || ocrData?.invoice_date || '',
      amount: ledgerEntry?.amount || ocrData?.invoice_total || 0,
      payment_date: ledgerEntry?.payment_date || '',
      category: ledgerEntry?.object_account_descr || ocrData?.meta_invoice_type || '',

      // OCR-only enrichments
      line_items: ocrData?.line_items || [],
      confirmation_numbers: ocrData?.confirmation_numbers || [],
      employee_names: ocrData?.employee_names || [],
      service_period: ocrData ? `${ocrData.service_start || ''} to ${ocrData.service_end || ''}`.trim() : ''
    }
  };

  return merged;
}

// ==================== MATCHING ALGORITHM ====================
function matchInvoices(ledgerEntries, ocrInvoices) {
  const matches = [];
  const unmatchedLedger = [...ledgerEntries];
  const unmatchedOcr = [...ocrInvoices];

  // Build lookup indexes for OCR data
  const ocrByInvoiceNum = new Map();
  const ocrByVendorAndDate = new Map();

  ocrInvoices.forEach((ocr, idx) => {
    const invoiceNum = normalizeInvoiceNumber(ocr.invoice_number);
    if (invoiceNum && invoiceNum !== 'N/A') {
      if (!ocrByInvoiceNum.has(invoiceNum)) {
        ocrByInvoiceNum.set(invoiceNum, []);
      }
      ocrByInvoiceNum.get(invoiceNum).push({ ocr, idx });
    }

    // Index by vendor + date
    const normalizedVendor = normalizeVendorForLedgerMatch(ocr.vendor_name);
    const dateKey = `${normalizedVendor}|${ocr.invoice_date}`;
    if (!ocrByVendorAndDate.has(dateKey)) {
      ocrByVendorAndDate.set(dateKey, []);
    }
    ocrByVendorAndDate.get(dateKey).push({ ocr, idx });
  });

  // Pass 1: Match by invoice number (strongest match)
  ledgerEntries.forEach((ledger, ledgerIdx) => {
    if (ledger.document_type !== 'Invoice') return;

    const ledgerInvoiceNum = normalizeInvoiceNumber(ledger.invoice_number);
    if (!ledgerInvoiceNum) return;

    const candidates = ocrByInvoiceNum.get(ledgerInvoiceNum) || [];

    for (const { ocr, idx } of candidates) {
      // Also verify vendor matches
      const normalizedOcrVendor = normalizeVendorForLedgerMatch(ocr.vendor_name);
      const ledgerVendor = ledger.vendor_name;

      if (normalizedOcrVendor.toUpperCase() === ledgerVendor.toUpperCase() ||
          normalizedOcrVendor === ledgerVendor) {
        matches.push({
          ledger,
          ocr,
          matchInfo: {
            type: 'invoice_number',
            confidence: 0.95,
            notes: `Matched by invoice number: ${ledgerInvoiceNum}`
          }
        });

        // Remove from unmatched lists
        const ledgerUnmatchedIdx = unmatchedLedger.indexOf(ledger);
        if (ledgerUnmatchedIdx > -1) unmatchedLedger.splice(ledgerUnmatchedIdx, 1);
        const ocrUnmatchedIdx = unmatchedOcr.findIndex(o => o === ocr);
        if (ocrUnmatchedIdx > -1) unmatchedOcr.splice(ocrUnmatchedIdx, 1);

        return; // Only one match per ledger entry
      }
    }
  });

  // Pass 2: Match by vendor + invoice date + amount (for remaining)
  unmatchedLedger.filter(l => l.document_type === 'Invoice').forEach(ledger => {
    const ledgerVendor = ledger.vendor_name;
    const ledgerDate = normalizeDate(ledger.invoice_date);
    const ledgerAmount = Math.round((ledger.debit || 0) * 100); // Amount in cents for comparison

    if (!ledgerDate) return;

    // Look for OCR records with same vendor, matching date, AND matching amount
    for (const ocr of unmatchedOcr) {
      const normalizedOcrVendor = normalizeVendorForLedgerMatch(ocr.vendor_name);
      const ocrDate = normalizeDate(ocr.invoice_date);
      const ocrAmount = Math.round((ocr.invoice_total || 0) * 100); // Amount in cents

      if (normalizedOcrVendor.toUpperCase() === ledgerVendor.toUpperCase() &&
          ledgerDate === ocrDate &&
          ledgerAmount === ocrAmount) {
        matches.push({
          ledger,
          ocr,
          matchInfo: {
            type: 'vendor_date_amount',
            confidence: 0.85,
            notes: `Matched by vendor (${ledgerVendor}), invoice date (${ledgerDate}), and amount ($${(ledgerAmount / 100).toFixed(2)})`
          }
        });

        const ocrUnmatchedIdx = unmatchedOcr.findIndex(o => o === ocr);
        if (ocrUnmatchedIdx > -1) unmatchedOcr.splice(ocrUnmatchedIdx, 1);
        const ledgerUnmatchedIdx = unmatchedLedger.indexOf(ledger);
        if (ledgerUnmatchedIdx > -1) unmatchedLedger.splice(ledgerUnmatchedIdx, 1);

        break;
      }
    }
  });

  return { matches, unmatchedLedger, unmatchedOcr };
}

// ==================== MAIN ====================
function main() {
  const ledgerPath = path.join(__dirname, 'ledger.csv');
  const dataPath = path.join(__dirname, 'data.csv');
  const outputPath = path.join(__dirname, 'merged-data.json');
  const summaryPath = path.join(__dirname, 'merge-summary.json');

  console.log('=== Ledger + OCR Invoice Merge ===\n');

  // Read and parse ledger
  console.log('Reading ledger.csv...');
  const ledgerText = fs.readFileSync(ledgerPath, 'utf8');
  const { data: ledgerRaw } = parseCSV(ledgerText);
  console.log(`  Parsed ${ledgerRaw.length} ledger entries`);

  // Parse ledger entries
  const ledgerEntries = ledgerRaw.map(parseLedgerEntry);
  const invoiceEntries = ledgerEntries.filter(e => e.document_type === 'Invoice');
  const journalEntries = ledgerEntries.filter(e => e.document_type === 'Journal');
  console.log(`  - ${invoiceEntries.length} Invoice entries (vendor invoices)`);
  console.log(`  - ${journalEntries.length} Journal entries (payroll)`);

  // Read and parse OCR data
  console.log('\nReading data.csv...');
  const dataText = fs.readFileSync(dataPath, 'utf8');
  const { data: ocrRaw } = parseCSV(dataText);
  console.log(`  Parsed ${ocrRaw.length} OCR rows`);

  // Extract unique invoices from postProcessOCR
  const ocrInvoices = [];
  const seenInvoices = new Set();

  ocrRaw.forEach(row => {
    const postOcr = parseOCR(row.postProcessOCR);
    if (postOcr) {
      // Use the first source row as the unique key
      const key = postOcr.all_source_rows?.[0] || row.Number;
      if (!seenInvoices.has(key)) {
        seenInvoices.add(key);
        ocrInvoices.push(postOcr);
      }
    }
  });
  console.log(`  Extracted ${ocrInvoices.length} unique invoices from OCR`);

  // Match invoices
  console.log('\nMatching ledger entries to OCR data...');
  const { matches, unmatchedLedger, unmatchedOcr } = matchInvoices(invoiceEntries, ocrInvoices);
  console.log(`  - ${matches.length} matched invoice pairs`);
  console.log(`  - ${unmatchedLedger.filter(l => l.document_type === 'Invoice').length} unmatched ledger invoices`);
  console.log(`  - ${unmatchedOcr.length} unmatched OCR invoices`);

  // Create merged output
  const mergedData = {
    _metadata: {
      generated_at: new Date().toISOString(),
      ledger_source: 'ledger.csv',
      ocr_source: 'data.csv',
      description: 'Merged financial data from Metro Nashville ledger (source of truth) and OCR-extracted invoice scans',
      data_source_legend: {
        LEDGER: 'Authoritative data from Metro Nashville financial system - use for amounts, dates, vendor IDs',
        OCR: 'Supplementary data from scanned invoice PDFs - provides line items, confirmation numbers, service details'
      }
    },

    // Matched invoice records (have both ledger and OCR data)
    matched_invoices: matches.map(m => createMergedRecord(m.ledger, m.ocr, m.matchInfo)),

    // Ledger-only records (no matching OCR scan found)
    ledger_only: {
      invoices: unmatchedLedger.filter(l => l.document_type === 'Invoice').map(l =>
        createMergedRecord(l, null, { type: 'ledger_only', confidence: 1, notes: 'No matching OCR scan found' })
      ),
      journals: journalEntries.map(j => ({
        data_source: 'LEDGER',
        type: 'PAYROLL',
        ...j
      }))
    },

    // OCR-only records (not found in ledger)
    ocr_only: unmatchedOcr.map(o =>
      createMergedRecord(null, o, { type: 'ocr_only', confidence: 0.5, notes: 'Not found in ledger - may be internal form or processing document' })
    )
  };

  // Write merged data
  console.log(`\nWriting merged data to ${outputPath}...`);
  fs.writeFileSync(outputPath, JSON.stringify(mergedData, null, 2), 'utf8');

  // Generate summary statistics
  const summary = {
    generated_at: new Date().toISOString(),

    ledger_stats: {
      total_entries: ledgerEntries.length,
      invoice_entries: invoiceEntries.length,
      journal_entries: journalEntries.length,
      unique_vendors: [...new Set(invoiceEntries.map(e => e.vendor_name))].sort(),
      total_invoice_amount: invoiceEntries.reduce((sum, e) => sum + (e.debit || 0), 0).toFixed(2),
      total_payroll_amount: journalEntries.reduce((sum, e) => sum + (e.debit || 0), 0).toFixed(2)
    },

    ocr_stats: {
      total_pages: ocrRaw.length,
      unique_invoices: ocrInvoices.length,
      unique_vendors: [...new Set(ocrInvoices.map(o => o.vendor_name))].filter(Boolean).sort(),
      total_ocr_amount: ocrInvoices.reduce((sum, o) => sum + (o.invoice_total || 0), 0).toFixed(2)
    },

    match_stats: {
      matched_pairs: matches.length,
      unmatched_ledger_invoices: unmatchedLedger.filter(l => l.document_type === 'Invoice').length,
      unmatched_ocr_invoices: unmatchedOcr.length,
      match_rate_ledger: (matches.length / invoiceEntries.length * 100).toFixed(1) + '%',
      match_rate_ocr: (matches.length / ocrInvoices.length * 100).toFixed(1) + '%',

      by_match_type: {
        invoice_number: matches.filter(m => m.matchInfo.type === 'invoice_number').length,
        vendor_date_amount: matches.filter(m => m.matchInfo.type === 'vendor_date_amount').length
      }
    },

    vendor_breakdown: {
      ledger_vendors: invoiceEntries.reduce((acc, e) => {
        acc[e.vendor_name] = (acc[e.vendor_name] || 0) + 1;
        return acc;
      }, {}),
      ocr_vendors: ocrInvoices.reduce((acc, o) => {
        const v = o.vendor_name || 'unknown';
        acc[v] = (acc[v] || 0) + 1;
        return acc;
      }, {})
    }
  };

  console.log(`Writing summary to ${summaryPath}...`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  // Print summary
  console.log('\n=== MERGE SUMMARY ===');
  console.log(`\nLedger Data:`);
  console.log(`  Total entries: ${summary.ledger_stats.total_entries}`);
  console.log(`  Invoice entries: ${summary.ledger_stats.invoice_entries}`);
  console.log(`  Journal (payroll) entries: ${summary.ledger_stats.journal_entries}`);
  console.log(`  Total invoice amount: $${summary.ledger_stats.total_invoice_amount}`);
  console.log(`  Total payroll amount: $${summary.ledger_stats.total_payroll_amount}`);

  console.log(`\nOCR Data:`);
  console.log(`  Total pages scanned: ${summary.ocr_stats.total_pages}`);
  console.log(`  Unique invoices: ${summary.ocr_stats.unique_invoices}`);
  console.log(`  Total OCR amount: $${summary.ocr_stats.total_ocr_amount}`);

  console.log(`\nMatch Results:`);
  console.log(`  Successfully matched: ${summary.match_stats.matched_pairs} pairs`);
  console.log(`  Ledger match rate: ${summary.match_stats.match_rate_ledger}`);
  console.log(`  OCR match rate: ${summary.match_stats.match_rate_ocr}`);
  console.log(`  By invoice number: ${summary.match_stats.by_match_type.invoice_number}`);
  console.log(`  By vendor + date + amount: ${summary.match_stats.by_match_type.vendor_date_amount}`);

  console.log('\n=== Done! ===');
  console.log(`Output files:`);
  console.log(`  - ${outputPath} (full merged data)`);
  console.log(`  - ${summaryPath} (statistics)`);
}

main();
