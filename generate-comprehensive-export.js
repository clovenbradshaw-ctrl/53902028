#!/usr/bin/env node

/**
 * Comprehensive JSON Export Generator
 *
 * Generates a complete export of all invoice data from Metro Nashville BU 53902028
 * (Office of Homeless Services) with:
 * - Full definitions explaining OCR invoice scans vs R12 Ledger data
 * - Google Drive links to source documents
 * - Connected ledger/OCR records where matches exist
 * - Separate sections for unmatched records
 * - Complete metadata and field documentation
 */

const fs = require('fs');
const path = require('path');

// ==================== GOOGLE DRIVE URL BUILDER ====================
const GOOGLE_DRIVE_BASE_URL = 'https://drive.google.com/open?id=';
const GOOGLE_DRIVE_VIEW_URL = 'https://drive.google.com/file/d/';

function buildGoogleDriveUrl(fileId) {
  if (!fileId) return null;
  return `${GOOGLE_DRIVE_BASE_URL}${fileId}`;
}

function buildGoogleDriveViewUrl(fileId) {
  if (!fileId) return null;
  return `${GOOGLE_DRIVE_VIEW_URL}${fileId}/view`;
}

// ==================== LOAD DATA ====================
function loadMergedData() {
  const mergedPath = path.join(__dirname, 'merged-data.json');
  return JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
}

function loadOcrInvoices() {
  const ocrPath = path.join(__dirname, 'ocr-invoices.json');
  return JSON.parse(fs.readFileSync(ocrPath, 'utf8'));
}

