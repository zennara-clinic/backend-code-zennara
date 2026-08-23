/**
 * Account deletion with a restorable archive.
 *
 * Deleting an account has two halves, and they must never drift apart:
 *
 *   1. ARCHIVE — copy every document that belongs to the person into one
 *      `DeletedAccountArchive` record (see the model). Nothing is deleted
 *      until this write has succeeded.
 *   2. SCRUB — remove the person from the live collections. Everything that
 *      identifies them is deleted outright. Financial records (orders,
 *      payments, bookings) are kept for accounting but anonymised, so the
 *      panel still reconciles revenue without showing who it came from.
 *
 * `restoreAccount()` reverses step 2 from the archive: the user document and
 * every deleted record go back in with their original `_id`s, and the
 * anonymised financial records get their original fields back.
 */
const mongoose = require('mongoose');

const User = require('../models/User');
const Token = require('../models/Token');
const Address = require('../models/Address');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const Payment = require('../models/Payment');
const PackageAssignment = require('../models/PackageAssignment');
const Notification = require('../models/Notification');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const SupportMessage = require('../models/SupportMessage');
const ContactChangeRequest = require('../models/ContactChangeRequest');
const Review = require('../models/Review');
const ConsultationReview = require('../models/ConsultationReview');
const PackageServiceReview = require('../models/PackageServiceReview');
const TreatmentRating = require('../models/TreatmentRating');
const PreConsultForm = require('../models/PreConsultForm');
const PatientConsentForm = require('../models/PatientConsentForm');
const ServiceCard = require('../models/ServiceCard');
const DeletedAccountArchive = require('../models/DeletedAccountArchive');

/** Collections keyed by `userId` that are deleted outright. */
const DELETED_BY_USER_ID = [
  ['tokens', Token],
  ['addresses', Address],
  ['packageassignments', PackageAssignment],
  ['notifications', Notification],
  ['supportmessages', SupportMessage],
  ['contactchangerequests', ContactChangeRequest],
  ['reviews', Review],
  ['consultationreviews', ConsultationReview],
  ['packageservicereviews', PackageServiceReview],
  ['treatmentratings', TreatmentRating],
  ['preconsultforms', PreConsultForm],
  ['patientconsentforms', PatientConsentForm],
  ['servicecards', ServiceCard],
];

/** Kept for accounting, anonymised in place. */
const ANONYMISED = [
  ['bookings', Booking],
  ['productorders', ProductOrder],
  ['payments', Payment],
];

const SCRUBBED = '[deleted]';

const anonymiseBooking = {
  $set: {
    fullName: SCRUBBED,
    email: SCRUBBED,
    mobileNumber: SCRUBBED,
    notes: '[User account deleted]',
    accountDeleted: true,
  },
};

const anonymiseOrder = {
  $set: {
    'shippingAddress.fullName': SCRUBBED,
    'shippingAddress.phone': SCRUBBED,
    'shippingAddress.addressLine1': SCRUBBED,
    'shippingAddress.addressLine2': SCRUBBED,
    accountDeleted: true,
  },
};

const anonymisePayment = { $set: { accountDeleted: true } };

/**
 * Snapshot + scrub. Returns the archive document.
 * @param {Object} opts
 * @param {import('mongoose').Types.ObjectId|string} opts.userId
 * @param {'user'|'admin'} opts.deletedBy
 * @param {string} [opts.reason]
 * @param {import('mongoose').Types.ObjectId} [opts.adminId]
 */
