/**
 * One-time safe migration for the dermatologist slot index.
 *
 * The old partial index included `specialistId: null`, which made unrelated
 * Zenoti/treatment appointments at the same time collide. Rebuild it so only a
 * real dermatologist slug participates in the uniqueness constraint.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Booking = require('../models/Booking');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const collection = Booking.collection;
  const indexes = await collection.indexes();
  if (indexes.some((index) => index.name === 'one_live_booking_per_slot')) {
    await collection.dropIndex('one_live_booking_per_slot');
  }
  await collection.createIndex(
    { specialistId: 1, preferredDate: 1, slotTime: 1 },
    {
      unique: true,
      partialFilterExpression: { slotHeld: true, specialistId: { $type: 'string' } },
      name: 'one_live_booking_per_slot',
    }
  );
  process.stdout.write('Dermatologist slot index rebuilt safely.\n');
  await mongoose.disconnect();
}

run().catch(async (error) => {
  process.stderr.write(`${error.message}\n`);
  try { await mongoose.disconnect(); } catch (_) { /* ignore shutdown errors */ }
  process.exitCode = 1;
});
