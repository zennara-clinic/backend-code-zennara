/**
 * The one identifier a guest is known by — Zenoti's guest code ("ZENFD637").
 *
 * That is the code the clinic prints and the guest quotes at the desk, so it
 * wins everywhere an id is shown, searched, copied or exported. `patientId`,
 * the locally generated code, stays as the fallback: a few dozen guests have no
 * Zenoti code of their own (their Zenoti record carries an empty one, or they
 * were never linked to Zenoti at all) and would otherwise show no id.
 */
const guestCodeOf = (user) => user?.guestCode || user?.patientId || null;

module.exports = { guestCodeOf };
