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
  // Treat ESA variations as the same vendor for merging multi-page invoices
  if (normalized.includes('extended stay') || normalized.includes('esa management') || normalized.includes('esa suites')) {
    return 'esa';
  }
  return normalized;
}

function isSameVendor(vendor1, vendor2) {
  return normalizeVendorName(vendor1) === normalizeVendorName(vendor2);
}

/**
 * Checks if vendor name is unknown/missing (OCR couldn't extract it)
 */
function isUnknownVendor(vendorName) {
  if (!vendorName) return true;
  const normalized = vendorName.toLowerCase().trim();
  return normalized === 'unknown' || normalized === '';
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

// ==================== CONTINUATION PAGE DETECTION ====================
/**
 * Determines if a page is effectively a continuation page based on its characteristics.
 * Some pages aren't marked as continuation in OCR but should be treated as such.
 */
function isEffectiveContinuationPage(ocr) {
  if (!ocr) return false;

  // Explicitly marked as continuation
  if (ocr.meta_is_continuation_page === true) return true;

  // Page has no invoice date - likely a continuation/detail page
  const hasNoDate = !ocr.invoice_date || ocr.invoice_date === 'null' || ocr.invoice_date === 'YYYY-MM-DD';

  // Page has no real invoice number (null, N/A, or garbage like "string")
  const hasNoInvoiceNum = !ocr.invoice_number ||
                          ocr.invoice_number === 'N/A' ||
                          ocr.invoice_number === 'null' ||
                          ocr.invoice_number === 'string' ||
                          ocr.invoice_number === 'unknown';

  // No vendor_id suggests it's not a header page
  const hasNoVendorId = !ocr.vendor_id;

  // No bu_code suggests it's not a header page
  const hasNoBuCode = !ocr.bu_code;

  // Unknown vendor name suggests OCR couldn't extract it (likely a summary/billing page)
  const hasUnknownVendor = !ocr.vendor_name ||
                           ocr.vendor_name === 'unknown' ||
                           ocr.vendor_name === 'Unknown';

  // If it has no date AND (no invoice number OR no vendor_id), treat as continuation
  if (hasNoDate && (hasNoInvoiceNum || hasNoVendorId)) {
    return true;
  }

  // NEW: If vendor is unknown AND has no date AND has no vendor_id/bu_code, treat as continuation
  // This catches billing summary pages that don't have header info
  if (hasUnknownVendor && hasNoDate && hasNoVendorId && hasNoBuCode) {
    return true;
  }

  return false;
}

/**
 * Checks if a page is a "header" page (Company Invoice format with full details).
 * Header pages have vendor_id and bu_code and are the start of an invoice.
 */
function isHeaderPage(ocr) {
  if (!ocr) return false;
  return ocr.vendor_id && ocr.bu_code && ocr.invoice_date && !ocr.meta_is_continuation_page;
}

/**
 * Checks if a page is a detail/folio page (9700xxxxx format).
 * These pages are separate invoices unless they're marked as continuation or lack dates.
 */
function isFolioPage(ocr) {
  if (!ocr) return false;
  const invoiceNum = ocr.invoice_number;
  return invoiceNum && /^97\d+$/.test(String(invoiceNum));
}

// ==================== MERGE LOGIC ====================
function createMergedInvoice(pages, rowDataList) {
  if (pages.length === 0) return null;

  // Sort pages by source page number so lower numbers come first
  pages = [...pages].sort((a, b) => {
    const pageA = a.ocr?.meta_source_page || 0;
    const pageB = b.ocr?.meta_source_page || 0;
    return pageA - pageB;
  });

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

  // Find page with grand total - prefer the one with highest invoice_total
  // since continuation pages often have the full invoice total
  const pagesWithTotal = pages.filter(p => p.ocr?.meta_has_grand_total && (p.ocr?.invoice_total || 0) > 0);
  pagesWithTotal.sort((a, b) => (b.ocr?.invoice_total || 0) - (a.ocr?.invoice_total || 0));
  const pageWithTotal = pagesWithTotal[0];
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

    // Use enhanced continuation detection
    const isContinuation = currentOcr?.meta_is_continuation_page === true;
    const isEffectiveCont = isEffectiveContinuationPage(currentOcr);
    const isHeader = isHeaderPage(currentOcr);
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
      const firstInGroup = currentGroup[0];
      const firstOcr = firstInGroup.ocr;

      let shouldMerge = false;

      // STRONG signals to MERGE
      // 1. Explicitly marked as continuation + consecutive + same vendor
      if (isContinuation && isConsecutive && isSameVendor(currentOcr?.vendor_name, prevOcr?.vendor_name)) {
        shouldMerge = true;
      }
      // 2. Consecutive + same vendor + no grand total + zero amount (likely a middle page)
      else if (isConsecutive && isSameVendor(currentOcr?.vendor_name, prevOcr?.vendor_name) && !hasGrandTotal && invoiceTotal === 0) {
        shouldMerge = true;
      }
      // 3. Same invoice number + same vendor
      else if (currentOcr?.invoice_number && currentOcr.invoice_number !== 'N/A' &&
               prevOcr?.invoice_number === currentOcr.invoice_number &&
               isSameVendor(currentOcr?.vendor_name, prevOcr?.vendor_name)) {
        shouldMerge = true;
      }
      // 4. Continuation page (marked or effective) + missing vendor_id/bu_code + consecutive
      else if ((isContinuation || isEffectiveCont) && !currentOcr?.vendor_id && !currentOcr?.bu_code && isConsecutive) {
        // Allow merge if same vendor OR if current page has unknown vendor (OCR couldn't extract it)
        if (isSameVendor(currentOcr?.vendor_name, firstOcr?.vendor_name) || isUnknownVendor(currentOcr?.vendor_name)) {
          shouldMerge = true;
        }
      }
      // 5. NEW: Effective continuation page (no date, no vendor_id) + consecutive + same vendor
      // This catches pages that aren't marked as continuation but clearly are detail/folio pages
      else if (isEffectiveCont && isConsecutive && isSameVendor(currentOcr?.vendor_name, firstOcr?.vendor_name)) {
        // Only merge if the first page in group is a header page
        if (isHeaderPage(firstOcr)) {
          shouldMerge = true;
        }
      }
      // 6. NEW: Folio pages (9700xxx) following a header page should merge if consecutive and same vendor
      // These are detail pages that show individual guest stays for the same invoice
      else if (isFolioPage(currentOcr) && isConsecutive && isSameVendor(currentOcr?.vendor_name, firstOcr?.vendor_name)) {
        // Only merge folio pages if the first page is a header (not another folio)
        // and the current page doesn't have vendor_id (indicating it's a detail, not standalone)
        if (isHeaderPage(firstOcr) && !currentOcr?.vendor_id) {
          shouldMerge = true;
        }
      }
      // 7. NEW: Folio pages with same bu_code as the header should merge
      // Even if they have different folio invoice numbers, they belong to the same Company Invoice
      else if (isFolioPage(currentOcr) && isConsecutive &&
               currentOcr?.bu_code && firstOcr?.bu_code &&
               currentOcr.bu_code === firstOcr.bu_code &&
               !currentOcr?.vendor_id &&
               isSameVendor(currentOcr?.vendor_name, firstOcr?.vendor_name)) {
        shouldMerge = true;
      }
      // 8. NEW: Pages with unknown vendor that are effectively continuation pages
      // Consecutive pages + same invoice type + current page has unknown vendor + no header info
      // This catches billing summary pages where OCR couldn't extract vendor info
      else if (isEffectiveCont && isConsecutive && isUnknownVendor(currentOcr?.vendor_name) &&
               currentOcr?.meta_invoice_type === firstOcr?.meta_invoice_type &&
               !currentOcr?.vendor_id && !currentOcr?.bu_code) {
        shouldMerge = true;
      }

      // STRONG signals to NOT MERGE (override)
      if (shouldMerge) {
        // Override 1: Current page is a new header page (has vendor_id, bu_code, date)
        // Header pages always start new invoices
        if (isHeader && !isContinuation) {
          shouldMerge = false;
        }
        // Override 2: Different invoice numbers - but skip for continuation/effective continuation pages
        else if (!isContinuation && !isEffectiveCont &&
            currentOcr?.invoice_number && currentOcr.invoice_number !== 'N/A' &&
            firstOcr?.invoice_number && firstOcr.invoice_number !== 'N/A' &&
            currentOcr.invoice_number !== firstOcr.invoice_number &&
            !isFolioPage(currentOcr)) {
          shouldMerge = false;
        }
        // Override 3: Both current and previous have grand totals with positive amounts
        // (unless current is a continuation/effective continuation, or a folio page following a header)
        else if (!isContinuation && !isEffectiveCont && hasGrandTotal &&
                 prevOcr?.meta_has_grand_total && invoiceTotal > 0 &&
                 (prevOcr?.invoice_total || 0) > 0) {
          // Don't apply this override for folio pages that share bu_code with the header
          const isFolioWithSameBuCode = isFolioPage(currentOcr) &&
                                         currentOcr?.bu_code && firstOcr?.bu_code &&
                                         currentOcr.bu_code === firstOcr.bu_code;
          if (!isFolioWithSameBuCode) {
            shouldMerge = false;
          }
        }
        // Override 4: Different vendor from the first page in group
        // But allow unknown vendor pages to merge (they're likely continuation pages with missing vendor info)
        if (!isSameVendor(currentOcr?.vendor_name, firstOcr?.vendor_name) && !isUnknownVendor(currentOcr?.vendor_name)) {
          shouldMerge = false;
        }
        // Override 5: Non-consecutive pages
        if (!isConsecutive && currentPage > prevPage + 1) {
          shouldMerge = false;
        }
      }

      if (shouldMerge) {
        currentGroup.push(current);

        // Complete the group when we hit a page with grand total
        // But only if it's the last folio page (has grand total with positive amount)
        // and not followed by another continuation/folio page that belongs to the same invoice
        if (hasGrandTotal && invoiceTotal > 0 && !isEffectiveCont) {
          // Peek at next page - if it's a continuation or folio page of same invoice, don't complete yet
          const nextPage = pagesWithOcr[i + 1];
          const nextOcr = nextPage?.ocr;
          const nextIsConsecutive = nextOcr && (nextOcr.meta_source_page === currentPage + 1);
          const nextIsEffectiveCont = nextOcr && isEffectiveContinuationPage(nextOcr);
          const nextIsSameVendor = nextOcr && isSameVendor(nextOcr.vendor_name, firstOcr?.vendor_name);
          const nextIsFolio = nextOcr && isFolioPage(nextOcr);
          const nextHasSameBuCode = nextOcr && nextOcr.bu_code && firstOcr?.bu_code &&
                                    nextOcr.bu_code === firstOcr.bu_code;
          const nextIsNewHeader = nextOcr && isHeaderPage(nextOcr);

          // Don't complete if next page is:
          // 1. An effective continuation of same vendor
          // 2. A folio page with same bu_code (part of same invoice) that's not a new header
          const shouldContinue = nextIsConsecutive && nextIsSameVendor &&
            (nextIsEffectiveCont || (nextIsFolio && nextHasSameBuCode && !nextIsNewHeader && !nextOcr.vendor_id));

          if (!shouldContinue) {
            invoiceGroups.push([...currentGroup]);
            currentGroup = [];
          }
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
