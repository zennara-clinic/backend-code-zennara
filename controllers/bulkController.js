/**
 * Bulk import and export for services, categories and products.
 *
 * One engine, three entity definitions. Three separate importers would drift —
 * and the actual product here is the *validation*: preview before commit, a
 * per-row error report, duplicate detection, and an explicit choice between
 * creating and updating. The parsers are the easy part.
 *
 * Import is deliberately two-phase:
 *
 *   1. POST .../preview  — parse, validate, classify every row, write nothing
 *   2. POST .../commit   — re-validate and apply, with the same rules
 *
 * The preview is not trusted at commit time; the file is validated again. A
 * client that skipped the preview, or a catalogue that changed in between,
 * must not be able to write an unchecked row.
 */
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Category = require('../models/Category');
const Product = require('../models/Product');
const Package = require('../models/Package');
const AdminAuditLog = require('../models/AdminAuditLog');
const { toCsv, readWorkbook } = require('../utils/bulkCsv');

const slugify = (v) => String(v || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const bool = (v, fallback = null) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return fallback;
  if (['1', 'true', 'yes', 'y', 'active', 'visible', 'show'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'inactive', 'hidden', 'hide'].includes(s)) return false;
  return fallback;
};

/**
 * Categories arrive from Zenoti in whatever case the person typing used —
 * "body countouring ", "Medical Treatment", "SKIN". Normalising on the way in
 * is what stops the same category appearing three times in the panel's filter.
 */
const titleCase = (v) => String(v || '').trim().replace(/\s+/g, ' ')
  .toLowerCase()
  .replace(/\b[a-z]/g, (c) => c.toUpperCase());

