/**
 * Suggest whether a product is prescription-only (Rx) or over-the-counter.
 *
 * Built from the clinic's own classification of the Jubilee Hills pharmacy
 * stock (JH_Retail_Rx_vs_OTC, 5 Sep 2026): 40 Schedule H products, 218 OTC.
 * The rules below reproduce that sheet from the fields Zenoti already gives
 * us — category, sub-category, HSN and the product name — so a newly synced
 * product arrives with a suggestion. It is a SUGGESTION: `Product.rxSource`
 * records 'heuristic', and a decision made in the panel ('manual') is never
 * overwritten.
 *
 * Returns { isRx: boolean|null, reason: string|null }. `null` = no opinion.
 */

/** Active ingredients / brands that are Schedule H in India. */
const RX_NAME_RX = new RegExp([
  // hair loss (Schedule H at every strength)
  'minoxidil', 'brintop', 'minopep', 'm\\s*power', 'finasteride', 'finagrow', 'minogain',
  // retinoids
  'isotretinoin', 'isograce', 'tretinoin', 'tretin\\b', 'naditret', 'adapalene', 'adapclear', 'epiduo',
  // antibiotics / antifungals
  'azithro', 'azithral', 'doxy', 'e\\s*dox', 'clindamycin', 'cligel', 'triclear-?n', 'itraconazole', 'itrafung', 'itraska',
  'terbinafine', 'ketoconazole', 'ketafung', 'luliconazole', 'luliska', 'levoska', 'levocetirizine',
  // steroids / immunomodulators
  'mometasone', 'momate', 'fucibet', 'clavora', 'dektop', 'deznoid', 'tacrolimus', 'tacrozone', 'betamethasone', 'clobetasol',
  // pigmentation / acne actives
  'hydroquinone', 'depiglow\\s*ultra', 'nigrilite', 'benzoyl\\s*peroxide', 'peroclin', 'azelaic\\s*acid\\s*20',
  // oral
  'spironolactone', 'sav\\s*ds', 'upadacitinib', 'upadoz', 'tranexamic', 'txc\\s*tab', 'aczin',
  'betadine\\s*gargle',
].join('|'), 'i');

/** Names that look medical but are freely sold. */
const OTC_NAME_RX = new RegExp([
  'sunscreen', 'spf', 'moisturi[sz]', 'lotion', 'cleanser', 'cleansing', 'face\\s*wash', 'serum', 'shampoo', 'conditioner',
  'lip\\s*balm', 'mask', 'toner', 'collagen', 'probiotic', 'glutathione', 'biotin', 'vitamin', 'whey', 'omega',
  'perfectil', 'epiyuth', 'hair\\s*fact', 'colaten', 'glucell', 'nusaude', 'cosmetox', 'moyzee', 'wellgrow',
  // OTC dermo-cosmetic brands stocked at the clinic
  'cerave', 'bioderma', 'la\\s*roche', '\\blrp\\b', 'isdin', 'av[eè]ne', '\\bzo\\b', 'obagi', 'sesderma', 'uriage', 'neutrogena',
  'heliocare', 'eucerin', 'akosma', 'fixderma', 'truderma', 'isclinical', 'is\\s*clinical', 'rilastil', 'norden\\s*mosse', 'retix',
].join('|'), 'i');

const RX_CATEGORY_RX = /^medicine|^pharma|^drug/i;
const OTC_CATEGORY_RX = /skin\s*care|skincare|sun\s*care|hair\s*care|haircare|supplement|cosmetic|professional|device|consumable/i;
// "Hair Fall & Growth" is deliberately NOT here: it holds minoxidil (Rx, caught
// by name above) alongside peptide serums and shampoos the clinic sells freely.
const RX_SUBCATEGORY_RX = /antibiotic|antifungal|steroid|anti-?inflam|acne\s*(rx|medic)|retinoid/i;

function classifyRx({ name, category, subCategory, hsn } = {}) {
  const n = String(name || '');
  const cat = String(category || '');
  const sub = String(subCategory || '');
  const code = String(hsn || '').replace(/\D/g, '');

  // A named Schedule H ingredient wins over everything else.
  if (RX_NAME_RX.test(n)) return { isRx: true, reason: 'Named Schedule H ingredient or brand' };

  // HSN 3004 = medicaments in measured doses (tablets, creams, drops).
  // 3003 = medicaments not in measured doses. Both are pharmacy-only unless
  // the name says otherwise (e.g. a sunscreen filed under 3004 by mistake).
  if (/^300[34]/.test(code)) {
    if (OTC_NAME_RX.test(n)) return { isRx: false, reason: 'Cosmetic name despite medicament HSN' };
    return { isRx: true, reason: `HSN ${code} (medicament)` };
  }

  if (RX_CATEGORY_RX.test(cat)) {
    if (OTC_NAME_RX.test(n) && !RX_SUBCATEGORY_RX.test(sub)) return { isRx: false, reason: 'Medicines category but OTC product' };
    return { isRx: true, reason: `Category "${cat}"` };
  }
  if (RX_SUBCATEGORY_RX.test(sub)) return { isRx: true, reason: `Sub-category "${sub}"` };

  // Cosmetics (3304), soaps/shampoos (3305/3401), food supplements (2106) are OTC.
  if (/^(3304|3305|3401|2106|3307)/.test(code)) return { isRx: false, reason: `HSN ${code} (cosmetic/supplement)` };
  if (OTC_CATEGORY_RX.test(cat) || OTC_CATEGORY_RX.test(sub)) return { isRx: false, reason: `Category "${cat || sub}"` };
  if (OTC_NAME_RX.test(n)) return { isRx: false, reason: 'Cosmetic or supplement name' };

  return { isRx: null, reason: null };
}

module.exports = { classifyRx, RX_NAME_RX };
