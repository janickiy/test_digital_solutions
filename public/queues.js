function createOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Ошибка HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function postJson(endpoint, body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

export class BatchedReadQueue {
  constructor({ interval = 150, onChange = () => {} } = {}) {
    this.pending = new Map();
    this.inFlight = new Map();
    this.sending = false;
    this.onChange = onChange;
    this.timer = setInterval(() => this.flush(), interval);
  }

  get size() {
    return this.pending.size + this.inFlight.size;
  }

  enqueue(resource, params = {}) {
    const key = `${resource}:${JSON.stringify(params)}`;
    const existing = this.pending.get(key) || this.inFlight.get(key);
    if (existing) return existing.promise;

    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const entry = { key, resource, params, promise, resolve, reject };
    this.pending.set(key, entry);
    this.onChange(this);
    return promise;
  }

  async flush() {
    if (this.sending || !this.pending.size) return;
    this.sending = true;
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      this.pending.delete(entry.key);
      this.inFlight.set(entry.key, entry);
    }
    this.onChange(this);

    try {
      const payload = await postJson("/api/read/batch", {
        requests: entries.map(({ key, resource, params }) => ({
          key,
          resource,
          params,
        })),
      });
      const results = new Map(payload.results.map((result) => [result.key, result.data]));
      for (const entry of entries) {
        if (!results.has(entry.key)) {
          entry.reject(new Error("Сервер не вернул результат чтения"));
        } else {
          entry.resolve(results.get(entry.key));
        }
      }
    } catch (error) {
      entries.forEach((entry) => entry.reject(error));
    } finally {
      entries.forEach((entry) => this.inFlight.delete(entry.key));
      this.sending = false;
      this.onChange(this);
    }
  }

  destroy() {
    clearInterval(this.timer);
  }
}

export class DeduplicatedMutationQueue {
  constructor({
    interval = 150,
    onChange = () => {},
    onSuccess = () => {},
    onError = () => {},
  } = {}) {
    this.pending = new Map();
    this.sending = false;
    this.onChange = onChange;
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.timer = setInterval(() => this.flush(), interval);
  }

  get size() {
    return this.pending.size + Number(this.sending);
  }

  enqueue(key, operation) {
    const queuedOperation = { ...operation, opId: createOperationId() };
    this.pending.set(key, queuedOperation);
    this.onChange(this);
    return queuedOperation.opId;
  }

  async flush() {
    if (this.sending || !this.pending.size) return;
    this.sending = true;
    const entries = [...this.pending.entries()];
    entries.forEach(([key, operation]) => {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    });
    this.onChange(this);

    try {
      const result = await postJson("/api/state/batch", {
        operations: entries.map(([, operation]) => operation),
      });
      this.onSuccess(result);
    } catch (error) {
      const willRetry = !error.status || error.status >= 500;
      if (willRetry) {
        for (const [key, operation] of entries) {
          if (!this.pending.has(key)) this.pending.set(key, operation);
        }
      }
      this.onError(error, willRetry);
    } finally {
      this.sending = false;
      this.onChange(this);
    }
  }

  flushWithBeacon() {
    if (!this.pending.size || !navigator.sendBeacon) return;
    const operations = [...this.pending.values()];
    const body = new Blob([JSON.stringify({ operations })], {
      type: "application/json",
    });
    if (navigator.sendBeacon("/api/state/batch", body)) {
      this.pending.clear();
      this.onChange(this);
    }
  }

  destroy() {
    clearInterval(this.timer);
  }
}

export class DeduplicatedAddQueue {
  constructor({
    interval = 10_000,
    onChange = () => {},
    onSuccess = () => {},
    onError = () => {},
  } = {}) {
    this.pending = new Map();
    this.inFlightIds = new Set();
    this.sending = false;
    this.onChange = onChange;
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.interval = interval;
    this.nextFlushAt = Date.now() + interval;
    this.timer = setInterval(() => {
      this.nextFlushAt = Date.now() + interval;
      this.flush();
      this.onChange(this);
    }, interval);
  }

  get size() {
    return this.pending.size + this.inFlightIds.size;
  }

  enqueue(rawId) {
    const id = String(rawId).trim();
    if (!id || this.pending.has(id) || this.inFlightIds.has(id)) return false;
    this.pending.set(id, id);
    this.onChange(this);
    return true;
  }

  async flush() {
    if (this.sending || !this.pending.size) return;
    this.sending = true;
    const entries = [...this.pending.entries()];
    entries.forEach(([key, id]) => {
      if (this.pending.get(key) === id) this.pending.delete(key);
      this.inFlightIds.add(id);
    });
    const requestId = createOperationId();
    this.onChange(this);

    try {
      const result = await postJson("/api/items/batch", {
        requestId,
        ids: entries.map(([, id]) => id),
      });
      this.onSuccess(result);
    } catch (error) {
      const willRetry = !error.status || error.status >= 500;
      if (willRetry) {
        entries.forEach(([key, id]) => {
          if (!this.pending.has(key)) this.pending.set(key, id);
        });
      }
      this.onError(error, willRetry);
    } finally {
      entries.forEach(([, id]) => this.inFlightIds.delete(id));
      this.sending = false;
      this.onChange(this);
    }
  }

  flushWithBeacon() {
    if (!this.pending.size || !navigator.sendBeacon) return;
    const body = new Blob(
      [
        JSON.stringify({
          requestId: createOperationId(),
          ids: [...this.pending.values()],
        }),
      ],
      { type: "application/json" },
    );
    if (navigator.sendBeacon("/api/items/batch", body)) {
      this.pending.clear();
      this.onChange(this);
    }
  }

  destroy() {
    clearInterval(this.timer);
  }
}