const num = (v, fallback = null) => {
  const n = Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Entity definitions.
 *
 * `key` is what makes two rows "the same record" — it is what duplicate
 * detection and create-vs-update both hinge on, so each entity names it
 * explicitly rather than guessing from whatever columns happen to be present.
 */
const ENTITIES = {
  /**
   * Services — Zenoti's own service-master columns, verbatim.
   *
   * The clinic exports its master data from Zenoti as
   *   ServiceCode | ServiceName | Category | Sub Category | BusinessUnitName | ServiceType | ServiceLength
   * so that is exactly what this importer reads and writes. A file the clinic
   * pulls from Zenoti imports here untouched, and our export opens in Zenoti's
   * own template. Price is NOT in that export (Zenoti keeps it per centre), so
   * an import never overwrites a price someone set here.
   *
   * `AppCatalog` and `Price` are ours, appended after Zenoti's columns: the
   * export round-trips what the desk has published without a second file.
   */
  services: {
    model: () => Consultation,
    label: 'services',
    columns: [
      'ServiceCode', 'ServiceName', 'Category', 'Sub Category',
      'BusinessUnitName', 'ServiceType', 'ServiceLength',
      'AppCatalog', 'Price',
    ],
    required: ['ServiceName'],
    taxonomy: ['category', 'subCategory'],
    taxonomyColumns: ['Category', 'Sub Category'],
    /**
     * Two rows are the same service when the NAME matches, case and spacing
     * ignored. Zenoti's ServiceCode is not usable as a key — in the clinic's
     * own export it is variously the service name, a bare number ("1", "189")
     * or blank, and it repeats.
     */
    keyOf: (row) => slugify(row.ServiceName),
    async find(key, row) {
      const code = String(row.ServiceCode || '').trim();
      if (code && !/^\d+(\.\d+)?$/.test(code)) {
        const hit = await Consultation.findOne({ code, isArchived: { $ne: true } });
        if (hit) return hit;
      }
      return Consultation.findOne({ slug: key, isArchived: { $ne: true } });
    },
    validate(row) {
      const errors = [];
      if (!String(row.ServiceName || '').trim()) errors.push('ServiceName is required');
      if (!String(row.Category || '').trim()) errors.push('Category is required');
      if (row.ServiceLength !== '' && num(row.ServiceLength) === null) {
        errors.push(`ServiceLength "${row.ServiceLength}" is not a number`);
      }
      if (row.Price !== '' && row.Price !== undefined && num(row.Price) === null) {
        errors.push(`Price "${row.Price}" is not a number`);
      }
      return errors;
    },
    /**
     * `id` and `slug` are both required and unique, and neither is in Zenoti's
     * export — they are derived from the name. Uniqueness is checked against
     * archived rows too, because an archived service still holds its slug.
     */
    async prepare(row) {
      const base = slugify(row.ServiceName) || 'service';
      let slug = base;
      for (let n = 2; await Consultation.exists({ slug }); n += 1) slug = `${base}-${n}`;
      let id = slug;
      for (let n = 2; await Consultation.exists({ id }); n += 1) id = `${slug}-${n}`;
      return { slug, id };
    },
    apply(doc, row, { creating, prepared }) {
      const name = String(row.ServiceName).trim();
      if (creating) {
        doc.slug = prepared?.slug || slugify(name);
        doc.id = prepared?.id || doc.slug;
        // Required by the schema and never in Zenoti's export; the panel fills
        // the customer-facing copy in afterwards.
        doc.summary = name;
        doc.about = name;
        doc.price = 0;
        // A newly imported service is master data, not a storefront item. It
        // reaches the app only when someone publishes it to the catalogue.
        doc.inCatalog = false;
        doc.isActive = true;
      }
      doc.name = name;
      doc.category = titleCase(row.Category);
      if (row['Sub Category'] !== '') doc.subCategory = titleCase(row['Sub Category']);
      if (row.BusinessUnitName !== '') doc.businessUnit = String(row.BusinessUnitName).trim();
      if (row.ServiceType !== '') doc.serviceType = String(row.ServiceType).trim();
      // Zenoti writes a blank code as the service name; that is not a code.
      const code = String(row.ServiceCode || '').trim();
      if (code && code.toLowerCase() !== name.toLowerCase()) doc.code = code;
      const mins = num(row.ServiceLength);
      if (mins !== null && mins > 0) doc.duration_minutes = Math.round(mins);
      // Our own columns, only when present — a plain Zenoti file leaves both alone.
      const cat = bool(row.AppCatalog);
      if (cat !== null && cat !== doc.inCatalog) {
        doc.inCatalog = cat;
        doc.catalogAddedAt = cat ? new Date() : null;
      }
      const price = num(row.Price);
      if (price !== null) doc.price = price;
      doc.isArchived = false;
      return doc;
    },
    exportRow: (d) => ({
      ServiceCode: d.code || '',
      ServiceName: d.name || '',
      Category: d.category || '',
      'Sub Category': d.subCategory || '',
      BusinessUnitName: d.businessUnit || 'Default',
      ServiceType: d.serviceType || 'None',
      ServiceLength: d.duration_minutes ?? '',
      AppCatalog: d.inCatalog ? 'yes' : 'no',
      Price: d.price ?? '',
    }),
    /** Archived rows are history; they must not come back out of an export. */
    exportFilter: { isArchived: { $ne: true } },
  },

  /**
   * Packages — the one way to fill in what Zenoti will not tell us.
   *
   * Zenoti's API publishes a package's name, code and validity but NEVER its
   * price or the services inside it (proven exhaustively; the detail endpoints
   * are refused for this key). We recover both from real sales, but 799 of the
   * 1,268 catalogue packages have never been sold here — there is no sale to
   * learn from, and no API that will answer. Someone at the clinic has to
   * supply them, and doing that 799 times in a form is not a plan.
   *
   * `Services` is a semicolon-separated list of "Service name x sessions":
   *     Exosome Therapy x3; GFC Hair x2
   * Each name is resolved against the live service catalogue; a name that
   * matches nothing is reported per row rather than silently dropped.
   */
  packages: {
    model: () => Package,
    label: 'packages',
    columns: ['Code', 'PackageName', 'Category', 'Price', 'ValidityDays', 'Services', 'AppCatalogue'],
    required: ['PackageName'],
    keyOf: (row) => slugify(row.PackageName),
    /** Resolve the service list during preview so unknown names are visible first. */
    previewPrepare: true,
    async find(key, row) {
      const code = String(row.Code || '').trim();
      if (code) {
        const hit = await Package.findOne({ code: code.toUpperCase() });
        if (hit) return hit;
      }
      return Package.findOne({ id: key }) || Package.findOne({ name: new RegExp(`^${String(row.PackageName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    },
    validate(row) {
      const errors = [];
      if (!String(row.PackageName || '').trim()) errors.push('PackageName is required');
      if (row.Price !== '' && row.Price !== undefined && num(row.Price) === null) errors.push(`Price "${row.Price}" is not a number`);
      if (row.ValidityDays !== '' && row.ValidityDays !== undefined && num(row.ValidityDays) === null) errors.push(`ValidityDays "${row.ValidityDays}" is not a number`);
      return errors;
    },
    /** Resolve the "name x sessions" list against the real service catalogue. */
    async prepare(row) {
      const raw = String(row.Services || '').trim();
      if (!raw) return { services: null, unknown: [] };
      const Consultation = require('../models/Consultation');
      const parts = raw.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
      const services = []; const unknown = [];
      for (const part of parts) {
        const m = part.match(/^(.*?)(?:\s*[x×]\s*(\d+))?$/i);
        const name = String(m?.[1] || part).trim();
        const sessions = Math.max(1, Number(m?.[2]) || 1);
        const hit = await Consultation.findOne({
          isArchived: { $ne: true },
          name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        }).select('id name price').lean();
        if (!hit) { unknown.push(name); continue; }
        services.push({ serviceId: hit.id, serviceName: hit.name, servicePrice: hit.price ?? 0, sessions });
      }
      return { services, unknown };
    },
    apply(doc, row, { creating, prepared }) {
      const name = String(row.PackageName).trim();
      if (creating) {
        doc.id = slugify(name);
        doc.name = name;
        doc.origin = 'panel';
      }
      doc.name = name;
      if (row.Code !== '') doc.code = String(row.Code).trim().toUpperCase();
      if (row.Category !== '') doc.category = String(row.Category).trim();
      const price = num(row.Price);
      if (price !== null) { doc.price = price; if (!doc.originalPrice) doc.originalPrice = price; }
      const days = num(row.ValidityDays);
      if (days !== null && days > 0) { doc.validityDays = days; doc.validityMonths = Math.max(1, Math.round(days / 30)); }
      if (prepared?.services?.length) {
        doc.services = prepared.services;
        // The flag the panel reads to stop saying "contents not published".
        doc.contentsKnown = true;
      }
      const app = bool(row.AppCatalogue);
      if (app !== null) doc.inCatalogue = app;
      return doc;
    },
    exportRow: (d) => ({
      Code: d.code || '',
      PackageName: d.name || '',
      Category: d.category || '',
      Price: d.price ?? '',
      ValidityDays: d.validityDays ?? (d.validityMonths ? d.validityMonths * 30 : ''),
      Services: (d.services || []).map((s) => `${s.serviceName}${(s.sessions ?? 1) > 1 ? ` x${s.sessions}` : ''}`).join('; '),
      AppCatalogue: d.inCatalogue ? 'yes' : 'no',
    }),
  },

  categories: {
    model: () => Category,
    label: 'categories',
    columns: ['id', 'name', 'parentType', 'displayOrder', 'isActive', 'appVisible', 'description'],
    keyOf: (row) => slugify(row.name),
    async find(key, row) {
      if (row.id && mongoose.isValidObjectId(row.id)) {
        const hit = await Category.findById(row.id);
        if (hit) return hit;
      }
      return Category.findOne({ slug: key });
    },
    validate(row) {
      const errors = [];
      if (!String(row.name || '').trim()) errors.push('name is required');
      if (row.id && !mongoose.isValidObjectId(row.id)) errors.push(`id "${row.id}" is not a valid id`);
      return errors;
    },
    apply(doc, row, { creating }) {
      if (creating) doc.slug = slugify(row.name);
      doc.name = row.name;
      if (row.parentType !== '') doc.type = row.parentType;
      if (row.description !== '') doc.description = row.description;
      const visible = bool(row.appVisible); if (visible !== null) doc.isActive = visible;
      const active = bool(row.isActive); if (active !== null) doc.isActive = active;
      const order = num(row.displayOrder); if (order !== null) doc.displayOrder = order;
      return doc;
    },
    exportRow: (d) => ({
      id: String(d._id),
      name: d.name || '',
      parentType: d.type || '',
      displayOrder: d.displayOrder ?? 0,
      isActive: d.isActive === false ? 'no' : 'yes',
      appVisible: d.isActive === false ? 'no' : 'yes',
      description: d.description || '',
    }),
  },

  products: {
    model: () => Product,
    label: 'products',
    columns: [
      'zenotiProductId', 'sku', 'name', 'brand', 'formulation', 'category', 'subCategory',
      'productType', 'packSize', 'hsn', 'mrp', 'quantity', 'price', 'gstPercentage',
      'isRx', 'isActive', 'appVisible', 'image',
    ],
    keyOf: (row) => String(row.sku || row.name || '').trim().toLowerCase(),
    async find(key, row) {
      if (row.zenotiProductId) {
        const hit = await Product.findOne({ zenotiProductId: String(row.zenotiProductId) });
        if (hit) return hit;
      }
      if (row.sku) {
        const hit = await Product.findOne({ $or: [{ sku: row.sku }, { code: row.sku }] });
        if (hit) return hit;
      }
      return Product.findOne({ name: row.name });
    },
    validate(row) {
      const errors = [];
      if (!String(row.name || '').trim()) errors.push('name is required');
      if (row.price !== '' && num(row.price) === null) errors.push(`price "${row.price}" is not a number`);
      if (row.quantity !== '' && num(row.quantity) === null) errors.push(`quantity "${row.quantity}" is not a number`);
      if (row.mrp !== undefined && row.mrp !== '' && num(row.mrp) === null) errors.push(`mrp "${row.mrp}" is not a number`);
      if (row.isRx !== undefined && row.isRx !== '' && bool(row.isRx) === null) errors.push(`isRx "${row.isRx}" must be yes or no`);
      const gst = num(row.gstPercentage);
      if (row.gstPercentage !== '' && (gst === null || gst < 0 || gst > 100)) errors.push(`gstPercentage "${row.gstPercentage}" must be 0-100`);
      return errors;
    },
    apply(doc, row, { creating }) {
      if (creating) {
        doc.description = row.description || row.name;
        doc.formulation = row.formulation || 'Not specified';
        doc.OrgName = row.brand || 'Zennara';
        doc.price = num(row.price, 0);
        doc.gstPercentage = num(row.gstPercentage, 18);
        // A bulk-imported product is a stock record first. Publishing it is a
        // separate, deliberate act — the same rule the Zenoti sync follows.
        doc.isActive = false;
      }
      doc.name = row.name;
      if (row.sku !== '') doc.sku = row.sku;
      if (row.brand !== '') doc.brand = row.brand;
      if (row.formulation !== '') doc.formulation = row.formulation;
      if (row.category !== '') doc.productCategory = row.category;
      if (row.subCategory !== undefined && row.subCategory !== '') doc.productSubCategory = row.subCategory;
      if (row.productType !== undefined && row.productType !== '') { doc.productType = row.productType; doc.isRetail = !/consum/i.test(row.productType); }
      if (row.packSize !== undefined && row.packSize !== '') doc.packSize = row.packSize;
      if (row.hsn !== undefined && row.hsn !== '') doc.hsn = String(row.hsn).trim();
      if (row.mrp !== undefined && row.mrp !== '') doc.mrp = num(row.mrp, doc.mrp);
      // Rx/OTC from a sheet is a deliberate decision (the clinic's own list).
      const rx = bool(row.isRx); if (rx !== null) { doc.isRx = rx; doc.rxSource = 'import'; doc.rxReason = 'Bulk import'; }
      if (row.image !== '') doc.image = row.image;
      if (row.zenotiProductId !== '') doc.zenotiProductId = String(row.zenotiProductId);
      if (row.price !== '') doc.price = num(row.price, doc.price);
      if (row.gstPercentage !== '') doc.gstPercentage = num(row.gstPercentage, doc.gstPercentage);
      if (row.quantity !== '') doc.stock = num(row.quantity, doc.stock);
      const visible = bool(row.appVisible); if (visible !== null) doc.isActive = visible;
      const active = bool(row.isActive); if (active !== null) doc.isActive = active;
      return doc;
    },
    exportRow: (d) => ({
      zenotiProductId: d.zenotiProductId || '',
      sku: d.sku || d.code || '',
      name: d.name || '',
      brand: d.brand || d.OrgName || '',
      formulation: d.formulation || '',
      category: d.productCategory || '',
      subCategory: d.productSubCategory || '',
      productType: d.productType || (d.isRetail === false ? 'Consumable' : d.isRetail === true ? 'Retail' : ''),
      packSize: d.packSize || '',
      hsn: d.hsn || '',
      mrp: d.mrp ?? '',
      quantity: d.stock ?? 0,
      price: d.price ?? '',
      gstPercentage: d.gstPercentage ?? '',
      isRx: d.isRx === true ? 'yes' : d.isRx === false ? 'no' : '',
      isActive: d.isActive === false ? 'no' : 'yes',
      appVisible: d.isActive === false ? 'no' : 'yes',
      image: d.image || '',
    }),
  },
};

function entityOf(req, res) {
  const entity = ENTITIES[String(req.params.entity || '').toLowerCase()];
  if (!entity) {
    res.status(404).json({ success: false, message: `Unknown import type. Expected one of: ${Object.keys(ENTITIES).join(', ')}` });
    return null;
  }
  return entity;
}

/**
 * Parse + validate + classify, without writing.
 * Shared by preview and commit so the two can never disagree on what a row means.
 */
async function analyse(entity, file) {
  // The entity's own columns are handed to the parser so it can find the header
  // row inside a file that opens with Zenoti's title rows.
  const { headers, records } = readWorkbook(file, entity.columns);
  const missing = (entity.required || ['name']).filter((c) => !headers.includes(c));
  if (missing.length) {
    const err = new Error(`The file is missing required column(s): ${missing.join(', ')}. Download the template to see the expected headers.`);
    err.status = 400;
    throw err;
  }

  const seen = new Map();
  const rows = [];

  for (const { row, data } of records) {
    const errors = entity.validate(data);
    const key = entity.keyOf(data);
    if (!key) errors.push('could not derive a key for this row');

    // Duplicate WITHIN the file — two rows claiming the same record would
    // silently overwrite each other, so the second is refused, not merged.
    if (key && seen.has(key)) {
      errors.push(`duplicate of row ${seen.get(key)} in this file`);
    } else if (key) {
      seen.set(key, row);
    }

    let existing = null;
    if (!errors.length) existing = await entity.find(key, data);

    // Some rows reference other records by name (a package lists its services).
    // Resolving that at preview time is the difference between "3 rows will
    // import with missing contents" and finding out afterwards.
    let warnings = [];
    if (!errors.length && entity.previewPrepare && entity.prepare) {
      const prepared = await entity.prepare(data).catch(() => null);
      if (prepared?.unknown?.length) {
        warnings = [`not in the service catalogue, will be skipped: ${prepared.unknown.join(', ')}`];
      }
    }

    rows.push({
      row,
      key,
      data,
      action: errors.length ? 'error' : existing ? 'update' : 'create',
      existingId: existing?._id || null,
      existingName: existing?.name || null,
      errors,
      warnings,
    });
  }

  return {
    total: rows.length,
    creates: rows.filter((r) => r.action === 'create').length,
    updates: rows.filter((r) => r.action === 'update').length,
    errors: rows.filter((r) => r.action === 'error').length,
    warnings: rows.filter((r) => r.warnings?.length).length,
    taxonomy: await taxonomyReport(entity, rows),
    rows,
  };
}

/**
 * Categories and sub-categories the file introduces, and the near-duplicates.
 *
 * Zenoti's own data has "body countouring ", "Body Countouring" and
 * "Medical Treatment" / "Medical Treatments" side by side. Importing those
 * verbatim gives the panel three filters for one category, so the preview
 * names them before anyone commits: what is new, and what looks like a
 * spelling variant of something already on the books.
 */
async function taxonomyReport(entity, rows) {
  if (!entity.taxonomy) return null;
  const Model = entity.model();
  const [catField, subField] = entity.taxonomy;

  const level = async (field, pick) => {
    const incoming = new Map();
    rows.forEach((r) => {
      const v = String(pick(r.data) || '').trim();
      if (!v) return;
      const k = v.toLowerCase().replace(/\s+/g, ' ');
      incoming.set(k, { value: v, rows: (incoming.get(k)?.rows || 0) + 1 });
    });
    const known = (await Model.distinct(field, { isArchived: { $ne: true } })).filter(Boolean);
    const knownKeys = new Map(known.map((k) => [String(k).toLowerCase().replace(/\s+/g, ' '), k]));
    // "Medical Treatment" vs "Medical Treatments" — same word stem, different row.
    const stem = (k) => k.replace(/[^a-z0-9]/g, '').replace(/s$/, '');
    const knownStems = new Map(known.map((k) => [stem(String(k).toLowerCase()), k]));

    const created = []; const matched = []; const nearDuplicates = [];
    for (const [k, info] of incoming) {
      if (knownKeys.has(k)) { matched.push({ value: info.value, rows: info.rows }); continue; }
      const near = knownStems.get(stem(k));
      if (near) nearDuplicates.push({ value: info.value, rows: info.rows, existing: near });
      else created.push({ value: info.value, rows: info.rows });
    }
    return {
      new: created.sort((a, b) => b.rows - a.rows),
      existing: matched.length,
      nearDuplicates: nearDuplicates.sort((a, b) => b.rows - a.rows),
    };
  };

  return {
    categories: await level(catField, (d) => d[entity.taxonomyColumns[0]]),
    subCategories: subField ? await level(subField, (d) => d[entity.taxonomyColumns[1]]) : null,
  };
}

/** POST /api/bulk/:entity/preview — multipart `file`. Writes nothing. */
exports.preview = async (req, res) => {
  const entity = entityOf(req, res);
  if (!entity) return undefined;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Attach a CSV or XLSX file' });
    const result = await analyse(entity, req.file);
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('bulk preview failed:', error);
    return res.status(500).json({ success: false, message: 'Could not read the file' });
  }
};

/**
 * POST /api/bulk/:entity/commit — multipart `file`, plus:
 *   mode=create|update|both   which rows to apply (default both)
 *
 * Rows with errors are always skipped and reported; they never block the
 * valid rows, because a 400-row catalogue with three typos should import 397.
 */
exports.commit = async (req, res) => {
  const entity = entityOf(req, res);
  if (!entity) return undefined;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Attach a CSV or XLSX file' });

    const mode = ['create', 'update', 'both'].includes(String(req.body?.mode || '')) ? req.body.mode : 'both';
    // Re-validated here rather than trusting the preview: the client may have
    // skipped it, and the catalogue may have changed since.
    const analysis = await analyse(entity, req.file);

    const Model = entity.model();
    const failed = [];
    let created = 0;
    let updated = 0;

    for (const r of analysis.rows) {
      if (r.action === 'error') { failed.push({ row: r.row, name: r.data.name || r.data.ServiceName || '', errors: r.errors }); continue; }
      if (r.action === 'create' && mode === 'update') continue;
      if (r.action === 'update' && mode === 'create') continue;

      try {
        const creating = r.action === 'create';
        const doc = creating ? new Model() : await Model.findById(r.existingId);
        if (!doc) { failed.push({ row: r.row, name: r.data.name || r.data.ServiceName || '', errors: ['record disappeared while importing'] }); continue; }
        // Identifiers that must be unique are resolved against the database
        // immediately before the write, not from the preview.
        const prepared = creating && entity.prepare ? await entity.prepare(r.data) : null;
        entity.apply(doc, r.data, { creating, prepared });
        await doc.save();
        if (creating) created += 1; else updated += 1;
      } catch (err) {
        failed.push({ row: r.row, name: r.data.name || r.data.ServiceName || '', errors: [err.message] });
      }
    }

    await AdminAuditLog.logAction({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email,
      action: 'BULK_IMPORT',
      resource: entity.label === 'products' ? 'PRODUCT' : 'CATALOGUE',
      details: { entity: entity.label, mode, created, updated, failed: failed.length, file: req.file.originalname },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
      status: failed.length ? 'WARNING' : 'SUCCESS',
    }).catch(() => {});

    return res.json({
      success: true,
      data: {
        created,
        updated,
        failed: failed.length,
        skipped: analysis.total - created - updated - failed.length,
        // The caller turns this into the downloadable error report.
        errors: failed,
      },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('bulk commit failed:', error);
    return res.status(500).json({ success: false, message: 'The import could not be completed' });
  }
};

/** GET /api/bulk/:entity/export — CSV of everything, ready to re-import. */
exports.exportEntity = async (req, res) => {
  const entity = entityOf(req, res);
  if (!entity) return undefined;
  try {
    const docs = await entity.model().find(entity.exportFilter || {}).lean();
    const csv = toCsv(entity.columns, docs.map(entity.exportRow));

    await AdminAuditLog.logAction({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email,
      action: 'BULK_EXPORT',
      resource: entity.label === 'products' ? 'PRODUCT' : 'CATALOGUE',
      details: { entity: entity.label, rows: docs.length },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
      status: 'SUCCESS',
    }).catch(() => {});

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zennara-${entity.label}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error('bulk export failed:', error);
    return res.status(500).json({ success: false, message: 'Could not build the export' });
  }
};

/**
 * GET /api/bulk/:entity/template — an empty file with the right headers.
 * Removes the commonest import failure: a hand-made file with wrong columns.
 */
exports.template = async (req, res) => {
  const entity = entityOf(req, res);
  if (!entity) return undefined;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="zennara-${entity.label}-template.csv"`);
  return res.send(toCsv(entity.columns, []));
};

module.exports.ENTITIES = ENTITIES;


/**
 * GET /api/bulk/price-list?format=csv|html&branchId=
 * Zenoti's "Price list" export: services and packages as a guest-facing
 * price sheet (name, duration, price incl. GST at the chosen centre).
 */
exports.priceList = async (req, res) => {
  try {
    const Consultation = require('../models/Consultation');
    const Package = require('../models/Package');
    const Branch = require('../models/Branch');
    const branch = req.query.branchId && /^[0-9a-f]{24}$/i.test(req.query.branchId) ? await Branch.findById(req.query.branchId).lean() : null;
    const services = await Consultation.find({ isActive: { $ne: false } }).sort({ category: 1, name: 1 });
    const packages = await Package.find({ isActive: true }).sort({ name: 1 });
    const inr = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const svcRows = services.map((s) => { const p = typeof s.priceAt === 'function' ? s.priceAt(branch?._id) : { total: s.price, taxPercent: 0, available: true }; return { kind: 'Service', category: s.category || '', name: s.name, code: s.code || '', duration: s.duration_minutes || '', price: p.total, tax: p.taxPercent, available: p.available !== false }; }).filter((r) => r.available);
    const pkgRows = packages.map((p) => { const pr = typeof p.priceAt === 'function' ? p.priceAt(branch?._id) : { total: p.price, taxPercent: 5, available: true }; return { kind: 'Package', category: p.category || 'Packages', name: p.name, code: p.code || '', duration: (p.services || []).reduce((n, s) => n + (Number(s.sessions) || 1), 0) + ' sessions', price: pr.total, tax: pr.taxPercent, available: pr.available !== false }; }).filter((r) => r.available);
    const rows = [...svcRows, ...pkgRows];
    const stamp = new Date().toISOString().slice(0, 10);
    if (req.query.format === 'html') {
      const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const byCat = new Map();
      for (const r of rows) { const k = `${r.kind === 'Package' ? 'Packages · ' : ''}${r.category}`; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(r); }
      const sections = [...byCat.entries()].map(([cat, list]) => `<h2>${esc(cat)}</h2><table><tbody>${list.map((r) => `<tr><td>${esc(r.name)}${r.code ? ` <span class="c">${esc(r.code)}</span>` : ''}</td><td class="d">${esc(r.duration)}${r.kind === 'Service' && r.duration ? ' min' : ''}</td><td class="p">₹${inr(r.price)}</td></tr>`).join('')}</tbody></table>`).join('');
      res.type('html');
      return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Zennara price list</title><style>body{font-family:Manrope,Arial,sans-serif;max-width:760px;margin:24px auto;color:#1a1a1a;padding:0 16px}h1{font-size:22px;margin:0}h2{font-size:14px;margin:22px 0 6px;color:#2c3e2f;border-bottom:1px solid #ddd;padding-bottom:4px}table{width:100%;border-collapse:collapse}td{padding:5px 0;font-size:13px;border-bottom:1px dotted #eee}.d{color:#666;width:120px}.p{text-align:right;font-weight:700;width:110px}.c{color:#999;font-size:10.5px}.sub{color:#666;font-size:12px}@media print{body{margin:0}}</style></head><body><h1>Zennara Clinics — Price list</h1><div class="sub">${esc(branch?.name || 'All centres')} · ${stamp} · prices include GST</div>${sections}<p class="sub">Prices may change without notice. Consultation required before certain treatments.</p></body></html>`);
    }
    const csv = toCsv(['Type', 'Category', 'Name', 'Code', 'Duration / sessions', 'Price (incl. GST)', 'GST %'], rows.map((r) => [r.kind, r.category, r.name, r.code, r.duration, r.price, r.tax]));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zennara-price-list-${stamp}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error('price list failed:', error);
    return res.status(500).json({ success: false, message: 'Could not build the price list' });
  }
};
