/* CatalogFix engine — Shopify product CSV validation + auto-fix.
   Pure logic, no DOM. Runs in the browser (window.CatalogFix) and in Node (module.exports). */
(function (global) {
  'use strict';

  var CANONICAL = [
    'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags',
    'Published', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value',
    'Option3 Name', 'Option3 Value', 'Variant SKU', 'Variant Grams',
    'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy',
    'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price',
    'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode', 'Image Src',
    'Image Position', 'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description',
    'Google Shopping / Google Product Category', 'Google Shopping / Gender',
    'Google Shopping / Age Group', 'Google Shopping / MPN', 'Google Shopping / AdWords Grouping',
    'Google Shopping / AdWords Labels', 'Google Shopping / Condition',
    'Google Shopping / Custom Product', 'Google Shopping / Custom Label 0',
    'Google Shopping / Custom Label 1', 'Google Shopping / Custom Label 2',
    'Google Shopping / Custom Label 3', 'Google Shopping / Custom Label 4',
    'Variant Image', 'Variant Weight Unit', 'Variant Tax Code', 'Cost per item',
    'Status', 'Collection', 'Variant Country of Origin', 'Variant HS Code'
  ];
  var CANON_BY_LOWER = {};
  CANONICAL.forEach(function (h) { CANON_BY_LOWER[h.toLowerCase()] = h; });

  function isMetafieldHeader(h) {
    return /metafield/i.test(h) || /^[a-z0-9_]+\.[a-z0-9_.-]+$/i.test(h) && /\[/.test(h);
  }

  /* ---------- CSV parsing (RFC 4180-ish) ---------- */
  function parseCSV(text) {
    var hadBOM = text.charCodeAt(0) === 0xFEFF;
    if (hadBOM) text = text.slice(1);
    var rows = [], row = [], field = '', inQuotes = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return { rows: rows, hadBOM: hadBOM };
  }

  function serializeCSV(headers, rows) {
    function esc(v) {
      v = (v === null || v === undefined) ? '' : String(v);
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var lines = [headers.map(esc).join(',')];
    rows.forEach(function (r) { lines.push(r.map(esc).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }

  /* ---------- helpers ---------- */
  function trim(s) { return (s === null || s === undefined) ? '' : String(s).trim(); }
  function isBlankRow(r) { return r.every(function (c) { return trim(c) === ''; }); }

  function parseMoney(raw) {
    // Returns {value: '1234.56'} or null. Handles $1,299.00 / 12,99 / € 45 / plain numbers.
    var s = trim(raw).replace(/[$€£\s]/g, '');
    if (s === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, '');
    if (/^-?\d+,\d{1,2}$/.test(s)) return s.replace(',', '.');
    if (/^-?\d+\.\d{3},\d{1,2}$/.test(s)) return s.replace(/\./g, '').replace(',', '.');
    return null;
  }

  function boolFix(raw) {
    var s = trim(raw).toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1') return 'TRUE';
    if (s === 'false' || s === 'no' || s === '0') return 'FALSE';
    return null;
  }

  function slugifyHandle(raw) {
    return trim(raw).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* ---------- main analysis ---------- */
  function analyze(text) {
    var parsed = parseCSV(text);
    var issues = [];   // {severity: 'fatal'|'error'|'warning'|'fix', row, handle, column, message, before, after}
    var fixes = { count: 0 };
    function issue(sev, row, handle, column, message, before, after) {
      issues.push({ severity: sev, row: row, handle: handle || '', column: column || '', message: message, before: before || '', after: after || '' });
      if (sev === 'fix') fixes.count++;
    }

    var rawRows = parsed.rows;
    if (!rawRows.length) {
      issue('fatal', 0, '', '', 'The file is empty — no header row found.');
      return finish(null);
    }
    if (parsed.hadBOM) issue('fix', 1, '', '', 'Removed the UTF-8 BOM marker at the start of the file (it can corrupt the first column name in Shopify).', 'BOM', 'removed');

    /* headers */
    var headers = rawRows[0].slice();
    var headerChanged = false;
    headers = headers.map(function (h, idx) {
      var t = trim(h);
      var canon = CANON_BY_LOWER[t.toLowerCase()];
      if (canon && canon !== h) {
        issue('fix', 1, '', h, 'Renamed column to Shopify\u2019s exact header.', h, canon);
        headerChanged = true; return canon;
      }
      if (t !== h) { headerChanged = true; return t; }
      return h;
    });
    var unknownHeaders = headers.filter(function (h) {
      return !CANON_BY_LOWER[h.toLowerCase()] && !isMetafieldHeader(h);
    });
    unknownHeaders.forEach(function (h) {
      issue('warning', 1, '', h, 'Unknown column — Shopify does not recognize this header and will ignore the data in it. Move anything important into a metafield column.');
    });
    headers.forEach(function (h) {
      if (/metafield/i.test(h) && !/\[[a-z_]+\]/.test(h)) {
        issue('warning', 1, '', h, 'Metafield column is missing its type in brackets (for example [single_line_text_field]) — Shopify will reject this column.');
      }
    });
    var col = {};
    headers.forEach(function (h, i) { if (!(h in col)) col[h] = i; });
    function cell(r, name) { var i = col[name]; return i === undefined ? '' : trim(r[i]); }
    function setCell(r, name, val) { var i = col[name]; if (i !== undefined) r[i] = val; }

    if (col['Handle'] === undefined) {
      issue('fatal', 1, '', 'Handle', 'There is no "Handle" column. A Shopify product CSV cannot be imported without one.');
      return finish(null);
    }

    /* body rows: drop blanks, detect ragged rows */
    var rows = [];
    rawRows.slice(1).forEach(function (r, i) {
      var rowNum = i + 2;
      if (isBlankRow(r)) { issue('fix', rowNum, '', '', 'Removed a completely empty row.', '(blank row)', 'removed'); return; }
      if (r.length > headers.length) {
        issue('error', rowNum, cell(r, 'Handle'), '', 'This row has ' + r.length + ' fields but the file has ' + headers.length + ' columns — almost always an unquoted comma inside a text field (title, description or tags). Shopify will reject this row.');
        rows.push(r.slice(0, headers.length)); return;
      }
      while (r.length < headers.length) r.push('');
      rows.push(r);
    });

    /* normalize handles BEFORE grouping, so "Blue Tee!" and "blue tee" variants land in one product */
    var handleFixSeen = {};
    rows.forEach(function (r, idx) {
      var h = cell(r, 'Handle');
      if (!h) return;
      var nh = slugifyHandle(h);
      if (nh && nh !== h) {
        if (!handleFixSeen[h]) {
          handleFixSeen[h] = true;
          issue('fix', idx + 2, h, 'Handle', 'Cleaned the handle — Shopify handles must be lowercase with hyphens, no spaces or symbols.', h, nh);
        }
        setCell(r, 'Handle', nh);
      }
    });

    /* regroup scattered handles (Shopify expects each product's rows together) */
    var firstSeen = {}, order = [];
    rows.forEach(function (r) { var h = cell(r, 'Handle'); if (!(h in firstSeen)) { firstSeen[h] = true; order.push(h); } });
    var grouped = [];
    order.forEach(function (h) { rows.forEach(function (r) { if (cell(r, 'Handle') === h) grouped.push(r); }); });
    var scattered = grouped.some(function (r, i) { return r !== rows[i]; });
    if (scattered) issue('fix', 0, '', 'Handle', 'Re-grouped variant rows so every product\u2019s rows sit together — scattered rows for one handle import unpredictably.', 'scattered', 'grouped');
    rows = grouped;

    /* per-product checks */
    var skuSeen = {};
    var i = 0, rowNumOf = {};
    rows.forEach(function (r, idx) { rowNumOf[idx] = idx + 2; });
    while (i < rows.length) {
      var handle = cell(rows[i], 'Handle');
      var j = i;
      while (j < rows.length && cell(rows[j], 'Handle') === handle) j++;
      var group = rows.slice(i, j);
      var main = group[0], mainRow = rowNumOf[i];

      var newHandle = slugifyHandle(handle);
      if (newHandle && newHandle !== handle) {
        issue('fix', mainRow, handle, 'Handle', 'Cleaned the handle — Shopify handles must be lowercase with hyphens, no spaces or symbols.', handle, newHandle);
        group.forEach(function (r) { setCell(r, 'Handle', newHandle); });
        handle = newHandle;
      }
      if (!handle) issue('error', mainRow, '', 'Handle', 'This product has no handle. Every product needs one.');

      if (!cell(main, 'Title')) {
        issue('error', mainRow, handle, 'Title', 'The first row of this product has no Title. Shopify rejects products without a title.');
      }

      /* options */
      var optNames = [cell(main, 'Option1 Name'), cell(main, 'Option2 Name'), cell(main, 'Option3 Name')];
      var hasOptions = optNames.some(function (n) { return n !== ''; });
      if (!hasOptions && group.length === 1) {
        if (col['Option1 Name'] !== undefined && cell(main, 'Option1 Value') === '') {
          issue('fix', mainRow, handle, 'Option1 Name', 'Added the standard single-variant option Shopify expects.', '', 'Title / Default Title');
          setCell(main, 'Option1 Name', 'Title'); setCell(main, 'Option1 Value', 'Default Title');
        }
      }
      if (!hasOptions && group.length > 1) {
        issue('error', mainRow, handle, 'Option1 Name', 'This product has ' + group.length + ' rows but no option names/values, so Shopify cannot tell the variants apart.');
      }
      var seenCombos = {};
      group.forEach(function (r, gi) {
        var rn = rowNumOf[i + gi];
        if (hasOptions) {
          var combo = [cell(r, 'Option1 Value'), cell(r, 'Option2 Value'), cell(r, 'Option3 Value')].join(' | ');
          if (cell(r, 'Option1 Value') === '') issue('error', rn, handle, 'Option1 Value', 'A variant row is missing its Option1 Value.');
          if (seenCombos[combo]) issue('error', rn, handle, 'Option Values', 'Duplicate variant: the option combination "' + combo + '" already exists for this product. Shopify rejects duplicate variants.');
          seenCombos[combo] = true;
        }
        /* money */
        ['Variant Price', 'Variant Compare At Price', 'Cost per item'].forEach(function (mc) {
          if (col[mc] === undefined) return;
          var raw = cell(r, mc), rn2 = rn;
          if (raw === '') {
            if (mc === 'Variant Price' && gi === 0) issue('error', rn2, handle, mc, 'The main variant has no price. Shopify requires a price on every variant.');
            return;
          }
          var mv = parseMoney(raw);
          if (mv === null) issue('error', rn2, handle, mc, 'Not a valid price: "' + raw + '". Prices must be plain numbers like 1299.00 — no currency symbols or text.');
          else if (mv !== raw) { issue('fix', rn2, handle, mc, 'Reformatted the price into Shopify\u2019s plain-number format.', raw, mv); setCell(r, mc, mv); }
          else if (parseFloat(mv) < 0) issue('error', rn2, handle, mc, 'Negative price — Shopify will reject this.');
        });
        var p = parseMoney(cell(r, 'Variant Price')), cp = parseMoney(cell(r, 'Variant Compare At Price'));
        if (p && cp && parseFloat(cp) < parseFloat(p)) {
          issue('warning', rn, handle, 'Variant Compare At Price', 'Compare-at price (' + cp + ') is lower than the price (' + p + ') — the product will not show as on sale and the values look swapped.');
        }
        /* inventory */
        var qty = cell(r, 'Variant Inventory Qty');
        if (qty !== '' && !/^-?\d+$/.test(qty)) {
          if (/^-?\d+\.0+$/.test(qty)) { var q2 = String(parseInt(qty, 10)); issue('fix', rn, handle, 'Variant Inventory Qty', 'Converted the quantity to a whole number.', qty, q2); setCell(r, 'Variant Inventory Qty', q2); }
          else issue('error', rn, handle, 'Variant Inventory Qty', 'Quantity "' + qty + '" is not a whole number.');
        }
        var tracker = cell(r, 'Variant Inventory Tracker');
        if (tracker !== '' && tracker.toLowerCase() === 'shopify' && tracker !== 'shopify') { issue('fix', rn, handle, 'Variant Inventory Tracker', 'Lowercased the inventory tracker value to the exact value Shopify expects.', tracker, 'shopify'); setCell(r, 'Variant Inventory Tracker', 'shopify'); }
        var policy = cell(r, 'Variant Inventory Policy');
        if (policy !== '') {
          var pl = policy.toLowerCase();
          if ((pl === 'deny' || pl === 'continue') && policy !== pl) { issue('fix', rn, handle, 'Variant Inventory Policy', 'Normalized the inventory policy to the exact value Shopify expects.', policy, pl); setCell(r, 'Variant Inventory Policy', pl); }
          else if (pl !== 'deny' && pl !== 'continue') issue('error', rn, handle, 'Variant Inventory Policy', 'Inventory policy must be "deny" or "continue" — found "' + policy + '".');
        }
        var fulfill = cell(r, 'Variant Fulfillment Service');
        if (fulfill !== '' && fulfill.toLowerCase() === 'manual' && fulfill !== 'manual') { issue('fix', rn, handle, 'Variant Fulfillment Service', 'Lowercased the fulfillment service to the exact value Shopify expects.', fulfill, 'manual'); setCell(r, 'Variant Fulfillment Service', 'manual'); }
        /* booleans */
        ['Variant Requires Shipping', 'Variant Taxable', 'Published', 'Gift Card'].forEach(function (bc) {
          if (col[bc] === undefined) return;
          var raw = cell(r, bc);
          if (raw === '') return;
          var bf = boolFix(raw);
          if (bf && bf !== raw) { issue('fix', rn, handle, bc, 'Normalized the value to TRUE/FALSE, the only form Shopify accepts here.', raw, bf); setCell(r, bc, bf); }
          else if (!bf) issue('warning', rn, handle, bc, 'Value "' + raw + '" is not TRUE or FALSE — Shopify may read it as FALSE.');
        });
        /* weight */
        var grams = cell(r, 'Variant Grams');
        if (grams !== '' && !/^\d+(\.\d+)?$/.test(grams)) issue('error', rn, handle, 'Variant Grams', 'Weight in grams must be a plain number — found "' + grams + '".');
        var wu = cell(r, 'Variant Weight Unit');
        if (wu !== '' && ['g', 'kg', 'lb', 'oz'].indexOf(wu.toLowerCase()) >= 0 && wu !== wu.toLowerCase()) { issue('fix', rn, handle, 'Variant Weight Unit', 'Lowercased the weight unit to the exact value Shopify expects.', wu, wu.toLowerCase()); setCell(r, 'Variant Weight Unit', wu.toLowerCase()); }
        /* image */
        var img = cell(r, 'Image Src');
        if (img !== '' && !/^https?:\/\/[^\s]+\.[^\s]+$/.test(img)) {
          issue('error', rn, handle, 'Image Src', 'This image link is not a valid public URL: "' + img + '". Image Src must start with http:// or https:// and point to a publicly reachable file.');
        }
        /* sku */
        var sku = cell(r, 'Variant SKU');
        if (sku) {
          if (skuSeen[sku] && skuSeen[sku] !== handle) issue('warning', rn, handle, 'Variant SKU', 'SKU "' + sku + '" is also used by product "' + skuSeen[sku] + '". Duplicate SKUs cause fulfillment and reporting mix-ups.');
          skuSeen[sku] = handle;
        }
      });

      /* tags tidy (main row) */
      var tags = cell(main, 'Tags');
      if (tags) {
        var cleanTags = tags.split(',').map(trim).filter(function (t) { return t !== ''; }).join(', ');
        if (cleanTags !== tags) { issue('fix', mainRow, handle, 'Tags', 'Tidied the tag list (trimmed spaces, removed empty tags).', tags, cleanTags); setCell(main, 'Tags', cleanTags); }
      }
      if (!cell(main, 'Vendor')) issue('warning', mainRow, handle, 'Vendor', 'No vendor set on this product. Not fatal, but vendor is required by most sales channels and reports.');

      /* status */
      if (col['Status'] !== undefined) {
        var st = cell(main, 'Status');
        if (st !== '') {
          var sl = st.toLowerCase();
          if (['active', 'draft', 'archived'].indexOf(sl) >= 0 && st !== sl) { issue('fix', mainRow, handle, 'Status', 'Lowercased the status to the exact value Shopify expects.', st, sl); setCell(main, 'Status', sl); }
          else if (['active', 'draft', 'archived'].indexOf(sl) < 0) issue('error', mainRow, handle, 'Status', 'Status must be active, draft or archived — found "' + st + '".');
        }
      }

      /* image positions: renumber per product when any position is bad */
      if (col['Image Src'] !== undefined && col['Image Position'] !== undefined) {
        var imgs = group.filter(function (r) { return cell(r, 'Image Src') !== ''; });
        var badPos = imgs.some(function (r) { var p = cell(r, 'Image Position'); return p === '' || !/^\d+$/.test(p); });
        if (badPos && imgs.length) {
          imgs.forEach(function (r, k) { setCell(r, 'Image Position', String(k + 1)); });
          issue('fix', mainRow, handle, 'Image Position', 'Renumbered this product\u2019s image positions (1, 2, 3…) — missing or duplicate positions make Shopify drop or reorder images.', 'missing/duplicate', '1..' + imgs.length);
        }
      }

      i = j;
    }

    return finish({ headers: headers, rows: rows, headerChanged: headerChanged });
    function finish(data) {
      var summary = { errors: 0, warnings: 0, fixes: 0, fatal: 0, products: 0, rows: 0 };
      issues.forEach(function (x) {
        if (x.severity === 'error') summary.errors++;
        else if (x.severity === 'warning') summary.warnings++;
        else if (x.severity === 'fix') summary.fixes++;
        else if (x.severity === 'fatal') summary.fatal++;
      });
      if (data) {
        summary.rows = data.rows.length;
        var hs = {};
        data.rows.forEach(function (r) { hs[cell(r, 'Handle')] = true; });
        summary.products = Object.keys(hs).length;
      }
      return { issues: issues, summary: summary, headers: data ? data.headers : null, rows: data ? data.rows : null };
    }
  }

  function correctedCSV(result) {
    if (!result.headers) return null;
    return serializeCSV(result.headers, result.rows);
  }

  var api = { analyze: analyze, correctedCSV: correctedCSV, parseCSV: parseCSV, serializeCSV: serializeCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CatalogFix = api;
})(typeof window !== 'undefined' ? window : globalThis);
