/**
 * Fold what a customer bought AT THE CLINIC into the same records the app and
 * panel already use.
 *
 *   Zenoti user-package  →  PackageAssignment  (source 'zenoti')
 *   Zenoti counter sale  →  ProductOrder       (source 'zenoti')
 *
 * Until now a package bought in Zenoti lived only in a per-customer "clinic
 * data" blob and was drawn as a separate list. That is the split the clinic
 * asked to end: a customer has ONE list of packages and ONE order history,
 * wherever each entry came from. The Zenoti ids are the idempotency keys, so
 * however many passes run, one purchase is one record.
 *
 * Read-only against Zenoti; and every record written here carries the Zenoti
 * invoice id, which is exactly what the outbound hooks check, so nothing
 * mirrored in is ever pushed back out.
 */
const PackageAssignment = require('../models/PackageAssignment');
const ProductOrder = require('../models/ProductOrder');
const Package = require('../models/Package');
const Product = require('../models/Product');
const Consultation = require('../models/Consultation');
const Branch = require('../models/Branch');
const logger = require('../utils/logger');

const { buildMatcher } = require('../utils/catalogueMatch');

const escapeRx = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (v) => new RegExp(`^${escapeRx(String(v || '').trim())}$`, 'i');

/*
 * The catalogue is loaded once and matched in memory: a guest's history has
 * dozens of lines and there are thousands of guests, and sale names are old
 * spellings with prices baked in ("Azelac r u serum - 2650"), so a database
 * regex per line was both slow and nearly blind. Pools refresh every few
 * minutes, or at once when this module creates a new row.
 */
