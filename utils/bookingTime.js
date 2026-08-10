const CLINIC_TIME_ZONE = 'Asia/Kolkata';
const CLINIC_UTC_OFFSET_MINUTES = 330;
const BOOKING_CHANGE_CUTOFF_HOURS = 24;

const datePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'long',
});

const clinicDateParts = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = Object.fromEntries(
    datePartsFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: String(parts.weekday || '').toLowerCase(),
  };
};

const clinicDateKey = (value) => {
  const parts = clinicDateParts(value);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

const parseClockMinutes = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  const twelveHour = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2]);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    hour %= 12;
    if (twelveHour[3].toUpperCase() === 'PM') hour += 12;
    return hour * 60 + minute;
  }

  const twentyFourHour = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!twentyFourHour) return null;
  const hour = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

const clinicDateTime = (dateValue, timeValue) => {
  const parts = clinicDateParts(dateValue);
  const minutes = parseClockMinutes(timeValue);
  if (!parts || minutes === null) return null;

  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute)
      - CLINIC_UTC_OFFSET_MINUTES * 60 * 1000
  );
};

const bookingScheduledAt = (booking) => {
  const date = booking.confirmedDate || booking.preferredDate;
  if (!date) return null;

  const fixedTime = booking.confirmedTime || booking.slotTime;
  if (fixedTime) return clinicDateTime(date, fixedTime);

  const preferred = Array.isArray(booking.preferredTimeSlots)
    ? booking.preferredTimeSlots
        .map((time) => ({ time, minutes: parseClockMinutes(time) }))
        .filter((slot) => slot.minutes !== null)
        .sort((left, right) => left.minutes - right.minutes)
    : [];

  // A treatment awaiting confirmation has several acceptable times. The
  // earliest is the safe cancellation boundary until reception fixes one.
  return preferred.length ? clinicDateTime(date, preferred[0].time) : null;
};

/** Cancellation and rescheduling both close 24 hours before check-in. */
const bookingChangeAllowed = (booking, now = new Date()) => {
  const scheduledAt = bookingScheduledAt(booking);
  if (!scheduledAt) return false;
  return scheduledAt.getTime() - now.getTime()
    > BOOKING_CHANGE_CUTOFF_HOURS * 60 * 60 * 1000;
};

module.exports = {
  BOOKING_CHANGE_CUTOFF_HOURS,
  CLINIC_TIME_ZONE,
  bookingChangeAllowed,
  bookingScheduledAt,
  clinicDateKey,
  clinicDateParts,
  clinicDateTime,
  parseClockMinutes,
};
