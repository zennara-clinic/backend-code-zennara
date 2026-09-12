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

  /**
   * One desk visit with several services (Zenoti books "Acne facial" and
   * "Exosome" as two rows of one appointment group). Each service is its own
   * Booking — the diary, the slot engine and the mirror all work per service —
   * and this id ties the rows together for the day book and the bill.
   */
  visitGroupId: {
    type: String,
    default: null,
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
      // The guest is at the clinic but the service has not begun. Zenoti keeps
      // this as its own appointment status (2, "Checked in") separately from
      // "In service" (4); collapsing the two here is what made our day book
      // disagree with the Zenoti mobile app about who was actually in a room.
      'Checked In',
      'In Progress',
      'Cancelled',
      'No Show',
      'Completed'
    ],
    default: 'Awaiting Confirmation',
    index: true
  },

  /**
   * The CLINICAL lifecycle of a consultation, alongside the operational
   * `status` above.
   *
   * Deliberately a second field rather than more values in `status`:
   *
   *   · `status` is the diary state. The slot engine's LIVE_STATUSES, the
   *     app's Upcoming/Past tabs, analytics buckets and the Zenoti mirror all
   *     switch on it exhaustively; adding "Prescription Created" there would
   *     silently drop those bookings out of every one of those lists.
   *   · Zenoti has no concept of a prescription or a follow-up decision, so
   *     these values can never be written back to it. Keeping them separate
   *     makes that structural rather than a rule someone has to remember.
   *
   * Reception, the dermatologist panel, admin and the patient app all read
   * this; only the consult room writes it.
   */
  consultationStage: {
    type: String,
    enum: [
      'booked',
      'confirmed',
      'checked_in',
      'waiting',
      'consultation_started',
      'consultation_completed',
      'prescription_created',
      'treatment_recommended',
      'follow_up_required',
      'no_follow_up',
    ],
    default: null,
    index: true,
  },
  /** Audit trail of stage changes, so "who moved this and when" is answerable. */
  consultationStageHistory: [{
    _id: false,
    stage: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    byName: String,
  }],
  /** The follow-up decision taken at the end of the consultation. */
  followUp: {
    required: { type: Boolean, default: false },
    dueDate: { type: Date, default: null },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    /** Set when the follow-up appointment is actually made. */
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
  },

  // Session Details (for Confirmed and later statuses)
  confirmedDate: Date,
  confirmedTime: String,
  checkInTime: Date,
  checkOutTime: Date,
  sessionDuration: Number, // in minutes

  /**
   * Every desk decision that moved this appointment, newest last.
   *
   * Replaces the old visit-code trail. Reception, the dermatologist panel and
   * the app all show the same lifecycle now, so "who checked this guest in,
   * when, and did Zenoti accept it" has to be answerable from the record
   * itself rather than from three different audited side-fields.
   */
  statusLog: [{
    _id: false,
    /** Lifecycle action name, e.g. 'check_in', 'undo_check_in', 'complete'. */
    action: String,
    from: String,
    to: String,
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    byName: String,
    /** Required when staff overrode a rule (early check-in, reopening a visit). */
    reason: String,
    /** True when the action was taken outside its allowed time window. */
    overrode: { type: Boolean, default: false },
    /** 'panel' | 'app' | 'zenoti' | 'system' */
    via: { type: String, default: 'panel' },
    /** What Zenoti did with it: 'synced' | 'failed' | 'skipped' | 'dryrun' | null */
    zenoti: { type: String, default: null },
    zenotiError: { type: String, default: null },
  }],

  // Package linkage — set when this appointment was auto-created from a package
  // session (24h before its scheduled date). Such bookings are free (amount 0)
  // and marked included, so the app shows "Included in your package".
  isPackageIncluded: { type: Boolean, default: false },
  packageAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageAssignment', default: null, index: true },
  packageSessionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  /**
   * Why this consultation was raised, when it is not an ordinary paid one.
   *
   * 'package_support' = a FREE dermatologist consultation the guest asked for
   * from an ongoing treatment package (a check-in with the dermatologist
   * treating them under it). It carries `packageAssignmentId` so the desk can
   * see which package it belongs to, but deliberately NO `packageSessionId`
   * and `isPackageIncluded: false`: it is not one of the package's sessions,
   * so the lifecycle side-effects (bookingLifecycleService
   * applyPackageSessionSideEffect returns early without a session id) never
   * touch the package's balance. Null for every other booking.
   */
  consultContext: { type: String, enum: ['package_support', null], default: null, index: true },

  // Cancellation & Reschedule Info
  cancellationReason: String,
  cancelledAt: Date,
  rescheduledFrom: {
    date: Date,
    time: String,
    /**
     * Why the clinic moved it, in the guest's words. Shown in the app — a
     * guest who opens the booking and finds a different time deserves the
     * reason without having to phone. Distinct from `adminNotes`, which is
     * internal and never leaves the panel.
     */
    reason: String,
    /** 'clinic' when staff moved it; 'guest' for legacy guest-requested moves. */
    by: { type: String, enum: ['clinic', 'guest', null], default: null },
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
    enum: ['Razorpay', 'Cash', 'Card', 'UPI', 'Package', 'Membership', 'Clinic', 'Other'],
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
  /**
   * The Zenoti guest (client) id this appointment belongs to, denormalised
   * from the User at push time.
   *
   * The booking already points at a local userId, but the integration contract
   * is "every booking carries the external client id", and keeping it here
   * means reconciliation and support lookups do not need a join — nor do they
   * silently follow a userId that was later re-linked to a different guest.
   * It is only ever COPIED from User.zenotiGuestId; never generated here.
   */
  zenotiGuestId: { type: String, default: null, index: true },
  /** Zenoti's short-lived /v1/bookings id, distinct from the appointment id. */
  zenotiBookingId: { type: String, default: null },
  zenotiAppointmentId: { type: String, default: null },
  zenotiAppointmentGroupId: { type: String, default: null, index: true },
  zenotiAppointmentSegmentId: { type: String, default: null },
  zenotiInvoiceId: { type: String, default: null, index: true },
  /** The desk bill (Invoice) that settled this visit, once one exists. */
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
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
  /** Short-lived compare-and-set locks prevent two panel clicks creating two Zenoti bookings. */
  zenotiConfirmationLock: {
    token: { type: String, default: null },
    at: { type: Date, default: null },
  },
  zenotiWriteLock: {
    token: { type: String, default: null },
    at: { type: Date, default: null },
  },
  zenotiSyncError: { type: String, default: null },
  zenotiSyncedAt: { type: Date, default: null },

  /**
   * The single instant this appointment "happened at", for ordering.
   *
   * History was coming back in an apparently random sequence — this month,
   * then four years ago, then something else — because every list sorted on
   * two competing fields (`confirmedDate` then `preferredDate`). A booking
   * mirrored from Zenoti has NO confirmedDate, so under a
   * `{ confirmedDate: -1, preferredDate: -1 }` sort every mirrored visit fell
   * to the bottom of the list regardless of its actual date, interleaving old
   * and new.
   *
   * Maintained in the pre-save hook below as
   *   confirmedDate ?? preferredDate ?? createdAt
   * (with the confirmed/slot time folded in so two visits on one day order by
   * the hour). Sort every history list on this, descending, and nothing else.
   */
  eventAt: {
    type: Date,
    default: null,
    index: true,
  },

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
// Newest-first history for one patient, straight off the index.
bookingSchema.index({ userId: 1, eventAt: -1 });
bookingSchema.index({ eventAt: -1 });
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

/**
 * "YYYY-MM-DD midnight" + "HH:mm" → the actual clinic-local instant.
 * Times are stored as wall-clock strings on purpose (see DermatologistSchedule),
 * so the offset is applied here rather than by the server's own timezone.
 */
const withClinicTime = (date, time) => {
  if (!date) return null;
  const base = new Date(date);
  if (Number.isNaN(base.getTime())) return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(time || ''));
  if (!m) return base;
  return new Date(base.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60 * 1000);
};

