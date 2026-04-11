export function shouldResumeFromSessionHandshake(message, resumeInFlight) {
  if (resumeInFlight) return false;
  return message?.type === 'session' && message.existing === true;
}
