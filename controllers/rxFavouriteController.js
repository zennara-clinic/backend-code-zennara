/**
 * A dermatologist's saved prescriptions — the "Favourites" shelf in the
 * prescription builder.
 *
 * Dermatology is repetitive: the same acne set, the same melasma set, the same
 * post-laser aftercare, several times a day. Retyping seven fields per medicine
 * is where prescribing errors come from, so a doctor saves the set once and
 * adds it in one tap — then edits any line, because the guest in front of them
 * is never quite the same as the last one.
 *
 * Scope: a favourite belongs to the doctor who saved it. Marking it `clinic`
 * shares it with every dermatologist, which is how a centre agrees a house
 * protocol without a spreadsheet. Only the owner (or a super admin) can change
 * or retire one, whatever its scope.
 */
const RxFavourite = require('../models/RxFavourite');
const ConsultationNote = require('../models/ConsultationNote');
const logger = require('../utils/logger');

/** The fields a saved line may carry. Anything else the panel sends is dropped. */
const ITEM_FIELDS = [
  'medicine', 'strength', 'formulation', 'dosage', 'frequency',
  'duration', 'timing', 'instructions', 'productId', 'isScheduleH', 'refillAfterDays',
];

const cleanItems = (items) => (Array.isArray(items) ? items : [])
  .map((raw) => {
    const item = {};
    for (const key of ITEM_FIELDS) {
      if (raw?.[key] === undefined || raw?.[key] === '') continue;
      item[key] = key === 'isScheduleH' ? Boolean(raw[key])
        : key === 'refillAfterDays' ? (Number(raw[key]) || null)
          : raw[key];
    }
    return item;
  })
  .filter((item) => String(item.medicine || '').trim());

const serialize = (doc, adminId) => ({
  _id: doc._id,
  name: doc.name,
  category: doc.category,
  description: doc.description,
  items: doc.items,
  advice: doc.advice,
  scope: doc.scope,
  ownerId: doc.ownerId,
  ownerName: doc.ownerName,
  /** The panel hides edit/delete on someone else's shared favourite. */
  mine: String(doc.ownerId) === String(adminId),
  useCount: doc.useCount,
  lastUsedAt: doc.lastUsedAt,
  updatedAt: doc.updatedAt,
});

// @desc    The favourites this dermatologist can use — their own, plus the clinic's
// @route   GET /api/rx-favourites
// @access  Staff (consultationNotes.view)
exports.list = async (req, res) => {
  try {
    const adminId = req.admin?._id;
    const rows = await RxFavourite.find({
      isActive: true,
      $or: [{ ownerId: adminId }, { scope: 'clinic' }],
    })
      .sort({ useCount: -1, updatedAt: -1 })
      .limit(200)
      .lean();
    return res.json({ success: true, count: rows.length, data: rows.map((r) => serialize(r, adminId)) });
  } catch (error) {
    logger.error('Rx favourites list failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not load your saved prescriptions.' });
  }
};

// @desc    Save the current prescription as a favourite
// @route   POST /api/rx-favourites
// @access  Staff (prescriptions.draft)
exports.create = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const items = cleanItems(req.body.items);
    if (!name) return res.status(400).json({ success: false, message: 'Give the prescription a name.' });
    if (!items.length) return res.status(400).json({ success: false, message: 'Add at least one medicine before saving.' });

    /*
     * Re-saving under a name the doctor already uses replaces that favourite
     * rather than failing on the unique index. Refining a protocol is the
     * normal case; being told "name already taken" mid-consultation is not.
     */
    const existing = await RxFavourite.findOne({ ownerId: req.admin._id, name, isActive: true });
    if (existing) {
      Object.assign(existing, {
        items,
        category: req.body.category || existing.category,
        description: req.body.description ?? existing.description,
        advice: req.body.advice ?? existing.advice,
        scope: req.body.scope === 'clinic' ? 'clinic' : existing.scope,
      });
      await existing.save();
      return res.json({ success: true, message: `Updated “${name}”.`, data: serialize(existing, req.admin._id) });
    }

    const doc = await RxFavourite.create({
      name,
      category: req.body.category || null,
      description: req.body.description || null,
      advice: req.body.advice || null,
      items,
      scope: req.body.scope === 'clinic' ? 'clinic' : 'mine',
      ownerId: req.admin._id,
      ownerName: req.admin.name || req.admin.email || null,
    });
    return res.status(201).json({ success: true, message: `Saved “${name}”.`, data: serialize(doc, req.admin._id) });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'You already have a saved prescription with that name.' });
    }
    logger.error('Rx favourite create failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not save the prescription.' });
  }
};

