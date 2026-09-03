const mongoose = require('mongoose');
const { bookingChangeAllowed } = require('../utils/bookingTime');

const bookingSchema = new mongoose.Schema({
  // User Reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Booking Reference Number (e.g., ZEN202510078473) - Auto-generated
  referenceNumber: {
    type: String,
    unique: true,
    index: true
  },

  // Consultation/Treatment Reference
  consultationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Consultation',
    // A Zenoti service may not exist in the app catalogue yet. The external
    // service id/name below keep that appointment complete until catalogue
    // mapping is configured; app/reception-created bookings still require it.
    required: [function () { return this.source !== 'zenoti'; }, 'Consultation is required'],
    index: true
  },

  // Personal Details
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  mobileNumber: {
    type: String,
    required: [function () { return this.source !== 'zenoti'; }, 'Mobile number is required'],
    trim: true
  },
  email: {
    type: String,
    required: [function () { return this.source !== 'zenoti'; }, 'Email is required'],
    lowercase: true,
    trim: true
  },

  // Location & Schedule
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: false,
    index: true
  },
  preferredLocation: {
    type: String,
    required: true,
    index: true
  },
  preferredDate: {
    type: Date,
    required: true,
    index: true
  },
  preferredTimeSlots: [{
    type: String,
    required: true
  }],

  /*
   * The one slot this booking holds, "HH:mm" in clinic-local time.
   *
   * `preferredTimeSlots` is the older treatment-flow idea — up to three times
   * the patient would accept, one of which reception later confirms. A
   * dermatologist consultation now books a real slot off their calendar, so
   * there is exactly one time and it is taken the moment payment succeeds.
   */
  slotTime: {
    type: String,
    default: null,
    trim: true
  },

  /*
   * Whether this booking is currently occupying its slot.
   *
   * Exists only so the unique index below can be partial: MongoDB's
   * partialFilterExpression has no $in, so "status is one of the live ones"
   * cannot be expressed there. A plain boolean can, and `releaseSlot()` keeps
   * it in step with status. Without it two people who paid at the same moment
   * both get 10:30 and one of them is turned away at the door.
   */
  slotHeld: {
    type: Boolean,
    default: false
  },

  // Chosen dermatologist (consultation bookings from the app)
  specialistId: {
    type: String,
    trim: true,
    lowercase: true,
    index: true
  },
  specialistName: {
    type: String,
    trim: true
  },
  specialistTier: {
    type: String,
    trim: true
  },

  // Stable reporting identity from Zenoti. This is deliberately separate from
  // `specialistId`, which belongs only to an onboarded app Doctor profile.
  zenotiTherapistId: { type: String, trim: true, lowercase: true, default: null, index: true },
  zenotiTherapistName: { type: String, trim: true, default: '' },

  // Floor assignment — who is delivering the session and where.
  therapistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
  therapistName: { type: String, trim: true, default: '' },
  /** Which therapist reception assigned this session to (their Admin login). */
  assignedTherapistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  assignedTherapistName: { type: String, trim: true, default: null },
  room: { type: String, trim: true, default: '' },

  /**
   * What happened in the chair, written by the therapist at checkout and
   * read by reception for billing. Stored structured so it can be queried
   * and reconciled, not as a notes string.
   */
  session: {
    items: [{
      inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
      name: String,
      batchNo: String,
      qty: { type: Number, default: 0 },
      unit: String,
      rate: { type: Number, default: 0 },
      billable: { type: Boolean, default: false },
    }],
    wastage: [{
      inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
      name: String,
      qty: { type: Number, default: 0 },
      reason: String,
    }],
    serviceFee: { type: Number, default: 0 },
    productTotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    grading: String,
    notes: String,
    therapist: String,
    completedAt: Date,
  },

  // Booking Status
  status: {
    type: String,
    required: true,
    enum: [
      'Awaiting Confirmation',
      'Confirmed',
      'Rescheduled',
      'In Progress',
      'Cancelled',
      'No Show',
      'Completed'
    ],
    default: 'Awaiting Confirmation',
    index: true
  },

  // Session Details (for Confirmed and later statuses)
  confirmedDate: Date,
  confirmedTime: String,
  checkInTime: Date,
  checkOutTime: Date,
  sessionDuration: Number, // in minutes

  // Visit codes — the guest reads these to reception, who verifies them in the
  // panel to check the guest in / out. Stored plaintext on purpose: the code is
  // shown to its own owner on the appointment screen and is a short-lived,
  // low-sensitivity presence check (not a credential).
  checkInCode: { type: String, default: null },
  checkInCodeAt: { type: Date, default: null },
  checkOutCode: { type: String, default: null },
  checkOutCodeAt: { type: Date, default: null },
  // When reception last pushed the code to the guest (guests without the app).
  checkInCodeSentAt: { type: Date, default: null },
  checkOutCodeSentAt: { type: Date, default: null },
  visitCodeLog: [{
    kind: { type: String, enum: ['checkin', 'checkout'] },
    channels: [String],
    failed: [String],
    at: Date,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    byName: String,
  }],
  // Set when staff checked the guest in/out without a code (audited override).
  manualCheckIn: { reason: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }, byName: String, at: Date },
  manualCheckOut: { reason: String, by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }, byName: String, at: Date },

  // Package linkage — set when this appointment was auto-created from a package
  // session (24h before its scheduled date). Such bookings are free (amount 0)
  // and marked included, so the app shows "Included in your package".
  isPackageIncluded: { type: Boolean, default: false },
  packageAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageAssignment', default: null, index: true },
  packageSessionId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Cancellation & Reschedule Info
  cancellationReason: String,
  cancelledAt: Date,
  rescheduledFrom: {
    date: Date,
    time: String
  },
  rescheduledAt: Date,
  // True after the clinic declines a reschedule request (the booking is put
  // back to its original confirmed time). Cleared when a new request is made.
  rescheduleRejected: { type: Boolean, default: false },

  // Rating & Feedback
  rating: {
    type: Number,
    min: 1,
    max: 5
  },
  feedback: String,
  ratedAt: Date,

  // Payment Details
  paymentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment'
  },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending'
  },
  amount: {
    type: Number,
    required: true
  },
  paymentMethod: {
    type: String,
    enum: ['Razorpay', 'Cash', 'Card', 'UPI', 'Package', 'Membership', 'Other'],
    default: 'Razorpay'
  },
  paidAt: Date,
  /** Where the booking was made. */
  source: {
    type: String,
    enum: ['app', 'reception', 'package', 'zenoti'],
    default: 'app'
  },

  // Zenoti write-back (Phase 2): the appointment this booking created in the CRM,
  // and its sync status, for idempotency + observability.
  zenotiAppointmentId: { type: String, default: null },
  zenotiAppointmentGroupId: { type: String, default: null, index: true },
  zenotiAppointmentSegmentId: { type: String, default: null },
  zenotiInvoiceId: { type: String, default: null, index: true },
  zenotiInvoiceItemId: { type: String, default: null },
  zenotiServiceId: { type: String, default: null, index: true },
  externalServiceName: { type: String, default: null, trim: true },
  externalServiceCategory: { type: String, default: null, trim: true },
  zenotiSource: { type: mongoose.Schema.Types.Mixed, default: null },
  zenotiLastInboundAt: { type: Date, default: null },
  zenotiSyncStatus: {
    type: String,
    enum: ['pending', 'synced', 'failed', 'skipped', 'dryrun', null],
    default: null
  },
  zenotiSyncError: { type: String, default: null },
  zenotiSyncedAt: { type: Date, default: null },

  // Metadata
  notes: String,
  /** Set when the owner deleted their account; the record is kept, anonymised, for accounting. */
  accountDeleted: { type: Boolean, default: false },
  adminNotes: String,

}, {
  timestamps: true
});

