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

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Add whole clinic-calendar days without using the server's local timezone. */
const addClinicDays = (key, amount) => {
  if (!DATE_KEY.test(String(key || ''))) return null;
  const [year, month, day] = String(key).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Clinic-midnight instant for an API date value. A YYYY-MM-DD input is a
 * written clinic day; an ISO timestamp is first converted to its clinic day.
 */
const clinicDayStart = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  const key = DATE_KEY.test(raw) ? raw : clinicDateKey(value);
  return key ? clinicDateTime(key, '00:00') : null;
};

/** Inclusive clinic-day end, suitable for existing Mongo `$lte` filters. */
const clinicDayEnd = (value) => {
  const start = clinicDayStart(value);
  if (!start) return null;
  const nextKey = addClinicDays(clinicDateKey(start), 1);
  const next = nextKey ? clinicDateTime(nextKey, '00:00') : null;
  return next ? new Date(next.getTime() - 1) : null;
};

const formatClinicDate = (value, options = {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
}) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: CLINIC_TIME_ZONE }).format(date);
};

const formatClinicDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
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
  addClinicDays,
  bookingChangeAllowed,
  bookingScheduledAt,
  clinicDayEnd,
  clinicDayStart,
  clinicDateKey,
  clinicDateParts,
  clinicDateTime,
  formatClinicDate,
  formatClinicDateTime,
  parseClockMinutes,
};