function loadLedgerInvoices() {
  const ledgerPath = path.join(__dirname, 'ledger-invoices.json');
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

function loadMergeSummary() {
  const summaryPath = path.join(__dirname, 'merge-summary.json');
  return JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
}

// ==================== ENHANCE RECORDS WITH GOOGLE DRIVE LINKS ====================
function enhanceOcrWithDriveLinks(ocrRecord) {
  if (!ocrRecord) return null;

  const enhanced = { ...ocrRecord };

  // Add Google Drive URLs for each source file
  if (ocrRecord.all_source_file_ids && ocrRecord.all_source_file_ids.length > 0) {
    enhanced.google_drive_links = ocrRecord.all_source_file_ids.map((fileId, idx) => ({
      file_id: fileId,
      page_number: ocrRecord.all_source_rows ? ocrRecord.all_source_rows[idx] : null,
      open_url: buildGoogleDriveUrl(fileId),
      view_url: buildGoogleDriveViewUrl(fileId)
    }));

    // Add primary link
    enhanced.primary_google_drive_url = buildGoogleDriveUrl(ocrRecord.all_source_file_ids[0]);
  }

  return enhanced;
}

// ==================== BUILD COMPREHENSIVE EXPORT ====================
function generateComprehensiveExport() {
  console.log('Loading data files...');

  const mergedData = loadMergedData();
  const ocrInvoices = loadOcrInvoices();
  const ledgerInvoices = loadLedgerInvoices();
  const mergeSummary = loadMergeSummary();

  console.log(`  - Merged data: ${mergedData.matched_invoices.length} matched pairs`);
  console.log(`  - OCR invoices: ${ocrInvoices.invoices.length} records`);
  console.log(`  - Ledger invoices: ${ledgerInvoices.invoices.length} invoice records`);
  console.log(`  - Ledger journals: ${ledgerInvoices.journals.length} payroll records`);

  const comprehensiveExport = {
    // ==================== METADATA & DOCUMENTATION ====================
    _documentation: {
      export_generated: new Date().toISOString(),
      export_version: "2.0.0",
      business_unit: "53902028",
      department: "Metro Nashville Office of Homeless Services (OHS)",

      overview: {
        title: "Comprehensive Invoice Data Export",
        description: "This export contains all financial invoice data for Metro Nashville Business Unit 53902028 (Office of Homeless Services). Data comes from two primary sources that have been merged where possible.",
        purpose: "Provide complete visibility into both the authoritative financial records (ledger) and the detailed invoice scans (OCR) with clear documentation of how they relate."
      },

      data_sources: {
        ledger_r12: {
          name: "Metro Nashville R12 Ledger Export",
          description: "Raw export from Metro Nashville's R12 financial/accounting system (Oracle E-Business Suite R12). This is the AUTHORITATIVE source of truth for all financial amounts, payment dates, and vendor IDs.",
          source_file: "ledger.csv",
          authority_level: "PRIMARY - Use for official financial reconciliation",
          key_characteristics: [
            "Contains only transactions that have been officially processed and posted",
            "Includes document numbers assigned by the financial system",
            "Amounts are authoritative and audited",
            "Contains GL account coding and fund allocation",
            "Includes batch processing information (KOFAX batch numbers)",
            "Has audit trail (created date, last updated by)"
          ],
          fields_provided: [
            "document_type - Type of transaction (Invoice, Journal)",
            "document_number - R12 system-assigned document ID",
            "vendor_name - Official vendor name from R12 vendor master",
            "vendor_id - R12 address book/vendor ID",
            "invoice_number - Vendor's invoice number",
            "invoice_date - Date on vendor's invoice",
            "payment_date - Date payment was scheduled/made",
            "gl_date - General Ledger posting date",
            "amount/debit/credit - Financial amounts (debit is positive spend)",
            "object_account - GL expense category (e.g., 'Care of Persons', 'Temporary Service')",
            "business_unit - Org code (53902028 = OHS)",
            "fund - Budget fund code",
            "je_category - Journal entry category",
            "batch_type/batch_number - KOFAX invoice processing batch info"
          ]
        },

        ocr_invoice_scans: {
          name: "OCR-Extracted Invoice Data",
          description: "Data extracted via OCR (Optical Character Recognition) from scanned PDF invoice images. Provides rich detail about invoice contents including line items, employee names, confirmation numbers, and service details not available in the ledger.",
          source_file: "data.csv (derived from Finance_BU_53902028_Invoices.pdf)",
          authority_level: "SUPPLEMENTARY - Use for detailed invoice content",
          key_characteristics: [
            "Contains detailed line-item breakdowns",
            "Includes employee names (for staffing invoices)",
            "Has confirmation/reference numbers",
            "Provides service date ranges",
            "Contains property/location details (for hotel invoices)",
            "Includes cost allocation breakdowns from invoice",
            "May contain documents not yet posted to ledger",
            "May contain internal processing forms (not actual invoices)",
            "OCR confidence scores indicate extraction reliability"
          ],
          fields_provided: [
            "meta_confidence - OCR extraction confidence (0-1 scale)",
            "meta_invoice_type - Categorized type (HOTEL, STAFFING, RENTAL, etc.)",
            "meta_source_page - Page number in original PDF",
            "line_items - Detailed itemized charges with descriptions",
            "cost_allocations - Accounting code allocations from invoice",
            "employee_names - Staff members listed on staffing invoices",
            "confirmation_numbers - Hotel/service confirmation IDs",
            "service_start/service_end - Service period dates",
            "property_name/property_address - Location details",
            "processor_name/processor_date - Internal processing info",
            "all_source_file_ids - Google Drive file IDs for source images"
          ],
          google_drive_integration: {
            description: "Each OCR record includes Google Drive file IDs that link directly to the scanned source documents",
            url_format: "https://drive.google.com/open?id={FILE_ID}",
            source_folder: "Finance_BU 53902028 Invoices - Combined and Redacted_Redacted_images"
          }
        }
      },

      relationship_explanation: {
        how_data_connects: {
          description: "Ledger and OCR data are matched using two methods, in order of reliability",
          matching_methods: [
            {
              method: "invoice_number",
              confidence: 0.95,
              description: "Matched by exact invoice number + vendor name. This is the most reliable match.",
              example: "Invoice R35086148 from Randstad appears in both ledger and OCR"
            },
            {
              method: "vendor_date_amount",
              confidence: 0.85,
              description: "Matched by vendor name + invoice date + exact amount. Used when invoice numbers don't match.",
              example: "ESA invoice from 9/8/2024 for $2,240 matched by these three fields"
            }
          ]
        },

        when_data_doesnt_match: {
          ledger_only_reasons: [
            "Invoice was processed but physical scan is missing",
            "Invoice was scanned under different page range not included in OCR source",
            "Vendor name variations prevented automatic matching",
            "Invoice number format differs between systems"
          ],
          ocr_only_reasons: [
            "Document is an internal processing form, not an invoice",
            "Invoice hasn't been posted to ledger yet (in process)",
            "Document is a continuation/detail page without header info",
            "Document is a folio or summary page",
            "Invoice was rejected or not processed"
          ]
        },

        which_to_trust: {
          for_financial_amounts: "ALWAYS use LEDGER data - these are the official, audited amounts",
          for_line_item_details: "Use OCR data - ledger doesn't contain line-item breakdowns",
          for_employee_names: "Use OCR data - only available from scanned invoices",
          for_confirmation_numbers: "Use OCR data - hotel/service confirmations are on invoices",
          for_vendor_ids: "Use LEDGER data - official vendor master IDs",
          for_payment_status: "Use LEDGER data - only source with payment dates"
        }
      },

      invoice_types: {
        HOTEL: "Hotel/lodging charges for homeless services clients",
        STAFFING: "Temporary staffing services (Randstad employee charges)",
        RENTAL: "Property/apartment rental charges",
        FOOD_SERVICE: "Food/meal service charges",
        SUPPLIES: "General supplies and materials",
        EQUIPMENT: "Equipment purchases or rentals",
        SERVICES: "General service charges",
        PAYROLL: "Internal payroll journal entries (ledger only)",
        OTHER: "Miscellaneous charges"
      },

      vendor_id_reference: {
        "19083": "Randstad North America Inc (Temporary Staffing)",
        "1020857": "Extended Stay America / ESA Management LLC (Hotels)",
        "1018405": "The Ave Nashville LLC / Castello Equity Partners (Hotel)",
        "12122": "Gordon Food Service, Inc. (Food Service)",
        "1019689": "Hillside Crossing LLC (Hotel)",
        "1020919": "Community Care Fellowship (Services)",
        "1021123": "Depaul USA (Services)",
        "1020847": "97 Wallace Studios (Housing)"
      }
    },

    // ==================== STATISTICS SUMMARY ====================
    statistics: {
      generated_at: new Date().toISOString(),

      ledger_totals: {
        total_entries: ledgerInvoices.invoices.length + ledgerInvoices.journals.length,
        invoice_count: ledgerInvoices.invoices.length,
        journal_payroll_count: ledgerInvoices.journals.length,
        total_invoice_amount: ledgerInvoices.invoices.reduce((sum, inv) => sum + (inv.debit || inv.amount || 0), 0),
        total_payroll_amount: ledgerInvoices.journals.reduce((sum, j) => sum + (j.debit || j.amount || 0), 0),
        unique_vendors: [...new Set(ledgerInvoices.invoices.map(i => i.vendor_name))].length,
        date_range: {
          earliest: ledgerInvoices.invoices.map(i => i.invoice_date).filter(Boolean).sort()[0] || null,
          latest: ledgerInvoices.invoices.map(i => i.invoice_date).filter(Boolean).sort().pop() || null
        }
      },

      ocr_totals: {
        total_pages_scanned: ocrInvoices.metadata?.total_pages || ocrInvoices.invoices.length,
        unique_invoices_extracted: ocrInvoices.invoices.length,
        total_ocr_amount: ocrInvoices.invoices.reduce((sum, inv) => sum + (inv.invoice_total || 0), 0),
        unique_vendors: [...new Set(ocrInvoices.invoices.map(i => i.vendor_name).filter(Boolean))].length,
        by_invoice_type: ocrInvoices.invoices.reduce((acc, inv) => {
          const type = inv.meta_invoice_type || 'UNKNOWN';
          if (!acc[type]) acc[type] = { count: 0, total_amount: 0 };
          acc[type].count++;
          acc[type].total_amount += (inv.invoice_total || 0);
          return acc;
        }, {})
      },

      matching_results: {
        total_matched_pairs: mergedData.matched_invoices.length,
        ledger_match_rate: ((mergedData.matched_invoices.length / ledgerInvoices.invoices.length) * 100).toFixed(1) + '%',
        ocr_match_rate: ((mergedData.matched_invoices.length / ocrInvoices.invoices.length) * 100).toFixed(1) + '%',
        unmatched_ledger_invoices: mergedData.ledger_only?.invoices?.length || 0,
        unmatched_ocr_invoices: mergedData.ocr_only?.length || 0,
        by_match_type: {
          invoice_number_matches: mergedData.matched_invoices.filter(m => m._data_sources?.match_type === 'invoice_number').length,
          vendor_date_amount_matches: mergedData.matched_invoices.filter(m => m._data_sources?.match_type === 'vendor_date_amount').length
        }
      }
    },

    // ==================== MATCHED INVOICES (LEDGER + OCR CONNECTED) ====================
    matched_invoices: mergedData.matched_invoices.map(match => ({
      // Match metadata
      _match_info: {
        has_ledger_data: true,
        has_ocr_data: true,
        match_method: match._data_sources?.match_type,
        match_confidence: match._data_sources?.match_confidence,
        match_notes: match._data_sources?.match_notes
      },

      // Unified/reconciled view
      unified: {
        invoice_number: match.ledger?.invoice_number || match.ocr?.invoice_number,
        vendor_name: match.ledger?.vendor_name || match.ocr?.vendor_name,
        vendor_id: match.ledger?.vendor_id || match.ocr?.vendor_id,
        invoice_date: match.ledger?.invoice_date || match.ocr?.invoice_date,

        // Financial amounts (from ledger - authoritative)
        ledger_amount: match.ledger?.amount || match.ledger?.debit || 0,
        ocr_amount: match.ocr?.invoice_total || 0,
        amount_difference: Math.abs((match.ledger?.amount || match.ledger?.debit || 0) - (match.ocr?.invoice_total || 0)),

        // Category
        expense_category: match.ledger?.object_account_descr || match.ocr?.meta_invoice_type,
        invoice_type: match.ocr?.meta_invoice_type
      },

      // Complete ledger record (source of truth for financial data)
      ledger: match.ledger ? {
        ...match.ledger,
        _source: "R12 Financial System Export",
        _authority: "PRIMARY"
      } : null,

      // Complete OCR record with Google Drive links (source for detail data)
      ocr: match.ocr ? {
        ...enhanceOcrWithDriveLinks(match.ocr),
        _source: "OCR Extraction from Scanned Invoice",
        _authority: "SUPPLEMENTARY"
      } : null,

      // Enrichment data only available from OCR
      enrichment_from_ocr: match.ocr ? {
        line_items: match.ocr.line_items || [],
        line_item_count: (match.ocr.line_items || []).length,
        cost_allocations: match.ocr.cost_allocations || [],
        employee_names: match.ocr.employee_names || [],
        confirmation_numbers: match.ocr.confirmation_numbers || [],
        service_period: {
          start: match.ocr.service_start,
          end: match.ocr.service_end,
          description: match.ocr.service_description
        },
        property_info: {
          name: match.ocr.property_name,
          address: match.ocr.property_address,
          unit_count: match.ocr.unit_count
        },
        processor: {
          name: match.ocr.processor_name,
          date: match.ocr.processor_date
        },
        ocr_confidence: match.ocr.meta_confidence
      } : null,

      // Google Drive links for source documents
      source_documents: match.ocr?.all_source_file_ids ? {
        page_count: match.ocr.merge_info?.page_count || match.ocr.all_source_file_ids.length,
        was_multi_page: match.ocr.merge_info?.was_merged || false,
        merge_reasoning: match.ocr.merge_info?.merge_reasoning,
        source_pages: match.ocr.all_source_rows || [],
        google_drive_links: match.ocr.all_source_file_ids.map((fileId, idx) => ({
          page: match.ocr.all_source_rows?.[idx] || (idx + 1),
          file_id: fileId,
          url: buildGoogleDriveUrl(fileId),
          view_url: buildGoogleDriveViewUrl(fileId)
        }))
      } : null
    })),

    // ==================== LEDGER-ONLY INVOICES (No OCR Match) ====================
    ledger_only_invoices: {
      _section_info: {
        description: "Invoices that appear in the R12 ledger but have no matching OCR scan",
        record_count: mergedData.ledger_only?.invoices?.length || 0,
        possible_reasons: [
          "Physical invoice scan is missing or not included in OCR source",
          "Invoice processed through different system/batch",
          "Vendor name variation prevented automatic matching"
        ],
        data_available: "Full ledger data (amounts, dates, GL codes) - No line items or detail available"
      },
      invoices: (mergedData.ledger_only?.invoices || []).map(record => ({
        _match_info: {
          has_ledger_data: true,
          has_ocr_data: false,
          match_method: "ledger_only",
          match_confidence: 1.0,
          match_notes: "No matching OCR scan found"
        },
        ledger: {
          ...record.ledger,
          _source: "R12 Financial System Export",
          _authority: "PRIMARY"
        },
        ocr: null,
        source_documents: null
      }))
    },

    // ==================== OCR-ONLY INVOICES (No Ledger Match) ====================
    ocr_only_invoices: {
      _section_info: {
        description: "Documents from OCR scans that don't match any ledger entry",
        record_count: mergedData.ocr_only?.length || 0,
        possible_reasons: [
          "Document is an internal processing form, not a payable invoice",
          "Invoice is pending and not yet posted to ledger",
          "Document is a continuation/folio page",
          "Invoice was rejected or voided",
          "Duplicate or superseded invoice"
        ],
        data_available: "Full OCR data with line items - No authoritative financial posting",
        caution: "These records may not represent actual financial transactions"
      },
      invoices: (mergedData.ocr_only || []).map(record => ({
        _match_info: {
          has_ledger_data: false,
          has_ocr_data: true,
          match_method: "ocr_only",
          match_confidence: 0.5,
          match_notes: "Not found in ledger - may be internal form or processing document"
        },
        ledger: null,
        ocr: record.ocr ? {
          ...enhanceOcrWithDriveLinks(record.ocr),
          _source: "OCR Extraction from Scanned Invoice",
          _authority: "SUPPLEMENTARY - NOT CONFIRMED IN LEDGER"
        } : null,
        source_documents: record.ocr?.all_source_file_ids ? {
          page_count: record.ocr.merge_info?.page_count || record.ocr.all_source_file_ids.length,
          was_multi_page: record.ocr.merge_info?.was_merged || false,
          merge_reasoning: record.ocr.merge_info?.merge_reasoning,
          source_pages: record.ocr.all_source_rows || [],
          google_drive_links: record.ocr.all_source_file_ids.map((fileId, idx) => ({
            page: record.ocr.all_source_rows?.[idx] || (idx + 1),
            file_id: fileId,
            url: buildGoogleDriveUrl(fileId),
            view_url: buildGoogleDriveViewUrl(fileId)
          }))
        } : null
      }))
    },

    // ==================== PAYROLL/JOURNAL ENTRIES (Ledger Only) ====================
    payroll_journals: {
      _section_info: {
        description: "Payroll and journal entries from the ledger (no corresponding OCR scans - these are system-generated)",
        record_count: (mergedData.ledger_only?.journals || []).length,
        data_source: "R12 Financial System - Journal Entries",
        note: "Journal entries represent internal accounting transactions, not vendor invoices"
      },
      entries: (mergedData.ledger_only?.journals || []).map(journal => ({
        _record_type: "PAYROLL_JOURNAL",
        _source: "R12 Financial System",
        ...journal
      }))
    },

    // ==================== VENDOR SUMMARY ====================
    vendor_summary: (() => {
      const vendors = {};

      // Process matched invoices
      mergedData.matched_invoices.forEach(match => {
        const vendorName = match.ledger?.vendor_name || match.ocr?.vendor_name;
        const vendorId = match.ledger?.vendor_id || match.ocr?.vendor_id;
        if (!vendorName) return;

        if (!vendors[vendorName]) {
          vendors[vendorName] = {
            vendor_name: vendorName,
            vendor_id: vendorId,
            matched_invoice_count: 0,
            ledger_only_count: 0,
            ocr_only_count: 0,
            total_ledger_amount: 0,
            total_ocr_amount: 0,
            invoice_numbers: []
          };
        }
        vendors[vendorName].matched_invoice_count++;
        vendors[vendorName].total_ledger_amount += (match.ledger?.amount || match.ledger?.debit || 0);
        vendors[vendorName].total_ocr_amount += (match.ocr?.invoice_total || 0);
        vendors[vendorName].invoice_numbers.push(match.ledger?.invoice_number || match.ocr?.invoice_number);
      });

      // Process ledger-only
      (mergedData.ledger_only?.invoices || []).forEach(record => {
        const vendorName = record.ledger?.vendor_name;
        if (!vendorName) return;

        if (!vendors[vendorName]) {
          vendors[vendorName] = {
            vendor_name: vendorName,
            vendor_id: record.ledger?.vendor_id,
            matched_invoice_count: 0,
            ledger_only_count: 0,
            ocr_only_count: 0,
            total_ledger_amount: 0,
            total_ocr_amount: 0,
            invoice_numbers: []
          };
        }
        vendors[vendorName].ledger_only_count++;
        vendors[vendorName].total_ledger_amount += (record.ledger?.amount || record.ledger?.debit || 0);
        vendors[vendorName].invoice_numbers.push(record.ledger?.invoice_number);
      });

      // Process OCR-only
      (mergedData.ocr_only || []).forEach(record => {
        const vendorName = record.ocr?.vendor_name;
        if (!vendorName) return;

        if (!vendors[vendorName]) {
          vendors[vendorName] = {
            vendor_name: vendorName,
            vendor_id: record.ocr?.vendor_id,
            matched_invoice_count: 0,
            ledger_only_count: 0,
            ocr_only_count: 0,
            total_ledger_amount: 0,
            total_ocr_amount: 0,
            invoice_numbers: []
          };
        }
        vendors[vendorName].ocr_only_count++;
        vendors[vendorName].total_ocr_amount += (record.ocr?.invoice_total || 0);
        vendors[vendorName].invoice_numbers.push(record.ocr?.invoice_number);
      });

      return Object.values(vendors)
        .map(v => ({
          ...v,
          total_invoice_count: v.matched_invoice_count + v.ledger_only_count + v.ocr_only_count,
          match_rate: v.matched_invoice_count > 0 ?
            ((v.matched_invoice_count / (v.matched_invoice_count + v.ledger_only_count + v.ocr_only_count)) * 100).toFixed(1) + '%' : '0%'
        }))
        .sort((a, b) => b.total_ledger_amount - a.total_ledger_amount);
    })(),

    // ==================== RAW DATA REFERENCE ====================
    raw_data_reference: {
      _section_info: {
        description: "Complete raw datasets for reference",
        note: "Use the sections above for matched/reconciled data. This section provides complete unprocessed records."
      },

      all_ocr_invoices: ocrInvoices.invoices.map(inv => ({
        ...enhanceOcrWithDriveLinks(inv)
      })),

      all_ledger_invoices: ledgerInvoices.invoices,

      all_ledger_journals: ledgerInvoices.journals
    }
  };

  return comprehensiveExport;
}

// ==================== MAIN ====================
function main() {
  console.log('=== Generating Comprehensive JSON Export ===\n');

  const exportData = generateComprehensiveExport();

  const outputPath = path.join(__dirname, 'comprehensive-export.json');
  console.log(`\nWriting comprehensive export to ${outputPath}...`);
  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf8');

  // Calculate file size
  const stats = fs.statSync(outputPath);
  const fileSizeKB = (stats.size / 1024).toFixed(1);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`\n=== Export Complete ===`);
  console.log(`File size: ${fileSizeKB} KB (${fileSizeMB} MB)`);
  console.log(`\nSections included:`);
  console.log(`  - Documentation & definitions`);
  console.log(`  - Statistics summary`);
  console.log(`  - Matched invoices: ${exportData.matched_invoices.length}`);
  console.log(`  - Ledger-only invoices: ${exportData.ledger_only_invoices.invoices.length}`);
  console.log(`  - OCR-only invoices: ${exportData.ocr_only_invoices.invoices.length}`);
  console.log(`  - Payroll journals: ${exportData.payroll_journals.entries.length}`);
  console.log(`  - Vendor summary: ${exportData.vendor_summary.length} vendors`);
  console.log(`  - Raw data reference (all records)`);
  console.log(`\nGoogle Drive links included for all OCR records.`);
}

main();