// Generate unique reference number
bookingSchema.pre('save', async function(next) {
  if (!this.referenceNumber) {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.referenceNumber = `ZEN${year}${month}${day}${random}`;
  }
  next();
});

// Index for efficient queries
bookingSchema.index({ userId: 1, status: 1 });
bookingSchema.index({ preferredDate: 1, preferredLocation: 1 });
bookingSchema.index({ createdAt: -1 });
bookingSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, sparse: true, name: 'one_booking_per_razorpay_order' }
);
bookingSchema.index(
  { razorpayPaymentId: 1 },
  { unique: true, sparse: true, name: 'one_booking_per_razorpay_payment' }
);
bookingSchema.index(
  { zenotiAppointmentId: 1 },
  {
    unique: true,
    partialFilterExpression: { zenotiAppointmentId: { $type: 'string' } },
    name: 'one_booking_per_zenoti_appointment',
  }
);

// Reading a dermatologist's diary for a date range — the slot engine's
// hottest query, run for every calendar paint and every slot list.
bookingSchema.index({ specialistId: 1, preferredDate: 1, status: 1 });

/*
 * One live booking per dermatologist, per date, per slot.
 *
 * The database enforces this rather than the application, because the check
 * and the write cannot be made atomic in application code — two payments
 * verifying at the same instant both read "free" and both insert. Here the
 * second insert fails with E11000 and the caller refunds instead of
 * double-booking.
 *
 * Partial on `slotHeld`, so cancelled bookings drop out of the index and free
 * the slot, and so the many treatment bookings that carry no slot at all do
 * not collide with each other on null.
 */
