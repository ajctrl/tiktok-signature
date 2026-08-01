export class BrowserOperationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Browser operation waited more than ${timeoutMs}ms in the queue`);
    this.name = "BrowserOperationTimeoutError";
    this.statusCode = 503;
  }
}

export class RestartRateLimitError extends Error {
  constructor(retryAfterSeconds, reason = "cooldown") {
    super(
      reason === "failure"
        ? "Browser restart is temporarily unavailable"
        : "Browser was restarted recently",
    );
    this.name = "RestartRateLimitError";
    this.statusCode = 429;
    this.retryAfterSeconds = retryAfterSeconds;
    this.reason = reason;
  }
}

export class SingleFlight {
  constructor() {
    this.promise = null;
  }

  get isRunning() {
    return this.promise !== null;
  }

  run(operation) {
    if (this.promise) return this.promise;

    const promise = Promise.resolve().then(operation);
    const trackedPromise = promise.finally(() => {
      if (this.promise === trackedPromise) this.promise = null;
    });
    this.promise = trackedPromise;
    return trackedPromise;
  }
}

/**
 * FIFO queue for operations that need exclusive access to the browser page.
 * The timeout applies only while an operation is waiting in the queue.
 */
export class BrowserOperationQueue {
  constructor({ waitTimeoutMs = 90_000 } = {}) {
    this.waitTimeoutMs = waitTimeoutMs;
    this.pending = [];
    this.processing = false;
  }

  get length() {
    return this.pending.length;
  }

  enqueue(label, operation) {
    return new Promise((resolve, reject) => {
      const item = {
        label,
        operation,
        resolve,
        reject,
        started: false,
        timer: null,
      };

      if (this.processing || this.pending.length > 0) {
        item.timer = setTimeout(() => {
          if (item.started) return;
          const index = this.pending.indexOf(item);
          if (index !== -1) this.pending.splice(index, 1);
          reject(new BrowserOperationTimeoutError(this.waitTimeoutMs));
        }, this.waitTimeoutMs);
      }

      this.pending.push(item);
      this.#process().catch((error) => {
        console.error(`[Queue] Unexpected processor failure: ${error.message}`);
      });
    });
  }

  async #process() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        item.started = true;
        if (item.timer) clearTimeout(item.timer);

        try {
          item.resolve(await item.operation());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
      // An enqueue can occur after the loop observes an empty queue but before
      // processing is reset. Make sure that item is not left behind.
      if (this.pending.length > 0) void this.#process();
    }
  }
}

/**
 * Coalesces concurrent restart requests and enforces success/failure cooldowns.
 */
export class RestartCoordinator {
  constructor({
    enqueue,
    restart,
    cooldownMs = 60_000,
    failureBackoffMs = 5_000,
    now = Date.now,
  }) {
    this.enqueue = enqueue;
    this.restart = restart;
    this.cooldownMs = cooldownMs;
    this.failureBackoffMs = failureBackoffMs;
    this.now = now;
    this.restartPromise = null;
    this.blockedUntil = 0;
    this.blockReason = null;
  }

  get isRestarting() {
    return this.restartPromise !== null;
  }

  get cooldownRemainingSeconds() {
    return Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000));
  }

  request() {
    if (this.restartPromise) {
      return { promise: this.restartPromise, coalesced: true };
    }

    const retryAfterSeconds = this.cooldownRemainingSeconds;
    if (retryAfterSeconds > 0) {
      throw new RestartRateLimitError(retryAfterSeconds, this.blockReason);
    }

    const operation = this.enqueue("restart", async () => {
      await this.restart();
      this.blockedUntil = this.now() + this.cooldownMs;
      this.blockReason = "cooldown";
    }).catch((error) => {
      this.blockedUntil = this.now() + this.failureBackoffMs;
      this.blockReason = "failure";
      if (error && typeof error === "object" && !error.statusCode) {
        error.statusCode = 503;
      }
      throw error;
    });

    this.restartPromise = operation.finally(() => {
      this.restartPromise = null;
    });

    return { promise: this.restartPromise, coalesced: false };
  }
}