// @desc    Rename, re-scope or re-stock a favourite
// @route   PATCH /api/rx-favourites/:id
// @access  Staff (prescriptions.draft), owner only
exports.update = async (req, res) => {
  try {
    const doc = await RxFavourite.findById(req.params.id);
    if (!doc || !doc.isActive) return res.status(404).json({ success: false, message: 'Saved prescription not found.' });
    // Sharing a favourite with the clinic does not hand over authorship.
    if (String(doc.ownerId) !== String(req.admin._id) && !req.admin.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'This saved prescription belongs to another dermatologist.' });
    }
    if (req.body.name !== undefined) doc.name = String(req.body.name).trim() || doc.name;
    if (req.body.category !== undefined) doc.category = req.body.category || null;
    if (req.body.description !== undefined) doc.description = req.body.description || null;
    if (req.body.advice !== undefined) doc.advice = req.body.advice || null;
    if (req.body.scope !== undefined) doc.scope = req.body.scope === 'clinic' ? 'clinic' : 'mine';
    if (req.body.items !== undefined) {
      const items = cleanItems(req.body.items);
      if (!items.length) return res.status(400).json({ success: false, message: 'A saved prescription needs at least one medicine.' });
      doc.items = items;
    }
    await doc.save();
    return res.json({ success: true, data: serialize(doc, req.admin._id) });
  } catch (error) {
    logger.error('Rx favourite update failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not update the saved prescription.' });
  }
};

// @desc    Retire a favourite (soft delete — past prescriptions keep their history)
// @route   DELETE /api/rx-favourites/:id
// @access  Staff (prescriptions.draft), owner only
exports.remove = async (req, res) => {
  try {
    const doc = await RxFavourite.findById(req.params.id);
    if (!doc || !doc.isActive) return res.status(404).json({ success: false, message: 'Saved prescription not found.' });
    if (String(doc.ownerId) !== String(req.admin._id) && !req.admin.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'This saved prescription belongs to another dermatologist.' });
    }
    doc.isActive = false;
    await doc.save();
    return res.json({ success: true, message: `Removed “${doc.name}”.` });
  } catch (error) {
    logger.error('Rx favourite delete failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not remove the saved prescription.' });
  }
};

// @desc    Count a use, so the shelf orders itself by what this doctor reaches for
// @route   POST /api/rx-favourites/:id/used
// @access  Staff (prescriptions.draft)
exports.markUsed = async (req, res) => {
  try {
    await RxFavourite.updateOne(
      { _id: req.params.id, isActive: true },
      { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
    );
    return res.json({ success: true });
  } catch {
    // Ordering a shelf is never worth failing a consultation over.
    return res.json({ success: true });
  }
};

// @desc    The medicines this dermatologist actually prescribes most
// @route   GET /api/rx-favourites/recent
// @access  Staff (consultationNotes.view)
exports.recent = async (req, res) => {
  try {
    /*
     * Built from what they have really written, not from a list someone
     * curated: the last 200 of their own notes, folded by medicine name, most
     * used first. The most recent line wins for the dose and frequency, so
     * one tap reproduces how they prescribe it now, not how they did a year
     * ago. Their own notes only — another dermatologist's habits are not a
     * useful suggestion, and a clinic-wide list would just be a top-20 of
     * whatever the busiest doctor writes.
     */
    // A note carries the dermatologist's profile slug (doctorId), never the login's id.
    const mine = await require('../utils/doctorIdentity').resolveDoctorForAdmin(req).catch(() => null);
    const who = [
      ...(mine?.doctorId ? [{ doctorId: String(mine.doctorId).toLowerCase() }] : []),
      ...(mine?.name ? [{ doctorName: mine.name }] : []),
      ...(req.admin?.name ? [{ doctorName: req.admin.name }] : []),
    ];
    const notes = await ConsultationNote.find({
      $or: who.length ? who : [{ _id: null }],
      'prescription.0': { $exists: true },
    })
      .select('prescription createdAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const byMedicine = new Map();
    for (const note of notes) {
      for (const item of note.prescription || []) {
        const key = String(item.medicine || '').trim().toLowerCase();
        if (!key) continue;
        const seen = byMedicine.get(key);
        if (seen) { seen.uses += 1; continue; }
        // Notes arrive newest first, so the first sighting is the latest one.
        byMedicine.set(key, {
          uses: 1,
          medicine: item.medicine,
          strength: item.strength || null,
          formulation: item.formulation || null,
          dosage: item.dosage || null,
          frequency: item.frequency || null,
          duration: item.duration || null,
          timing: item.timing || null,
          instructions: item.instructions || null,
          productId: item.productId || null,
          isScheduleH: Boolean(item.isScheduleH),
          refillAfterDays: item.refillAfterDays ?? null,
        });
      }
    }

    const data = [...byMedicine.values()].sort((a, b) => b.uses - a.uses).slice(0, 24);
    return res.json({ success: true, count: data.length, data });
  } catch (error) {
    logger.error('Rx recent failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not load your recent medicines.' });
  }
};
