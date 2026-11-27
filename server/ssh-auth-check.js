// Tailscale SSH in check mode holds a new connection until the owner approves it in a browser.
// Until then the attachment's ssh never reaches tmux: what is written to it is echoed by the
// local terminal and never arrives at the agent.
const CHECK = '# Tailscale SSH requires an additional check.';
const APPROVED = '# Authentication checked with Tailscale SSH.';
const LINK = /# To authenticate, visit: (https:\/\/\S+)/g;

/** The authentication link when the output shows a Tailscale SSH check not yet approved, else null. */
export function pendingSshAuthCheck(chunks) {
  if (!Array.isArray(chunks) || chunks.some(chunk => typeof chunk !== 'string')) {
    throw new Error('pendingSshAuthCheck: chunks must be an array of strings');
  }
  const output = chunks.join('');
  const check = output.lastIndexOf(CHECK);
  if (check < 0 || output.indexOf(APPROVED, check) >= 0) return null;
  const links = [...output.slice(check).matchAll(LINK)];
  return links.length > 0 ? links.at(-1)[1] : null;
}