async function deleteAccount({ userId, deletedBy = 'user', reason = '', adminId = null }) {
  const user = await User.findById(userId).lean();
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  // ---- 1. ARCHIVE ------------------------------------------------------
  const snapshot = { users: [user] };
  const counts = {};

  for (const [name, Model] of [...DELETED_BY_USER_ID, ...ANONYMISED]) {
    const docs = await Model.find({ userId }).lean();
    snapshot[name] = docs;
    counts[name] = docs.length;
  }

  // Chats, and the messages inside them (keyed by chatId, not userId).
  const chats = await Chat.find({ userId }).lean();
  snapshot.chats = chats;
  counts.chats = chats.length;
  const chatIds = chats.map((c) => c._id);
  const messages = chatIds.length ? await Message.find({ chatId: { $in: chatIds } }).lean() : [];
  snapshot.messages = messages;
  counts.messages = messages.length;

  const archive = await DeletedAccountArchive.create({
    originalUserId: user._id,
    email: user.email,
    phone: user.phone,
    fullName: user.fullName,
    patientId: user.patientId,
    deletedBy,
    deletedByAdminId: adminId,
    reason,
    snapshot,
    counts,
  });

  // ---- 2. SCRUB --------------------------------------------------------
  // Anything still upcoming is cancelled so the clinic is not expecting a
  // person who no longer has an account.
  await Booking.updateMany(
    {
      userId,
      status: { $in: ['Confirmed', 'Pending', 'Awaiting Confirmation', 'Rescheduled'] },
      preferredDate: { $gte: new Date() },
    },
    { $set: { status: 'Cancelled', cancellationReason: 'Account deleted by user', cancelledAt: new Date() } }
  );
  await ProductOrder.updateMany(
    { userId, orderStatus: { $in: ['Order Placed', 'Confirmed', 'Processing'] } },
    { $set: { orderStatus: 'Cancelled', cancellationReason: 'Account deleted by user', cancelledAt: new Date() } }
  );

  await Booking.updateMany({ userId }, anonymiseBooking);
  await ProductOrder.updateMany({ userId }, anonymiseOrder);
  await Payment.updateMany({ userId }, anonymisePayment);

  for (const [, Model] of DELETED_BY_USER_ID) {
    await Model.deleteMany({ userId });
  }
  if (chatIds.length) await Message.deleteMany({ chatId: { $in: chatIds } });
  await Chat.deleteMany({ userId });

  await User.findByIdAndDelete(userId);

  return archive;
}

/**
 * Put an archived account back. Refuses if the email or phone is now in use
 * by a different live account (the person signed up again), because two
 * users cannot share a login identity.
 */
async function restoreAccount({ archiveId, adminId = null }) {
  const archive = await DeletedAccountArchive.findById(archiveId);
  if (!archive) {
    const err = new Error('Archive not found');
    err.status = 404;
    throw err;
  }
  if (archive.restoredAt) {
    const err = new Error('This account was already restored');
    err.status = 409;
    throw err;
  }

  const snap = archive.snapshot || {};
  const user = snap.users && snap.users[0];
  if (!user) {
    const err = new Error('Archive has no user record');
    err.status = 422;
    throw err;
  }

  const clash = await User.findOne({
    _id: { $ne: user._id },
    $or: [{ email: user.email }, { phone: user.phone }],
  }).lean();
  if (clash) {
    const err = new Error(
      `Cannot restore: ${clash.email === user.email ? user.email : user.phone} is now used by another account`
    );
    err.status = 409;
    throw err;
  }

  // Raw inserts keep the original _ids and skip validators that may have
  // tightened since the snapshot was taken.
  const db = mongoose.connection.db;
  const insert = async (collection, docs) => {
    if (!docs || !docs.length) return;
    await db.collection(collection).insertMany(docs, { ordered: false }).catch((e) => {
      // Duplicate keys mean the record already exists (e.g. a partial earlier
      // restore) — that is fine; anything else is a real failure.
      if (e.code !== 11000 && !(e.writeErrors && e.writeErrors.every((w) => w.code === 11000))) throw e;
    });
  };

  await insert('users', [user]);
  for (const [name] of DELETED_BY_USER_ID) await insert(name, snap[name]);
  await insert('chats', snap.chats);
  await insert('messages', snap.messages);

  // Financial records were anonymised in place — restore their original fields.
  for (const [name] of ANONYMISED) {
    for (const doc of snap[name] || []) {
      const { _id, ...rest } = doc;
      await db.collection(name).updateOne({ _id }, { $set: rest, $unset: { accountDeleted: '' } });
    }
  }

  archive.restoredAt = new Date();
  archive.restoredByAdminId = adminId;
  await archive.save();
  return archive;
}

module.exports = { deleteAccount, restoreAccount };
