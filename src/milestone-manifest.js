// Fixed, owner-reviewed bytes only. No semantic inference or automatic expansion.
const { dependencies } = require('./r1-dependencies');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validateManifest(m, grant, readyLabel) {
  if (!m || Object.keys(m).sort().join() !== 'readyLabel,tickets'
    || typeof m.readyLabel !== 'string' || !m.readyLabel.trim() || /[\x00-\x1f\x7f]/.test(m.readyLabel)
    || m.readyLabel !== readyLabel || !Array.isArray(m.tickets) || !m.tickets.length
    || m.tickets.length > grant.ticketLimit) throw new Error('Invalid fixed manifest or configured ready label.');
  const ids = new Set();
  for (const t of m.tickets) {
    if (!t || Object.keys(t).sort().join() !== 'blockers,body,category,issue,reason,title'
      || !Number.isSafeInteger(t.issue) || t.issue < 1 || ids.has(t.issue)
      || typeof t.title !== 'string' || !t.title.startsWith('[DRAFT] ')
      || typeof t.body !== 'string' || !t.body.trim()
      || !grant.allowedCategories.includes(t.category)
      || typeof t.reason !== 'string' || !t.reason.trim() || t.reason.length > 4000
      || !Array.isArray(t.blockers)
      || !same(t.blockers, dependencies({ number: t.issue, body: t.body }).sort((a, b) => a - b))) throw new Error('Invalid exact fixed-manifest ticket or dependency set.');
    ids.add(t.issue);
  }
  return m;
}
function manifestScope(g, request, readyLabel, issue, blockers) {
  try {
    const m = validateManifest(g.fixedManifest, g, readyLabel);
    const t = m.tickets.find(t => t.issue === request.issue);
    return !!t && request.scope === 'in-scope' && request.category === t.category && request.reason === t.reason
      && issue?.number === t.issue && issue.title === t.title && issue.body === t.body
      && same(blockers, t.blockers);
  } catch { return false; }
}
module.exports = { validateManifest, manifestScope };
