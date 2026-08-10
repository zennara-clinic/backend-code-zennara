const { clinicDateParts, clinicDateTime, parseClockMinutes } = require('./bookingTime');
const { SESSION_SLOT_MINUTES } = require('../config/scheduling');

const formatSlot = (minutes) => {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
};

const getBranchSlotsForDate = (branch, dateValue) => {
  const parts = clinicDateParts(dateValue);
  if (!parts) return [];

  const schedule = branch?.operatingHours?.[parts.weekday];
  if (!schedule?.isOpen) return [];

  const open = parseClockMinutes(schedule.openTime);
  const close = parseClockMinutes(schedule.closeTime);
  const duration = SESSION_SLOT_MINUTES;
  if (open === null || close === null) return [];

  const slots = [];
  for (let cursor = open; cursor + duration <= close; cursor += duration) {
    slots.push(formatSlot(cursor));
  }
  return slots;
};

/**
 * Validate an hour-long session against the clinic's open/close boundary.
 * Doctor calendars may legitimately start at 10:30, so this checks the whole
 * 10:30–11:30 interval without requiring it to match the branch grid's 10:00,
 * 11:00 starts. Treatment preferences use the stricter grid check below.
 */
const validateBranchSession = (branch, dateValue, requestedSlots, now = new Date()) => {
  const dateParts = clinicDateParts(dateValue);
  if (!dateParts) {
    return { ok: false, code: 'INVALID_BOOKING_DATE', message: 'Select a valid appointment date.' };
  }

  const schedule = branch?.operatingHours?.[dateParts.weekday];
  if (!schedule?.isOpen) {
    return {
      ok: false,
      code: 'CLINIC_CLOSED',
      message: 'This clinic is closed on the selected day. Please choose an available date.',
    };
  }

  const requested = Array.isArray(requestedSlots) ? requestedSlots.filter(Boolean) : [];
  if (!requested.length) {
    return { ok: false, code: 'TIME_REQUIRED', message: 'Select at least one appointment time.' };
  }

  const open = parseClockMinutes(schedule.openTime);
  const close = parseClockMinutes(schedule.closeTime);
  const invalid = requested.find((slot) => {
    const start = parseClockMinutes(slot);
    return start === null || open === null || close === null
      || start < open || start + SESSION_SLOT_MINUTES > close;
  });
  if (invalid) {
    return {
      ok: false,
      code: 'TIME_OUTSIDE_CLINIC_HOURS',
      message: 'The full one-hour session must fit inside this clinic\'s working hours.',
    };
  }

  const allFuture = requested.every((slot) => {
    const instant = clinicDateTime(dateValue, slot);
    return instant && instant.getTime() > now.getTime();
  });
  if (!allFuture) {
    return {
      ok: false,
      code: 'BOOKING_TIME_PASSED',
      message: 'The selected appointment times have already passed. Please choose another date or time.',
    };
  }

  return { ok: true };
};

const validateBranchBooking = (branch, dateValue, requestedSlots, now = new Date()) => {
  const session = validateBranchSession(branch, dateValue, requestedSlots, now);
  if (!session.ok) return session;

  const available = getBranchSlotsForDate(branch, dateValue);
  const availableMinutes = new Set(available.map(parseClockMinutes));
  const requested = requestedSlots.filter(Boolean);
  const invalid = requested.find((slot) => !availableMinutes.has(parseClockMinutes(slot)));
  if (invalid) {
    return {
      ok: false,
      code: 'TIME_OUTSIDE_CLINIC_HOURS',
      message: 'Select one of this clinic\'s available one-hour start times.',
    };
  }

  return { ...session, availableSlots: available };
};

module.exports = { getBranchSlotsForDate, validateBranchBooking, validateBranchSession };
