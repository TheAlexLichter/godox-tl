/** Trailing-edge debouncer.
 *
 * Each `schedule(value)` resets the timer; after `delayMs` of quiet, `flush`
 * fires once with the most-recent value. Used per-accessory to coalesce rapid
 * HomeKit slider updates into a single BLE write. */
export class Debouncer<T> {
  private timer: NodeJS.Timeout | undefined;
  private pending: T | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly flush: (value: T) => void,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const v = this.pending as T;
      this.pending = undefined;
      this.timer = undefined;
      this.flush(v);
    }, this.delayMs);
  }

  /** Force the pending value to fire now. */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      if (this.pending !== undefined) {
        const v = this.pending;
        this.pending = undefined;
        this.flush(v);
      }
    }
  }
}
