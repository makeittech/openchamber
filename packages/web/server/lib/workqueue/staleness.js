import { searchCommitsByReference } from '../git/service.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Advisory "is this already done?" signal for the AI analysis panel: search
// the repo's commit log for a reference to this item (source id or Linear
// identifier) and report how long the item has sat open. A match does not
// prove the issue is resolved — it is a prompt for the user to look, not an
// automatic close.
export async function checkItemStaleness(item, directory) {
  if (!directory) {
    return { checked: false, stale: false, matches: [], daysOpen: 0 };
  }

  const references = [item.sourceId, item.identifier].filter(Boolean);
  const seenHashes = new Set();
  const matches = [];
  for (const reference of references) {
    const found = await searchCommitsByReference(directory, reference, { maxCount: 5 });
    for (const commit of found) {
      if (seenHashes.has(commit.hash)) continue;
      seenHashes.add(commit.hash);
      matches.push(commit);
    }
  }
  matches.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));

  const createdAt = typeof item.createdAt === 'number' && item.createdAt > 0 ? item.createdAt : Date.now();
  const daysOpen = Math.max(0, Math.round((Date.now() - createdAt) / MS_PER_DAY));

  return { checked: true, stale: matches.length > 0, matches: matches.slice(0, 5), daysOpen };
}
