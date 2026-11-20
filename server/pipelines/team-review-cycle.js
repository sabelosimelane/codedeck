// Both review lanes share a single model circuit and a daily call budget.
export function createReviewCycle({ workflow, assess, nominate, warn }) {
  for (const [name, fn] of Object.entries({ workflow, assess, nominate, warn })) {
    if (typeof fn !== 'function') throw new TypeError('Review cycle requires ' + name);
  }
  let running = false;
  let teamsFirst = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const jobs = teamsFirst ? [assess, workflow, nominate] : [workflow, assess, nominate];
      teamsFirst = !teamsFirst;
      for (const job of jobs) {
        try {
          await job();
        } catch (error) {
          warn(error);
        }
      }
    } finally {
      running = false;
    }
  };
}
