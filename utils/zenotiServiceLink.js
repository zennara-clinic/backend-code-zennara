/**
 * Which service row a Zenoti service id (or name) belongs to.
 *
 * Several `Consultation` rows can carry the same `zenotiServiceId`: the mirror of that
 * Zenoti service, plus any app-menu entries pointing at it so a booking lands in Zenoti
 * ("Upper Lip Hair Reduction" and "Leg Hair Reduction" both book as "LHR full body"), plus
 * archived menu entries that once did. A visit, sale or price row coming FROM Zenoti is
 * the mirror's — never a menu entry's — so lookups rank rows:
 *
 *   2  the mirror (not a live menu entry, not archived)   ← wins
 *   1  an archived row
 *   0  a live app-menu entry (inCatalog, not archived)    ← only fills a gap
 *
 * `preferMirror` orders rows lowest rank first, so a last-wins Map built from them keeps
 * the best row for every key.
 */
const zenotiLinkRank = (c) => {
  if (c && c.isArchived) return 1;
  if (c && c.inCatalog) return 0;
  return 2;
};

const preferMirror = (rows) => [...(rows || [])].sort((a, b) => zenotiLinkRank(a) - zenotiLinkRank(b));

/** Fields a lookup needs to rank rows; add them to any select() feeding preferMirror. */
const RANK_FIELDS = 'inCatalog isArchived';

module.exports = { zenotiLinkRank, preferMirror, RANK_FIELDS };