bookingSchema.pre('save', function (next) {
  if (this.isModified('preferredDate') && this.preferredDate) this.preferredDate = toClinicMidnight(this.preferredDate);
  if (this.isModified('confirmedDate') && this.confirmedDate) this.confirmedDate = toClinicMidnight(this.confirmedDate);
  // One field to sort every history list on. Recomputed on every save so a
  // reschedule moves the booking to its new position immediately.
  this.eventAt =
    withClinicTime(this.confirmedDate, this.confirmedTime || this.slotTime)
    || withClinicTime(this.preferredDate, this.slotTime || (this.preferredTimeSlots || [])[0])
    || this.createdAt
    || new Date();
  if (this.slotTime) {
    const live = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'Checked In', 'In Progress', 'Completed'];
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
  return date.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', 
    day: 'numeric', 
    month: 'long', 
    year: 'numeric' });
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

// Remember what this save did, so the post-save hooks can decide whether the
// booking is due in Zenoti. `_becameConfirmed` is the trigger for the FIRST
// push: it is true when the booking is created already Confirmed (reception)
// or when its status moves to Confirmed (the panel's Confirm button).
bookingSchema.pre('save', function (next) {
  this._wasNew = this.isNew;
  this._becameConfirmed = this.status === 'Confirmed'
    && (this.isNew || this.isModified('status'));
  this._zenotiOperationalChanged = [
    'status', 'confirmedDate', 'confirmedTime', 'preferredDate', 'slotTime',
    'cancellationReason',
  ].some((path) => this.isModified(path));
  next();
});

/*
 * Push a booking to Zenoti as an appointment — but ONLY once the clinic has
 * confirmed it.
 *
 * This used to fire on creation, so an app booking that was still "Awaiting
 * Confirmation" was already sitting in Zenoti's diary before anyone at the
 * desk had looked at it. The agreed flow is the reverse: the customer books,
 * reception confirms in the panel, and THAT confirmation is what creates the
 * Zenoti appointment. A booking created already Confirmed by staff (a walk-in
 * or a package session booked at the desk) is pushed on that same save.
 *
 * Fire-and-forget and gated by ZENOTI_WRITE_MODE — a CRM failure never
 * affects the booking itself.
 */
bookingSchema.post('save', function (doc) {
  if (doc.$locals?.skipZenotiWrite) return;
  if (!doc._becameConfirmed) return;
  if (doc.zenotiAppointmentId || doc.source === 'zenoti') return;
  // A person at the desk must have made the decision: the panel's Confirm sets
  // zenotiStaffAction, and a reception-created booking is a desk decision by
  // definition. Any automated path that happens to write "Confirmed" does NOT
  // reach Zenoti — that is the whole point of the approval step.
  if (!doc.$locals?.zenotiStaffAction && doc.source !== 'reception') return;
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
  // may change state here, but only an explicit decision by a person at the
  // desk (zenotiStaffAction) may ever be offered for write-back — and the
  // service still requires ZENOTI_LIFECYCLE_WRITEBACK=true. Automated jobs
  // never reach Zenoti.
  const staffAction = Boolean(doc.$locals?.zenotiStaffAction);
  if (doc.source === 'zenoti' && !staffAction) return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncBookingState(doc._id, { staffAction }).catch(() => {});
    } catch (_) { /* lifecycle updates remain best-effort */ }
  });
});

module.exports = mongoose.model('Booking', bookingSchema);
