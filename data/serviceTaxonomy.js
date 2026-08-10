/**
 * The clinic's service taxonomy — the single source of truth.
 *
 * Transcribed verbatim from "Consultants and Services list — All Category and
 * Sub category" supplied by the clinic (2026-08-07). Three levels:
 *
 *   Type              →  Skin, Hair, Skin & Hair, Wellness, …
 *     Treatment Category  →  Laser Treatments, Chemical Peels, …
 *       Sub-Category      →  Pico Laser, Glycolic Peel, …   ← the bookable treatment
 *
 * A sub-category IS a treatment: it becomes one `Consultation` document with
 * its own price, photograph and copy. `type` and `category` on that document
 * point back up the tree.
 *
 * Types are stored exactly as the clinic wrote them, including the combined
 * "Skin & Hair" — it is its own type, not a pair of tags.
 */

/** Level 1. `order` drives the filter chips in the app and the panel. */
const TYPES = [
  { name: 'Skin', slug: 'skin', order: 1 },
  { name: 'Hair', slug: 'hair', order: 2 },
  { name: 'Skin & Hair', slug: 'skin-hair', order: 3 },
  { name: 'Wellness', slug: 'wellness', order: 4 },
  { name: 'Aesthetics', slug: 'aesthetics', order: 5 },
  { name: 'Consultations', slug: 'consultations', order: 6 },
  { name: 'Diagnostic Tests', slug: 'diagnostic-tests', order: 7 },
];

/**
 * Levels 2 and 3.
 *
 * A category's own `type` is the type most of its sub-categories carry; each
 * sub-category still declares its own, because a category can mix them —
 * Laser Treatments is mostly Skin but Laser Hair Removal is Hair.
 */
const CATEGORIES = [
  {
    name: 'Laser Treatments',
    type: 'Skin',
    order: 1,
    subCategories: [
      { name: 'Laser Hair Removal (LHR)', type: 'Hair' },
      { name: 'Laser Toning & Photo Treatments', type: 'Skin' },
      { name: 'Pico Laser', type: 'Skin' },
      { name: 'Q-Switch Laser', type: 'Skin' },
      { name: 'HIFU', type: 'Skin' },
      { name: 'Doublo HIFU', type: 'Skin' },
      { name: 'Doublo MNRF', type: 'Skin' },
      { name: 'Tattoo Removal', type: 'Skin' },
    ],
  },
  {
    name: 'Skin Tightening & Body Contouring',
    type: 'Skin',
    order: 2,
    subCategories: [
      { name: 'Forma / RF Treatments', type: 'Skin' },
      { name: 'MNRF (Morpheus)', type: 'Skin' },
      { name: 'M Shape Body Contouring', type: 'Skin' },
      { name: 'Body Sculpting & Fat Reduction', type: 'Skin' },
      { name: '4D Clear Lift', type: 'Skin' },
      { name: 'Glass Rejuvenation', type: 'Skin' },
      { name: 'Stretch Marks & Scars', type: 'Skin' },
    ],
  },
  {
    name: 'Injectables & Fillers',
    type: 'Skin',
    order: 3,
    subCategories: [
      { name: 'Botox / Neurotoxins', type: 'Skin' },
      { name: 'Dermal Fillers – Juvederm', type: 'Skin' },
      { name: 'Dermal Fillers – Restylane', type: 'Skin' },
      { name: 'Dermal Fillers – Teosyal & Definisse', type: 'Skin' },
      { name: 'Skin Boosters & Biostimulators', type: 'Skin' },
      { name: 'Threads', type: 'Skin' },
      { name: 'Hylase', type: 'Skin' },
    ],
  },
  {
    name: 'Chemical Peels',
    type: 'Skin',
    order: 4,
    subCategories: [
      { name: 'Glycolic Peel', type: 'Skin' },
      { name: 'Salicylic Peel', type: 'Skin' },
      { name: 'Nomelan / Mandelic Peel', type: 'Skin' },
      { name: 'Cosmelan / Dermamelan Peel', type: 'Skin' },
      { name: 'Mira Peel', type: 'Skin' },
      { name: 'Specialty Peels', type: 'Skin' },
    ],
  },
  {
    name: 'Facial Treatments',
    type: 'Skin',
    order: 5,
    subCategories: [
      { name: 'Medifacials & Signature Facials', type: 'Skin' },
      { name: 'Aqua Gold Treatments', type: 'Skin' },
      { name: 'LED & Light Therapy', type: 'Skin' },
      { name: 'Skin Resurfacing', type: 'Skin' },
      { name: 'Skin Analysis', type: 'Skin' },
    ],
  },
  {
    name: 'Mesotherapy & Bio-Stimulation',
    type: 'Skin & Hair',
    order: 6,
    subCategories: [
      { name: 'GFC (Growth Factor Concentrate)', type: 'Skin & Hair' },
      { name: 'Exosome Treatments', type: 'Skin & Hair' },
      { name: 'Mesotherapy', type: 'Skin' },
      { name: 'Lumiere Treatments', type: 'Skin & Hair' },
      { name: 'Derma Pen / Micro Needling', type: 'Skin' },
      { name: 'Smart DNA & Retix C', type: 'Skin' },
    ],
  },
  {
    name: 'Hair Treatments',
    type: 'Hair',
    order: 7,
    subCategories: [
      { name: 'Hair Loss & Alopecia', type: 'Hair' },
      { name: 'Scalp Micropigmentation & Microblading', type: 'Hair' },
    ],
  },
  {
    name: 'IV Drips & Wellness',
    type: 'Wellness',
    order: 8,
    subCategories: [
      { name: 'IV Drips', type: 'Wellness' },
      { name: 'Zen Drip Packages', type: 'Wellness' },
      { name: 'NAD+ Therapy', type: 'Wellness' },
      { name: 'Vitamin & Supplement Injections', type: 'Wellness' },
    ],
  },
  {
    name: 'Permanent Makeup & Cosmetic Tattoo',
    type: 'Aesthetics',
    order: 9,
    subCategories: [
      { name: 'Eyebrow Services', type: 'Aesthetics' },
      { name: 'Lip Services', type: 'Aesthetics' },
      { name: 'Eyeliner', type: 'Aesthetics' },
      { name: 'Miscellaneous PMU', type: 'Aesthetics' },
    ],
  },
  {
    name: 'Skin Concerns & Minor Procedures',
    type: 'Skin',
    order: 10,
    subCategories: [
      { name: 'Acne & Active Breakouts', type: 'Skin' },
      { name: 'Pigmentation & Vascular', type: 'Skin' },
      { name: 'Mole, Wart & Lesion Removal', type: 'Skin' },
      { name: 'Biopsy', type: 'Skin' },
      { name: 'Body Treatments', type: 'Skin' },
    ],
  },
  {
    name: 'Consultations',
    type: 'Consultations',
    order: 11,
    subCategories: [
      { name: 'General Consultations', type: 'Consultations' },
      { name: 'Dr. Rickson Consultations', type: 'Consultations' },
      { name: 'Follow-Up Consultations', type: 'Consultations' },
      { name: 'Other Consultations', type: 'Consultations' },
    ],
  },
  {
    name: 'Diagnostic Tests',
    type: 'Diagnostic Tests',
    order: 12,
    subCategories: [
      { name: 'Blood Tests – General', type: 'Diagnostic Tests' },
      { name: 'Hormone & Metabolic Tests', type: 'Diagnostic Tests' },
    ],
  },
  {
    name: 'Add-Ons, Masks & Miscellaneous',
    type: 'Skin',
    order: 13,
    subCategories: [{ name: 'Masks & Boosters', type: 'Skin' }],
  },
];

