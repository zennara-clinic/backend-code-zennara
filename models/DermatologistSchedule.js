const mongoose = require('mongoose');

/**
 * When a dermatologist is bookable, and for how long each appointment runs.
 *
 * Consultation slots used to be invented by the app from the centre's opening
 * hours — every hour between open and close, for every dermatologist alike.
 * That has nothing to do with whether the person is actually in that day, so
 * a patient could ask for 3pm on a day the dermatologist was not in the
 * building. This collection is now the only thing that decides.
 *
 * Two layers, the way scheduling tools generally do it:
 *
 *   weekly    the normal week — "Tuesdays at Jubilee Hills, 10:00–13:00"
 *   overrides one specific date, which always wins over the weekly pattern —
 *             a leave day, or a one-off Sunday clinic
 *
 * An override with `unavailable` clears the day. An override with ranges
 * replaces that weekday's ranges for that date only. Nothing is stored per
 * slot: slots are derived from the ranges at read time by the slot engine, so
 * changing `slotMinutes` reshapes the day without a migration.
 *
 * Times are "HH:mm" in clinic-local time and dates are "YYYY-MM-DD" strings,
 * deliberately not `Date`. A slot at 10:00 means 10:00 on the clinic wall
 * clock; storing that as a UTC instant invites an off-by-one the first time
 * someone opens the panel from another timezone.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const rangeSchema = new mongoose.Schema(
  {
    start: {
      type: String,
      required: true,
      match: [HHMM, 'start must be HH:mm'],
    },
    end: {
      type: String,
      required: true,
      match: [HHMM, 'end must be HH:mm'],
    },
  },
  { _id: false },
);

const weeklySchema = new mongoose.Schema(
  {
    /** 0 = Sunday, matching JavaScript's getDay(). */
    day: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    /**
     * Which centre they are sitting at. Null means "any centre this
     * dermatologist is assigned to", which is the sensible default for a
     * single-site clinic and for anyone who does not rotate.
     */
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
    },
    ranges: [rangeSchema],
  },
  { _id: false },
);

const overrideSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
      match: [DATE_KEY, 'date must be YYYY-MM-DD'],
    },
    /** Leave, conference, block-out. Ranges are ignored when this is set. */
    unavailable: {
      type: Boolean,
      default: false,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
    },
    ranges: [rangeSchema],
    note: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
  },
  { _id: false },
);

const dermatologistScheduleSchema = new mongoose.Schema(
  {
    /** Slug shared with `Doctor.doctorId` — "rickson-pereira". */
    doctorId: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    /** Appointment length. Ranges are cut into slots this long. */
    slotMinutes: {
      type: Number,
      default: 30,
      min: 5,
      max: 240,
    },
    /**
     * How close to the appointment someone may still book. Without this a
     * patient can book the 10:00 slot at 09:58 and nobody is expecting them.
     */
    leadTimeHours: {
      type: Number,
      default: 4,
      min: 0,
      max: 720,
    },
    /** How far ahead the calendar opens. */
    horizonDays: {
      type: Number,
      default: 60,
      min: 1,
      max: 365,
    },
    weekly: [weeklySchema],
    overrides: [overrideSchema],
    /**
     * Off means this dermatologist takes no online bookings at all — used
     * when someone is on extended leave, without deleting their pattern.
     */
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  { timestamps: true },
);

/** Minutes from midnight for an "HH:mm" string. */
dermatologistScheduleSchema.statics.toMinutes = function (hhmm) {
  const m = HHMM.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** "HH:mm" for minutes from midnight. */
dermatologistScheduleSchema.statics.toHHMM = function (minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/**
 * A default week for a dermatologist who has never been configured.
 *
 * Returned rather than saved: an empty schedule must mean "not set up yet" so
 * the panel can say so, and writing a default on first read would make every
 * dermatologist look deliberately configured when nobody had touched them.
 */
dermatologistScheduleSchema.statics.blank = function (doctorId) {
  return {
    doctorId,
    slotMinutes: 30,
    leadTimeHours: 4,
    horizonDays: 60,
    weekly: [],
    overrides: [],
    isActive: true,
    configured: false,
  };
};

module.exports = mongoose.model('DermatologistSchedule', dermatologistScheduleSchema);
