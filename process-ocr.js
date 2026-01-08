#!/usr/bin/env node

/**
 * OCR Post-Processing Script
 * Reads data.csv, detects multi-page invoices, merges them,
 * and adds postProcessOCR column
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

// ==================== VENDOR NORMALIZATION ====================
function normalizeVendorName(name) {
  if (!name) return '';
  const normalized = name.toLowerCase().trim();
  // Keep Extended Stay America separate from ESA Management L.L.C.
  // Extended Stay America invoices are complete single-page invoices
  // ESA Management L.L.C. invoices may have continuation pages that need merging
  if (normalized.includes('extended stay america') || normalized === 'extended stay') {
    return 'extended_stay_america';
  }
  if (normalized.includes('esa management')) {
    return 'esa_management';
  }
  if (normalized.includes('esa suites')) {
    return 'esa_suites';
  }
  return normalized;
}

function isSameVendor(vendor1, vendor2) {
  return normalizeVendorName(vendor1) === normalizeVendorName(vendor2);
}

// ==================== LINE ITEM DEDUPLICATION ====================
function deduplicateLineItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.date || ''}|${item.description || ''}|${item.amount || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ==================== MERGE LOGIC ====================
function createMergedInvoice(pages, rowDataList) {
  if (pages.length === 0) return null;

  const pageOcrs = pages.map(p => p.ocr);
  const pageRows = pages.map(p => p.row);

  if (pages.length === 1) {
    // Single page - just add merge_info
    return {
      ...pageOcrs[0],
      merge_info: {
        page_count: 1,
        source_pages: [pageOcrs[0]?.meta_source_page || 0],
        was_merged: false,
        merge_reasoning: 'Single-page invoice'
      },
      all_source_file_ids: [pageRows[0]['File ID']],
      all_source_rows: [pageRows[0].Number]
    };
  }

  // Find page with grand total
  const pageWithTotal = pages.find(p => p.ocr?.meta_has_grand_total && (p.ocr?.invoice_total || 0) > 0);
  const totalOcr = pageWithTotal?.ocr || pageOcrs[0];

  // Find page with header info
  const headerPage = pages.find(p => p.ocr?.vendor_id || p.ocr?.bu_code || p.ocr?.processor_name);
  const headerOcr = headerPage?.ocr || pageOcrs[0];

  // Collect all line items
  const allLineItems = [];
  pageOcrs.forEach(ocr => {
    if (ocr?.line_items && ocr.line_items.length > 0) {
      allLineItems.push(...ocr.line_items);
    }
  });
  const mergedLineItems = deduplicateLineItems(allLineItems);

  // Collect confirmation numbers
  const allConfirmations = new Set();
  pageOcrs.forEach(ocr => {
    if (ocr?.confirmation_numbers) {
      ocr.confirmation_numbers.forEach(c => allConfirmations.add(c));
    }
  });

  // Collect cost allocations
  const allCostAllocations = new Set();
  pageOcrs.forEach(ocr => {
    if (ocr?.cost_allocations) {
      ocr.cost_allocations.forEach(c => allCostAllocations.add(typeof c === 'string' ? c : JSON.stringify(c)));
    }
  });

  // Source pages
  const sourcePages = pageOcrs.map(o => o?.meta_source_page || 0).sort((a, b) => a - b);

  // Merge reasoning
  const reasonParts = [];
  if (pageOcrs.some(o => o?.meta_is_continuation_page)) {
    reasonParts.push('Contains continuation pages');
  }
  if (pageOcrs.some(o => o?.meta_has_grand_total)) {
    const totalPage = pageOcrs.find(o => o?.meta_has_grand_total);
    reasonParts.push(`Grand total on page ${totalPage?.meta_source_page}`);
  }
  reasonParts.push(`Pages ${sourcePages.join(', ')}`);

  // Service date range
  const serviceDates = pageOcrs.flatMap(o => [o?.service_start, o?.service_end]).filter(Boolean).sort();

  return {
    meta_confidence: Math.max(...pageOcrs.map(o => o?.meta_confidence || 0)),
    meta_invoice_type: headerOcr?.meta_invoice_type || 'UNKNOWN',
    meta_is_full_invoice: true,
    meta_is_continuation_page: false,
    meta_has_grand_total: true,
    meta_source_page: sourcePages[0],
    meta_source_file: headerOcr?.meta_source_file,
    meta_notes: pageOcrs.flatMap(o => o?.meta_notes || []),

    invoice_number: (headerOcr?.invoice_number && headerOcr.invoice_number !== 'N/A')
      ? headerOcr.invoice_number
      : totalOcr?.invoice_number || 'N/A',
    invoice_date: headerOcr?.invoice_date || totalOcr?.invoice_date,
    due_date: headerOcr?.due_date || totalOcr?.due_date,

    vendor_name: headerOcr?.vendor_name || totalOcr?.vendor_name,
    vendor_id: headerOcr?.vendor_id || totalOcr?.vendor_id,
    vendor_address: headerOcr?.vendor_address || totalOcr?.vendor_address,
    vendor_phone: headerOcr?.vendor_phone || totalOcr?.vendor_phone,
    vendor_email: headerOcr?.vendor_email || totalOcr?.vendor_email,

    payer_name: headerOcr?.payer_name || totalOcr?.payer_name,
    payer_address: headerOcr?.payer_address || totalOcr?.payer_address,

    bu_code: headerOcr?.bu_code || totalOcr?.bu_code,
    processor_name: headerOcr?.processor_name || totalOcr?.processor_name,
    processor_date: headerOcr?.processor_date || totalOcr?.processor_date,

    invoice_total: totalOcr?.invoice_total || 0,
    amount_paid: totalOcr?.amount_paid || 0,
    amount_due: totalOcr?.amount_due || 0,
    taxes: totalOcr?.taxes || 0,

    service_start: serviceDates[0] || null,
    service_end: serviceDates[serviceDates.length - 1] || null,
    service_description: headerOcr?.service_description || totalOcr?.service_description,

    property_name: headerOcr?.property_name || totalOcr?.property_name,
    property_address: headerOcr?.property_address || totalOcr?.property_address,
    unit_count: Math.max(...pageOcrs.map(o => o?.unit_count || 0)),

    line_items: mergedLineItems,
    cost_allocations: [...allCostAllocations].map(c => {
      try { return JSON.parse(c); } catch { return c; }
    }),
    confirmation_numbers: [...allConfirmations],
    employee_names: [...new Set(pageOcrs.flatMap(o => o?.employee_names || []))],
    reference_numbers: [...new Set(pageOcrs.flatMap(o => o?.reference_numbers || []))],

    merge_info: {
      page_count: pages.length,
      source_pages: sourcePages,
      was_merged: true,
      merge_reasoning: reasonParts.join(', ')
    },

    all_source_file_ids: pageRows.map(r => r['File ID']),
    all_source_rows: pageRows.map(r => r.Number)
  };
}

function processInvoices(rows) {
  // First, parse OCR for each row and filter valid ones
  const pagesWithOcr = rows
    .map(row => ({
      row,
      ocr: parseOCR(row.OCR)
    }))
    .filter(p => p.ocr !== null);

  console.log(`Found ${pagesWithOcr.length} rows with valid OCR data`);

  // Sort by source page number
  pagesWithOcr.sort((a, b) => {
    const pageA = a.ocr?.meta_source_page || 0;
    const pageB = b.ocr?.meta_source_page || 0;
    return pageA - pageB;
  });

  // Group pages into invoices
  const invoiceGroups = [];
  let currentGroup = [];

  for (let i = 0; i < pagesWithOcr.length; i++) {
    const current = pagesWithOcr[i];
    const currentOcr = current.ocr;
    const currentPage = currentOcr?.meta_source_page || 0;
    const isContinuation = currentOcr?.meta_is_continuation_page === true;
    const isFullInvoice = currentOcr?.meta_is_full_invoice === true;
    const hasGrandTotal = currentOcr?.meta_has_grand_total === true;
    const invoiceTotal = currentOcr?.invoice_total || 0;

    if (currentGroup.length === 0) {
      currentGroup.push(current);
    } else {
      const prev = currentGroup[currentGroup.length - 1];
      const prevOcr = prev.ocr;
      const prevPage = prevOcr?.meta_source_page || 0;
      const isConsecutive = currentPage === prevPage + 1;

      let shouldMerge = false;

      // STRONG signals to MERGE
      if (isContinuation && isConsecutive && isSameVendor(currentOcr?.vendor_name, prevOcr?.vendor_name)) {
        shouldMerge = true;
      } else if (isConsecutive && isSameVendor(currentOcr?.vendor_name, prevOcr?.vendor_name) && !hasGrandTotal && invoiceTotal === 0) {
        shouldMerge = true;
      } else if (currentOcr?.invoice_number && currentOcr.invoice_number !== 'N/A' &&
                 prevOcr?.invoice_number === currentOcr.invoice_number &&
                 isSameVendor(currentOcr?.vendor_name, prevOcr?.vendor_name)) {
        shouldMerge = true;
      } else if (isContinuation && !currentOcr?.vendor_id && !currentOcr?.bu_code && isConsecutive) {
        const firstInGroup = currentGroup[0];
        if (isSameVendor(currentOcr?.vendor_name, firstInGroup.ocr?.vendor_name)) {
          shouldMerge = true;
        }
      }

      // STRONG signals to NOT MERGE (override)
      if (shouldMerge) {
        // Different invoice numbers
        if (currentOcr?.invoice_number && currentOcr.invoice_number !== 'N/A' &&
            prevOcr?.invoice_number && prevOcr.invoice_number !== 'N/A' &&
            currentOcr.invoice_number !== prevOcr.invoice_number) {
          const firstInGroup = currentGroup[0];
          if (firstInGroup.ocr?.invoice_number !== currentOcr.invoice_number) {
            shouldMerge = false;
          }
        }
        // Both have grand totals
        if (hasGrandTotal && prevOcr?.meta_has_grand_total && invoiceTotal > 0 && (prevOcr?.invoice_total || 0) > 0) {
          shouldMerge = false;
        }
        // Full invoice starting
        if (isFullInvoice && hasGrandTotal && !isContinuation) {
          shouldMerge = false;
        }
        // Different vendor
        if (!isSameVendor(currentOcr?.vendor_name, currentGroup[0].ocr?.vendor_name)) {
          shouldMerge = false;
        }
        // Non-consecutive
        if (!isConsecutive && currentPage > prevPage + 1) {
          shouldMerge = false;
        }
      }

      if (shouldMerge) {
        currentGroup.push(current);

        // If this page has grand total, complete the group
        if (hasGrandTotal && invoiceTotal > 0) {
          invoiceGroups.push([...currentGroup]);
          currentGroup = [];
        }
      } else {
        // Complete previous group and start new one
        if (currentGroup.length > 0) {
          invoiceGroups.push([...currentGroup]);
        }
        currentGroup = [current];
      }
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    invoiceGroups.push(currentGroup);
  }

  console.log(`Grouped into ${invoiceGroups.length} invoices`);

  // Count merged vs single
  const mergedCount = invoiceGroups.filter(g => g.length > 1).length;
  console.log(`${mergedCount} invoices were merged from multiple pages`);

  return invoiceGroups;
}

// ==================== MAIN ====================
function main() {
  const inputPath = path.join(__dirname, 'data.csv');
  const outputPath = path.join(__dirname, 'data.csv');

  console.log('Reading CSV file...');
  const csvText = fs.readFileSync(inputPath, 'utf8');

  console.log('Parsing CSV...');
  const { headers, data } = parseCSV(csvText);
  console.log(`Parsed ${data.length} rows with headers: ${headers.slice(0, 5).join(', ')}...`);

  console.log('Processing invoices for multi-page merge detection...');
  const invoiceGroups = processInvoices(data);

  // Create a map from row number to its postProcessOCR
  const rowToPostProcessOCR = new Map();

  invoiceGroups.forEach(group => {
    const mergedOcr = createMergedInvoice(group, data);

    // For each row in this group, store the merged OCR
    group.forEach(page => {
      const rowNum = page.row.Number;
      rowToPostProcessOCR.set(rowNum, mergedOcr);
    });
  });

  // Add postProcessOCR column to each row
  const newHeaders = [...headers];
  if (!newHeaders.includes('postProcessOCR')) {
    newHeaders.push('postProcessOCR');
  }

  const updatedData = data.map(row => {
    const postOcr = rowToPostProcessOCR.get(row.Number);
    return {
      ...row,
      postProcessOCR: postOcr ? JSON.stringify(postOcr, null, 2) : ''
    };
  });

  console.log(`Writing updated CSV with postProcessOCR column...`);
  writeCSV(newHeaders, updatedData, outputPath);

  console.log('Done!');

  // Print some stats
  const totalMerged = invoiceGroups.filter(g => g.length > 1).reduce((sum, g) => sum + g.length, 0);
  console.log(`\nSummary:`);
  console.log(`- Total rows: ${data.length}`);
  console.log(`- Rows with valid OCR: ${rowToPostProcessOCR.size}`);
  console.log(`- Total invoices after merge: ${invoiceGroups.length}`);
  console.log(`- Multi-page invoices: ${invoiceGroups.filter(g => g.length > 1).length}`);
  console.log(`- Pages merged into multi-page invoices: ${totalMerged}`);
}

main();