bookingSchema.index(
  { specialistId: 1, preferredDate: 1, slotTime: 1 },
  {
    unique: true,
    // Only dermatologist diaries have specialistId. Zenoti/general-treatment
    // appointments may legitimately share a time across multiple therapists;
    // indexing null specialist ids made those rows collide with each other.
    partialFilterExpression: { slotHeld: true, specialistId: { $type: 'string' } },
    name: 'one_live_booking_per_slot',
  }
);

/**
 * Keep `slotHeld` honest.
 *
 * A slot is held while the booking is live. Cancelling, or marking a no-show,
 * must put the time back on sale — otherwise the diary slowly fills with slots
 * nobody is coming to.
 */
/**
 * Appointment dates are calendar days at the clinic (IST). Whatever a client
 * sends — a bare YYYY-MM-DD, a UTC instant, a datetime-local string — store
 * the day at IST midnight so "today / tomorrow" never drifts around midnight
 * in the panel or the app.
 */
const toClinicMidnight = (value) => {
  if (!value) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const part = (t) => parts.find((x) => x.type === t)?.value;
  return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00+05:30`);
};
bookingSchema.statics.toClinicMidnight = toClinicMidnight;

bookingSchema.pre('save', function (next) {
  if (this.isModified('preferredDate') && this.preferredDate) this.preferredDate = toClinicMidnight(this.preferredDate);
  if (this.isModified('confirmedDate') && this.confirmedDate) this.confirmedDate = toClinicMidnight(this.confirmedDate);
  if (this.slotTime) {
    const live = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'In Progress', 'Completed'];
    // Zenoti mirrors still block the diary (the slot engine filters on status),
    // but they sit outside the unique-slot race guard: a clinic visit can have
    // several services with one dermatologist at the same time.
    this.slotHeld = live.includes(this.status) && this.source !== 'zenoti';
  } else {
    this.slotHeld = false;
  }
  next();
});

// Virtual for formatted date
bookingSchema.virtual('formattedDate').get(function() {
  if (!this.confirmedDate && !this.preferredDate) return '';
  const date = this.confirmedDate || this.preferredDate;
  return date.toLocaleDateString('en-US', { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' 
  });
});

// Guests can cancel or reschedule only while more than 24 hours remain. The
// panel's admin routes stay separate so clinic staff can still help manually.
bookingSchema.methods.canBeCancelled = function(now = new Date()) {
  return ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'].includes(this.status)
    && bookingChangeAllowed(this, now);
};

// Method to check if booking can be rescheduled. A guest can request a
// reschedule on a confirmed appointment, or re-request while one is pending.
bookingSchema.methods.canBeRescheduled = function(now = new Date()) {
  return ['Confirmed', 'Rescheduled'].includes(this.status)
    && bookingChangeAllowed(this, now);
};

// Remember whether this save created the booking, so the post-save hook only
// pushes newly-created bookings to Zenoti (not every status update).
bookingSchema.pre('save', function (next) {
  this._wasNew = this.isNew;
  this._zenotiOperationalChanged = [
    'status', 'confirmedDate', 'confirmedTime', 'preferredDate', 'slotTime',
    'cancellationReason',
  ].some((path) => this.isModified(path));
  next();
});

// Push a newly-created booking to Zenoti as an appointment. Fire-and-forget and
// gated by ZENOTI_WRITE_MODE — a CRM failure never affects the booking itself.
bookingSchema.post('save', function (doc) {
  if (doc.$locals?.skipZenotiWrite) return;
  if (!doc._wasNew) return;
  if (doc.zenotiAppointmentId || doc.source === 'zenoti') return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncBooking(doc._id).catch(() => {});
    } catch (_) { /* never let CRM wiring affect booking creation */ }
  });
});

// Existing linked appointments also need lifecycle write-back. This separate
// hook intentionally runs only for operational changes and is suppressed by
// the inbound reconciler, preventing a Zenoti → Mongo → Zenoti echo loop.
bookingSchema.post('save', function (doc) {
  if (doc.$locals?.skipZenotiWrite || doc._wasNew || !doc._zenotiOperationalChanged) return;
  if (!doc.zenotiAppointmentId && !doc.zenotiInvoiceId) return;
  // An appointment booked in Zenoti is Zenoti's to run. Its mirrored Booking
  // may change state here (reception, auto jobs) but must never write back.
  if (doc.source === 'zenoti') return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncBookingState(doc._id).catch(() => {});
    } catch (_) { /* lifecycle updates remain best-effort */ }
  });
});

module.exports = mongoose.model('Booking', bookingSchema);
