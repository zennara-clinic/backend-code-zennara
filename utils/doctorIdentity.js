/**
 * Which Doctor profile does this staff login belong to?
 *
 * One answer for every place that needs it (fee requests, schedule editing,
 * self-profile edits). Resolution order:
 *   1. Admin.doctorId — the explicit link set under Staff & roles
 *   2. Doctor.email === Admin.email
 *   3. Doctor.name === Admin.name (with a leading "Dr." stripped) — legacy
 */
const Admin = require('../models/Admin');
const Doctor = require('../models/Doctor');

async function resolveDoctorForAdmin(req) {
  const admin = req.admin;
  if (!admin) return null;

  const linked = admin.doctorId
    || (await Admin.findById(admin._id).select('doctorId').lean())?.doctorId;
  if (linked) {
    const byLink = await Doctor.findById(linked).lean();
    if (byLink) return byLink;
  }

  const email = String(admin.email || '').toLowerCase().trim();
  if (email) {
    const byEmail = await Doctor.findOne({ email }).lean();
    if (byEmail) return byEmail;
  }

  if (admin.name) {
    const name = String(admin.name).replace(/^dr\.?\s+/i, '').trim();
    if (name) {
      const byName = await Doctor.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
      if (byName) return byName;
    }
  }
  return null;
}

/** True when this login may edit the given doctor (admins always; doctors only themselves). */
async function canEditDoctor(req, doctorDoc) {
  const role = req.admin?.role;
  if (role === 'super_admin') return true;
  if (role !== 'doctor' || !doctorDoc) return false;
  const mine = await resolveDoctorForAdmin(req);
  return !!mine && String(mine._id) === String(doctorDoc._id);
}

module.exports = { resolveDoctorForAdmin, canEditDoctor };
