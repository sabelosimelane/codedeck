// Tailscale SSH in check mode holds a new connection until the owner approves it in a browser.
// Until then the attachment's ssh never reaches tmux: what is written to it is echoed by the
// local terminal and never arrives at the agent.
//
// The output also carries whatever the agent prints, so only whole banner lines count, and only a
// link to Tailscale's own login page is ever shown to the owner.
const CHECK = /(?:^|\r?\n)# Tailscale SSH requires an additional check\.\r?(?=\n|$)/g;
const APPROVED = /(?:^|\r?\n)# Authentication checked with Tailscale SSH\.\r?(?=\n|$)/;
const LINK = /(?:^|\r?\n)# To authenticate, visit: (https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+)\r?(?=\n|$)/g;

/** The authentication link when the output shows a Tailscale SSH check not yet approved, else null. */
export function pendingSshAuthCheck(chunks) {
  if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')) {
    throw new Error('pendingSshAuthCheck: chunks must be an array of strings');
  }
  const output = chunks.join('');
  const checks = [...output.matchAll(CHECK)];
  if (checks.length === 0) return null;
  const after = output.slice(checks.at(-1).index);
  if (APPROVED.test(after)) return null;
  const links = [...after.matchAll(LINK)];
  return links.length > 0 ? links.at(-1)[1] : null;
}