const POOL_TTL_MS = 5 * 60 * 1000;
let pools = null;
let poolsAt = 0;
async function getPools(force = false) {
  if (pools && !force && Date.now() - poolsAt < POOL_TTL_MS) return pools;
  const [packages, consultations, products, branches] = await Promise.all([
    Package.find({}).select('_id id name price originalPrice services zenotiPackageId').lean(),
    Consultation.find({}).select('_id id name price zenotiServiceId').lean(),
    Product.find({}).select('_id name image price isRetail zenotiProductId').lean(),
    Branch.find({}).select('_id name address zenotiCenterId').lean(),
  ]);
  const idMap = (rows, key) => new Map(rows.filter((r) => r[key]).map((r) => [String(r[key]).toLowerCase(), r]));
  pools = {
    packageByZenotiId: idMap(packages, 'zenotiPackageId'),
    packageByName: buildMatcher(packages),
    consultationByZenotiId: idMap(consultations, 'zenotiServiceId'),
    consultationByName: buildMatcher(consultations),
    productByZenotiId: idMap(products, 'zenotiProductId'),
    // Retail first; a same-named consumable is not what a customer bought.
    retailByName: buildMatcher(products.filter((p) => p.isRetail !== false)),
    productByName: buildMatcher(products),
    branchByZenotiId: idMap(branches, 'zenotiCenterId'),
    branchByName: buildMatcher(branches),
  };
  poolsAt = Date.now();
  return pools;
}
const lower = (v) => (v ? String(v).toLowerCase() : null);
const slugify = (v) => String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The catalogue package this purchase is of — created hidden if unknown. */
async function packageFor(zp) {
  if (!zp?.name) return null;
  const P = await getPools();
  const found = (zp.packageId && P.packageByZenotiId.get(lower(zp.packageId))) || P.packageByName(zp.name);
  if (found) return found;
  const services = [];
  for (const svc of zp.services || []) {
    if (!svc?.name) continue;
    const c = (svc.serviceId && P.consultationByZenotiId.get(lower(svc.serviceId))) || P.consultationByName(svc.name);
    if (c) services.push({ serviceId: c.id, serviceName: c.name, servicePrice: c.price || 0, sessions: Math.max(1, Number(svc.total) || 1) });
  }
  const pkg = new Package({
    id: `pkg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: String(zp.name).trim(),
    description: `${zp.name} — first seen as a clinic purchase. Review and publish in the panel.`,
    services,
    price: Number(zp.price) > 0 ? Number(zp.price) : 0,
    zenotiPackageId: zp.packageId ? String(zp.packageId).toLowerCase() : undefined,
    isActive: false,
  });
  await pkg.save({ validateModifiedOnly: true });
  await getPools(true);
  return pkg.toObject();
}

/** Rebuild a session list from Zenoti's per-service totals, keeping our booked ones. */
function sessionsFrom(zp, existing = []) {
  const keep = existing.filter((s) => s.bookingId); // booked here — never lose the link
  const out = [...keep];
  for (const svc of zp.services || []) {
    const total = Math.max(0, Number(svc.total) || 0);
    const used = Math.max(0, Number(svc.used) || 0);
    const already = keep.filter((s) => String(s.serviceName || '').toLowerCase() === String(svc.name || '').toLowerCase()).length;
    for (let i = already; i < total; i += 1) {
      out.push({
        serviceId: svc.serviceId || '',  // Zenoti's id when the history carried one
        serviceName: svc.name || '',
        status: i < used ? 'Completed' : 'Scheduled',
        completedAt: i < used ? (zp.purchaseDate ? new Date(zp.purchaseDate) : null) : null,
      });
    }
  }
  return out;
}

async function mirrorGuestPackages(user, packages) {
  const stats = { seen: 0, created: 0, updated: 0, failed: 0 };
  for (const zp of packages || []) {
    if (!zp?.id) continue;
    stats.seen += 1;
    try {
      const pkg = await packageFor(zp);
      if (!pkg) continue;
      // Zenoti's catalogue hides package line items; the purchase shows them.
      // A package still without a service list takes this purchase's.
      if (!(pkg.services || []).length && (zp.services || []).length) {
        const P = await getPools();
        const services = zp.services.filter((svc) => svc?.name).map((svc) => {
          const c = (svc.serviceId && P.consultationByZenotiId.get(lower(svc.serviceId))) || P.consultationByName(svc.name);
          return { serviceId: c?.id || '', serviceName: c?.name || svc.name, servicePrice: c?.price || 0, sessions: Math.max(1, Number(svc.total) || 1) };
        });
        if (services.length) {
          await Package.updateOne({ _id: pkg._id, $or: [{ services: { $size: 0 } }, { services: { $exists: false } }] }, { $set: { services } });
          pkg.services = services;
        }
      }
      const branch = zp.centerName ? (await getPools()).branchByName(zp.centerName) : null;

      let a = await PackageAssignment.findOne({ zenotiUserPackageId: String(zp.id) });
      const isNew = !a;
      if (!a) a = new PackageAssignment({ userId: user._id, packageId: pkg._id, zenotiUserPackageId: String(zp.id), source: 'zenoti' });

      // Zenoti-owned facts are refreshed every pass; our own additions
      // (booked sessions, notes) are preserved.
      a.userId = user._id;
      a.packageId = pkg._id;
      a.packageDetails = {
        packageName: pkg.name,
        packagePrice: Number(zp.price) > 0 ? Number(zp.price) : pkg.price,
        originalPrice: pkg.originalPrice || pkg.price,
        services: (pkg.services || []).map((s) => ({ serviceId: s.serviceId, serviceName: s.serviceName })),
      };
      a.userDetails = { fullName: user.fullName, email: user.email, phone: user.phone, patientId: user.patientId, memberType: user.memberType };
      a.pricing = { ...(a.pricing?.toObject?.() || a.pricing || {}), originalAmount: Number(zp.price) > 0 ? Number(zp.price) : pkg.price, discountPercentage: 0, isZenMemberDiscount: false };
      a.payment = { isReceived: true, receivedDate: zp.purchaseDate ? new Date(zp.purchaseDate) : new Date(), paymentMethod: 'Other', transactionId: zp.invoice?.number || zp.invoice?.receiptNumber || null };
      a.validFrom = zp.startDate ? new Date(zp.startDate) : (zp.purchaseDate ? new Date(zp.purchaseDate) : a.validFrom);
      a.validUntil = zp.neverExpires ? null : (zp.endDate ? new Date(zp.endDate) : a.validUntil);
      a.preferredLocation = branch?.name || zp.centerName || a.preferredLocation || '';
      a.branchId = branch?._id || a.branchId || null;
      a.sessions = sessionsFrom(zp, a.sessions || []);
      const remaining = a.sessions.filter((s) => s.status === 'Scheduled').length;
      const expired = a.validUntil && new Date(a.validUntil) < new Date();
      a.status = a.status === 'Cancelled' ? 'Cancelled' : remaining === 0 && a.sessions.length ? 'Completed' : expired ? 'Expired' : 'Active';
      a.zenotiInvoiceId = zp.invoice?.id || a.zenotiInvoiceId || null;
      a.zenotiInvoiceNumber = zp.invoice?.number || a.zenotiInvoiceNumber || null;
      a.zenotiPackageId = pkg.zenotiPackageId || a.zenotiPackageId || null;
      a.zenotiSyncStatus = 'synced';
      a.zenotiSyncedAt = new Date();
      a.assignedByName = a.assignedByName || 'Zenoti (clinic purchase)';
      a.$locals.skipZenotiWrite = true;
      await a.save({ validateModifiedOnly: true });
      // The purchase happened on Zenoti's date, not on the mirror run. createdAt is
      // immutable through Mongoose, so it is set through the driver.
      const purchasedAt = a.payment?.receivedDate || a.validFrom || null;
      if (purchasedAt && Math.abs((a.createdAt?.getTime() || 0) - new Date(purchasedAt).getTime()) > 60_000) {
        await PackageAssignment.collection.updateOne({ _id: a._id }, { $set: { createdAt: new Date(purchasedAt) } });
      }
      if (isNew) stats.created += 1; else stats.updated += 1;
    } catch (error) {
      stats.failed += 1;
      logger.warn('Package purchase mirror failed', { userId: user._id, zenotiUserPackageId: zp.id, error: error.message });
    }
  }
  return stats;
}

async function mirrorGuestOrders(user, orders) {
  const stats = { seen: 0, created: 0, skippedNoProduct: 0, failed: 0, unmatched: new Map() };
  for (const zo of orders || []) {
    if (!zo?.name) continue;
    stats.seen += 1;
    const saleId = String(zo.id || `${zo.invoiceNumber || 'inv'}:${zo.name}:${zo.saleDate || ''}`);
    try {
      if (await ProductOrder.exists({ zenotiSaleId: saleId })) continue;
      const P = await getPools();
      const product = (zo.productId && P.productByZenotiId.get(lower(zo.productId))) || P.retailByName(zo.name) || P.productByName(zo.name);
      if (!product) { stats.skippedNoProduct += 1; stats.unmatched.set(zo.name, (stats.unmatched.get(zo.name) || 0) + 1); continue; }

      const qty = Math.max(1, Number(zo.quantity) || 1);
      const total = Number(zo.price) >= 0 ? Number(zo.price) : (product.price || 0) * qty;
      const unit = qty > 0 ? Math.round((total / qty) * 100) / 100 : total;
      const branch = zo.centerName ? P.branchByName(zo.centerName) : null;

      const order = new ProductOrder({
        userId: user._id,
        orderNumber: `ZEN-${(zo.invoiceNumber || saleId).toString().replace(/[^A-Za-z0-9-]/g, '').slice(0, 24)}`,
        items: [{ productId: product._id, productName: product.name, productImage: product.image || '', quantity: qty, price: unit, subtotal: total }],
        shippingAddress: {
          fullName: user.fullName || 'Guest',
          phone: user.phone || '0000000000',
          addressLine1: `Collected at the clinic${zo.centerName ? ` — ${zo.centerName}` : ''}`,
          city: branch?.address?.city || 'Hyderabad',
          state: branch?.address?.state || 'Telangana',
          postalCode: branch?.address?.pincode || '500033',
          country: 'India',
        },
        pricing: { subtotal: total, gst: 0, discount: 0, deliveryFee: 0, total },
        paymentMethod: 'Clinic',
        paymentStatus: 'Paid',
        orderStatus: 'Delivered',
        source: 'zenoti',
        zenotiInvoiceId: zo.invoiceNumber || saleId,
        zenotiSaleId: saleId,
        zenotiSyncStatus: 'synced',
        notes: [zo.soldBy ? `Sold by ${zo.soldBy}` : null, zo.paymentType ? `Paid by ${zo.paymentType}` : null].filter(Boolean).join(' · '),
      });
      await order.save();
      // The sale happened on Zenoti's date, not today's — history must sort truthfully.
      if (zo.saleDate && !Number.isNaN(new Date(zo.saleDate).getTime())) {
        // Through the driver: Mongoose silently drops a $set on the immutable createdAt,
        // which is why every clinic sale had been dated on the day it was mirrored.
        await ProductOrder.collection.updateOne({ _id: order._id }, { $set: { createdAt: new Date(zo.saleDate) } });
      }
      stats.created += 1;
    } catch (error) {
      if (error?.code === 11000) continue; // raced with another pass — already there
      stats.failed += 1;
      logger.warn('Counter sale mirror failed', { userId: user._id, saleId, error: error.message });
    }
  }
  return stats;
}

module.exports = { mirrorGuestPackages, mirrorGuestOrders, getPools };
