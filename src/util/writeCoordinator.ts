export type WriteCoordinatorErrorCode =
  | "WRITE_QUEUE_ABORTED"
  | "WRITE_QUEUE_TIMEOUT"
  | "WRITE_QUEUE_FULL";

export class WriteCoordinatorError extends Error {
  readonly code: WriteCoordinatorErrorCode;
  readonly retryable: boolean;
  readonly scope: string;

  constructor(
    code: WriteCoordinatorErrorCode,
    scope: string,
    retryable: boolean,
  ) {
    const message = code === "WRITE_QUEUE_ABORTED"
      ? `Write for scope "${scope}" was cancelled while waiting in the queue.`
      : code === "WRITE_QUEUE_TIMEOUT"
        ? `Write for scope "${scope}" waited too long in the queue.`
        : `Write queue for scope "${scope}" is full.`;
    super(message);
    this.name = "WriteCoordinatorError";
    this.code = code;
    this.retryable = retryable;
    this.scope = scope;
  }
}

export interface WriteCoordinatorOptions {
  /** Maximum number of waiting operations per scope (default: 100). */
  maxPendingPerScope?: number;
  /** Maximum time a queued operation may wait (default: 60 seconds). */
  maxWaitMs?: number;
}

type QueueEntry = {
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
};

type ScopeState = {
  active: boolean;
  queue: QueueEntry[];
};

const DEFAULT_MAX_PENDING_PER_SCOPE = 100;
const DEFAULT_MAX_WAIT_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Serialize writes for each process-local scope while allowing independent
 * scopes to make progress concurrently. The callback should include the full
 * read/validate/mutate/push sequence that must be kept together.
 */
export class WriteCoordinator {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly maxPendingPerScope: number;
  private readonly maxWaitMs: number;

  constructor(options: WriteCoordinatorOptions = {}) {
    this.maxPendingPerScope = validatePositiveInteger(
      options.maxPendingPerScope ?? DEFAULT_MAX_PENDING_PER_SCOPE,
      "maxPendingPerScope",
    );
    this.maxWaitMs = validatePositiveInteger(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS, "maxWaitMs");
  }

  /** Number of scopes that still have an active or queued write. */
  get pendingScopeCount(): number {
    return this.scopes.size;
  }

  /**
   * Queue a write for its scope. The signal only cancels while waiting; once
   * the callback starts, the lock remains held until that callback settles.
   */
  run<T>(scope: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (typeof scope !== "string" || scope.trim().length === 0) {
      return Promise.reject(new TypeError("Write scope must be a non-empty string."));
    }
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Write operation must be a function."));
    }
    if (signal?.aborted) {
      return Promise.reject(this.queueError("WRITE_QUEUE_ABORTED", scope));
    }

    let state = this.scopes.get(scope);
    if (!state) {
      state = { active: false, queue: [] };
      this.scopes.set(scope, state);
    }
    const scopeState = state;

    if (!scopeState.active) {
      scopeState.active = true;
      return this.execute(scope, scopeState, operation);
    }

    if (scopeState.queue.length >= this.maxPendingPerScope) {
      return Promise.reject(this.queueError("WRITE_QUEUE_FULL", scope));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        operation,
        resolve: value => resolve(value as T),
        reject,
        signal,
      };
      scopeState.queue.push(entry);

      if (signal) {
        const abortListener = () => {
          this.removeQueued(scopeState, entry, this.queueError("WRITE_QUEUE_ABORTED", scope));
        };
        entry.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }

      entry.timer = setTimeout(() => {
        this.removeQueued(scopeState, entry, this.queueError("WRITE_QUEUE_TIMEOUT", scope));
      }, this.maxWaitMs);
      entry.timer.unref?.();
    });
  }

  private async execute<T>(
    scope: string,
    state: ScopeState,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } finally {
      this.startNext(scope, state);
    }
  }

  private startNext(scope: string, state: ScopeState): void {
    const entry = state.queue.shift();
    if (entry) {
      this.clearWait(entry);
      void this.executeQueued(scope, state, entry);
      return;
    }

    state.active = false;
    if (this.scopes.get(scope) === state) {
      this.scopes.delete(scope);
    }
  }

  private async executeQueued(scope: string, state: ScopeState, entry: QueueEntry): Promise<void> {
    try {
      entry.resolve(await entry.operation());
    } catch (error) {
      entry.reject(error);
    } finally {
      this.startNext(scope, state);
    }
  }

  private removeQueued(
    state: ScopeState,
    entry: QueueEntry,
    error: WriteCoordinatorError,
  ): void {
    const index = state.queue.indexOf(entry);
    if (index < 0) return;

    state.queue.splice(index, 1);
    this.clearWait(entry);
    entry.reject(error);
  }

  private clearWait(entry: QueueEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
  }

  private queueError(code: WriteCoordinatorErrorCode, scope: string): WriteCoordinatorError {
    return new WriteCoordinatorError(code, scope, code !== "WRITE_QUEUE_ABORTED");
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

// ponytail: this is process-local; route clients through one shared HTTP
// listener because independent listeners, stdio, and editors are outside it.
export const writeCoordinator = new WriteCoordinator();
