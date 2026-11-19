/**
 * Files Git ignores that exist only in a task's copy. Close deletes them with the copy, so the
 * owner is shown them first and the backend is told the owner agreed.
 */

/** What refuses a close before the owner is asked: every reason but the ignored files, which the dialog lists. */
export const closeRefusals = landing => landing.blockers.close.filter(blocker => blocker.code !== 'ignored_files');

/** The listed files by name, and how many more there are. */
export function namedIgnored(landing) {
  const more = landing.ignoredAtRiskCount - landing.ignoredAtRisk.length;
  return `${landing.ignoredAtRisk.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** The options Close is called with: the owner's word when there were files to agree to, else none. */
export const closeArguments = deletes => (deletes ? [{ deleteIgnored: true }] : []);
