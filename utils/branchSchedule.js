const { clinicDateParts, clinicDateTime, parseClockMinutes } = require('./bookingTime');

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
  const duration = Number(branch.slotDuration);
  if (open === null || close === null || !Number.isFinite(duration) || duration <= 0) return [];

  const slots = [];
  for (let cursor = open; cursor + duration <= close; cursor += duration) {
    slots.push(formatSlot(cursor));
  }
  return slots;
};

const validateBranchBooking = (branch, dateValue, requestedSlots, now = new Date()) => {
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

  const available = getBranchSlotsForDate(branch, dateValue);
  const requested = Array.isArray(requestedSlots) ? requestedSlots.filter(Boolean) : [];
  if (!requested.length) {
    return { ok: false, code: 'TIME_REQUIRED', message: 'Select at least one appointment time.' };
  }

  const availableMinutes = new Set(available.map(parseClockMinutes));
  const invalid = requested.find((slot) => !availableMinutes.has(parseClockMinutes(slot)));
  if (invalid) {
    return {
      ok: false,
      code: 'TIME_OUTSIDE_CLINIC_HOURS',
      message: 'One or more selected times are outside this clinic\'s current working hours.',
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

  return { ok: true, availableSlots: available };
};

module.exports = { getBranchSlotsForDate, validateBranchBooking };
