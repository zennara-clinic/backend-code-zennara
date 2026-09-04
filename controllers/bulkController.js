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
  services: {
    model: () => Consultation,
    label: 'services',
    columns: [
      'zenotiServiceId', 'code', 'name', 'type', 'category', 'durationMinutes',
      'price', 'showPriceInApp', 'isActive', 'appVisible', 'displayOrder', 'summary',
    ],
    /** Slug from the name; the clinic's own service code is not unique. */
    keyOf: (row) => slugify(row.name),
    async find(key, row) {
      if (row.zenotiServiceId) {
        const hit = await Consultation.findOne({ zenotiServiceId: String(row.zenotiServiceId).toLowerCase() });
        if (hit) return hit;
      }
      return Consultation.findOne({ slug: key });
    },
    validate(row) {
      const errors = [];
      if (!String(row.name || '').trim()) errors.push('name is required');
      if (!String(row.category || '').trim()) errors.push('category is required');
      if (row.price !== '' && num(row.price) === null) errors.push(`price "${row.price}" is not a number`);
      if (row.durationMinutes !== '' && num(row.durationMinutes) === null) errors.push(`durationMinutes "${row.durationMinutes}" is not a number`);
      return errors;
    },
    apply(doc, row, { creating }) {
      if (creating) {
        doc.slug = slugify(row.name);
        // Required by the schema and rarely in a spreadsheet; the panel fills
        // the real copy in afterwards.
        doc.summary = row.summary || row.name;
        doc.about = row.summary || row.name;
        doc.price = num(row.price, 0);
      }
      doc.name = row.name;
      if (row.type !== '') doc.type = row.type;
      doc.category = row.category;
      if (row.price !== '') doc.price = num(row.price, doc.price);
      if (row.durationMinutes !== '') doc.duration_minutes = num(row.durationMinutes, null);
      if (row.summary !== '') doc.summary = row.summary;
      if (row.zenotiServiceId !== '') doc.zenotiServiceId = String(row.zenotiServiceId).toLowerCase();
      const show = bool(row.showPriceInApp); if (show !== null) doc.showPriceInApp = show;
      // "appVisible" and "isActive" are the same switch on this model; either
      // column may be used, and isActive wins when both are given.
      const visible = bool(row.appVisible); if (visible !== null) doc.isActive = visible;
      const active = bool(row.isActive); if (active !== null) doc.isActive = active;
      const order = num(row.displayOrder); if (order !== null) doc.displayOrder = order;
      return doc;
    },
    exportRow: (d) => ({
      zenotiServiceId: d.zenotiServiceId || '',
      code: d.slug || '',
      name: d.name || '',
      type: d.type || '',
      category: d.category || '',
      durationMinutes: d.duration_minutes ?? '',
      price: d.price ?? '',
      showPriceInApp: d.showPriceInApp === false ? 'no' : 'yes',
      isActive: d.isActive === false ? 'no' : 'yes',
      appVisible: d.isActive === false ? 'no' : 'yes',
      displayOrder: d.displayOrder ?? 0,
      summary: d.summary || '',
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
      'zenotiProductId', 'sku', 'name', 'brand', 'formulation', 'category',
      'quantity', 'price', 'gstPercentage', 'isActive', 'appVisible', 'image',
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
      quantity: d.stock ?? 0,
      price: d.price ?? '',
      gstPercentage: d.gstPercentage ?? '',
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
  const { headers, records } = readWorkbook(file);
  const missing = ['name'].filter((c) => !headers.includes(c));
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

    rows.push({
      row,
      key,
      data,
      action: errors.length ? 'error' : existing ? 'update' : 'create',
      existingId: existing?._id || null,
      existingName: existing?.name || null,
      errors,
    });
  }

  return {
    total: rows.length,
    creates: rows.filter((r) => r.action === 'create').length,
    updates: rows.filter((r) => r.action === 'update').length,
    errors: rows.filter((r) => r.action === 'error').length,
    rows,
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
      if (r.action === 'error') { failed.push({ row: r.row, name: r.data.name || '', errors: r.errors }); continue; }
      if (r.action === 'create' && mode === 'update') continue;
      if (r.action === 'update' && mode === 'create') continue;

      try {
        const creating = r.action === 'create';
        const doc = creating ? new Model() : await Model.findById(r.existingId);
        if (!doc) { failed.push({ row: r.row, name: r.data.name || '', errors: ['record disappeared while importing'] }); continue; }
        entity.apply(doc, r.data, { creating });
        await doc.save();
        if (creating) created += 1; else updated += 1;
      } catch (err) {
        failed.push({ row: r.row, name: r.data.name || '', errors: [err.message] });
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
    const docs = await entity.model().find({}).lean();
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
