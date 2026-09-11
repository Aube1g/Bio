// Each submitted ball remains its own idempotent wager. Cancelling only stops unsubmitted balls.
export class LaunchQueue {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.generation = 0;
    this.running = false;
    this.remaining = 0;
    this.wake = null;
  }
  cancel() {
    this.generation++;
    this.running = false;
    this.remaining = 0;
    this.wake?.();
    this.wake = null;
    this.onChange(this);
  }
  async run(count, submit, { spacing = 170 } = {}) {
    if (this.running || !Number.isInteger(count) || count < 1 || count > 8) return 0;
    const generation = ++this.generation;
    this.running = true;
    this.remaining = count;
    this.onChange(this);
    let accepted = 0;
    try {
      for (let index = 0; index < count && generation === this.generation; index++) {
        if (!(await submit(index))) break;
        accepted++;
        if (generation !== this.generation) break;
        this.remaining = count - accepted;
        this.onChange(this);
        if (this.remaining && spacing)
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              this.wake = null;
              resolve();
            }, spacing);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
      }
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.remaining = 0;
        this.onChange(this);
      }
    }
    return accepted;
  }
}