/**
 * Old catalogue entry → new sub-category.
 *
 * The clinic asked for the old list to be replaced wholesale, but several old
 * entries are the same treatment under a different name and already carry a
 * photograph, a price and a rating. Those are matched here so the content
 * survives the restructure instead of being retyped by hand.
 *
 * Anything not listed has no equivalent in the new taxonomy (Tan Removal,
 * Bridal Treatment, Nutrition, Cellulite Treatment …) and is deactivated —
 * never deleted, because bookings point at it.
 */
const LEGACY_MAP = {
  'Pico Laser (Picosecond Laser)': 'Pico Laser',
  'LHR': 'Laser Hair Removal (LHR)',
  'Laser Toning (Q-Switched Nd:YAG Laser)': 'Laser Toning & Photo Treatments',
  'Morpheus8/MNRF': 'MNRF (Morpheus)',
  'HIFU': 'HIFU',
  'Body Sculpting': 'Body Sculpting & Fat Reduction',
  'Fat Lipolysis Injection': 'Body Sculpting & Fat Reduction',
  'Stretch Marks Treatment': 'Stretch Marks & Scars',
  'Botox': 'Botox / Neurotoxins',
  'Dermal Fillers': 'Dermal Fillers – Juvederm',
  'Boosters': 'Skin Boosters & Biostimulators',
  'Prophilo': 'Skin Boosters & Biostimulators',
  'Salmon Driven PDRN': 'Skin Boosters & Biostimulators',
  'Thread Lift': 'Threads',
  'Professional Peel': 'Specialty Peels',
  'Medi Grade Facial': 'Medifacials & Signature Facials',
  'HydraFacial': 'Medifacials & Signature Facials',
  'LED Therapy': 'LED & Light Therapy',
  'Growth Factor Concentrate': 'GFC (Growth Factor Concentrate)',
  'Exosomes Skin': 'Exosome Treatments',
  'Exosomes Hair': 'Exosome Treatments',
  'Mesotherapy (Hair)': 'Mesotherapy',
  'Alopecia Treatment': 'Hair Loss & Alopecia',
  'IV Drips': 'IV Drips',
  'Microblading / Nanoblading': 'Eyebrow Services',
  'Powder Brows / Ombre Brows': 'Eyebrow Services',
  'Acne Treatments': 'Acne & Active Breakouts',
  'Acne Scar Treatments': 'Acne & Active Breakouts',
  'Pigmentation Treatments': 'Pigmentation & Vascular',
};

/**
 * Catalogue entries the consultation payment flow charges against.
 *
 * `Backend/scripts/seedConsultationTiers.js` created these and
 * `createConsultationPayment` resolves an order from them, so they stay active
 * through the restructure and are simply re-filed under the new taxonomy.
 * Removing them would break consultation checkout.
 */
const PROTECTED_ENTRIES = [
  'Senior Dermatologist Consultation',
  'Dermatologist Consultation',
];

/** Flat list of every sub-category with its category and type resolved. */
const flatSubCategories = () =>
  CATEGORIES.flatMap((cat, ci) =>
    cat.subCategories.map((sub, si) => ({
      name: sub.name,
      type: sub.type,
      category: cat.name,
      categoryOrder: cat.order ?? ci + 1,
      order: si + 1,
    })),
  );

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

module.exports = {
  TYPES,
  CATEGORIES,
  LEGACY_MAP,
  PROTECTED_ENTRIES,
  flatSubCategories,
  slugify,
  TYPE_NAMES: TYPES.map((t) => t.name),
};
