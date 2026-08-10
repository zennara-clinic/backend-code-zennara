const parseDateOfBirth = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { day, month, year };
};

const getClinicDateParts = (value) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
};

const ageFromDateOfBirth = (value, now = new Date()) => {
  const dob = parseDateOfBirth(value);
  if (!dob) return null;
  const clinicToday = getClinicDateParts(now);
  let age = clinicToday.year - dob.year;
  const beforeBirthday =
    clinicToday.month < dob.month ||
    (clinicToday.month === dob.month && clinicToday.day < dob.day);
  if (beforeBirthday) age -= 1;
  return age;
};

module.exports = { ageFromDateOfBirth, parseDateOfBirth };
