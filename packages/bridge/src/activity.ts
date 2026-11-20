/**
 * How many turns/tasks this process is running right now.
 *
 * The fleet uses it for one decision: a downloaded bridge upgrade only applies
 * on the next launch, so an idle process restarts itself instead of waiting
 * for a machine reboot. Anything mid-turn must not be interrupted.
 */
let active = 0;
let lastChangedAt = Date.now();

export const activity = {
  enter(): void {
    active += 1;
    lastChangedAt = Date.now();
  },

  leave(): void {
    active = Math.max(0, active - 1);
    lastChangedAt = Date.now();
  },

  get activeCount(): number {
    return active;
  },

  /** True when nothing has been running for at least `ms`. */
  idleFor(ms: number, now = Date.now()): boolean {
    return active === 0 && now - lastChangedAt >= ms;
  },
};
