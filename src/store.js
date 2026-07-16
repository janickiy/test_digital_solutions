export const BASE_ITEM_COUNT = 1_000_000;
export const PAGE_SIZE = 20;

const MAX_ID_LENGTH = 128;
const MAX_PROCESSED_KEYS = 50_000;

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    this.details = details;
  }
}

function normalizeId(value) {
  if (!["string", "number", "bigint"].includes(typeof value)) {
    throw new ValidationError("ID должен быть строкой или числом");
  }

  const id = String(value).trim();
  if (!id) {
    throw new ValidationError("ID не может быть пустым");
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new ValidationError(`ID не может быть длиннее ${MAX_ID_LENGTH} символов`);
  }
  if (/\p{C}/u.test(id)) {
    throw new ValidationError("ID содержит недопустимые управляющие символы");
  }
  return id;
}

function normalizeQuery(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ru");
}

function matchesQuery(id, query) {
  return !query || id.toLocaleLowerCase("ru").includes(query);
}

function parseCursor(value, maximum) {
  if (value === undefined || value === null || value === "") return 0;
  if (!/^\d+$/.test(String(value))) {
    throw new ValidationError("Некорректный cursor");
  }
  return Math.min(Number(value), maximum);
}

function normalizeLimit(value) {
  const requested = Number(value ?? PAGE_SIZE);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ValidationError("limit должен быть положительным целым числом");
  }
  return Math.min(requested, PAGE_SIZE);
}

function rememberBounded(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_PROCESSED_KEYS) {
    map.delete(map.keys().next().value);
  }
}

export class ItemStore {
  constructor({ baseItemCount = BASE_ITEM_COUNT } = {}) {
    this.baseItemCount = baseItemCount;
    this.customItems = [];
    this.customSet = new Set();
    this.selectedOrder = [];
    this.selectedSet = new Set();
    this.processedOperations = new Map();
    this.processedAddRequests = new Map();
    this.version = 0;
  }

  isBaseId(id) {
    if (!/^[1-9]\d*$/.test(id)) return false;
    try {
      return BigInt(id) <= BigInt(this.baseItemCount);
    } catch {
      return false;
    }
  }

  hasItem(rawId) {
    const id = normalizeId(rawId);
    return this.isBaseId(id) || this.customSet.has(id);
  }

  itemAt(sourceIndex) {
    if (sourceIndex < this.baseItemCount) return String(sourceIndex + 1);
    return this.customItems[sourceIndex - this.baseItemCount];
  }

  getAvailablePage({ query = "", cursor, limit } = {}) {
    const normalizedQuery = normalizeQuery(query);
    const pageLimit = normalizeLimit(limit);
    const sourceLength = this.baseItemCount + this.customItems.length;
    let sourceIndex = parseCursor(cursor, sourceLength);
    const items = [];

    while (sourceIndex < sourceLength && items.length < pageLimit) {
      const id = this.itemAt(sourceIndex);
      sourceIndex += 1;
      if (!this.selectedSet.has(id) && matchesQuery(id, normalizedQuery)) {
        items.push({ id });
      }
    }

    return {
      items,
      nextCursor: sourceIndex < sourceLength ? String(sourceIndex) : null,
      hasMore: sourceIndex < sourceLength,
      version: this.version,
    };
  }

  getSelectedPage({ query = "", cursor, limit } = {}) {
    const normalizedQuery = normalizeQuery(query);
    const pageLimit = normalizeLimit(limit);
    let sourceIndex = parseCursor(cursor, this.selectedOrder.length);
    const items = [];

    while (sourceIndex < this.selectedOrder.length && items.length < pageLimit) {
      const id = this.selectedOrder[sourceIndex];
      sourceIndex += 1;
      if (matchesQuery(id, normalizedQuery)) items.push({ id });
    }

    return {
      items,
      nextCursor: sourceIndex < this.selectedOrder.length ? String(sourceIndex) : null,
      hasMore: sourceIndex < this.selectedOrder.length,
      version: this.version,
    };
  }

  getStats() {
    return {
      base: this.baseItemCount,
      custom: this.customItems.length,
      total: this.baseItemCount + this.customItems.length,
      selected: this.selectedOrder.length,
      available:
        this.baseItemCount + this.customItems.length - this.selectedOrder.length,
      version: this.version,
    };
  }

  addItems(rawIds, requestId) {
    if (!Array.isArray(rawIds)) {
      throw new ValidationError("ids должен быть массивом");
    }
    if (rawIds.length > 5_000) {
      throw new ValidationError("За один батч можно добавить не более 5000 ID");
    }

    const normalizedRequestId = normalizeId(requestId);
    const previous = this.processedAddRequests.get(normalizedRequestId);
    if (previous) return { ...previous, duplicateRequest: true };

    const uniqueIds = new Set();
    const rejected = [];
    for (const rawId of rawIds) {
      try {
        uniqueIds.add(normalizeId(rawId));
      } catch (error) {
        rejected.push({ value: String(rawId ?? ""), reason: error.message });
      }
    }

    const added = [];
    const duplicates = [];
    for (const id of uniqueIds) {
      if (this.isBaseId(id) || this.customSet.has(id)) {
        duplicates.push(id);
        continue;
      }
      this.customSet.add(id);
      this.customItems.push(id);
      added.push(id);
    }

    if (added.length) this.version += 1;
    const result = {
      requestId: normalizedRequestId,
      added,
      duplicates,
      rejected,
      duplicateRequest: false,
      version: this.version,
    };
    rememberBounded(this.processedAddRequests, normalizedRequestId, result);
    return result;
  }

  applyOperations(operations) {
    if (!Array.isArray(operations)) {
      throw new ValidationError("operations должен быть массивом");
    }
    if (operations.length > 5_000) {
      throw new ValidationError("За один батч можно изменить не более 5000 значений");
    }

    return {
      results: operations.map((operation) => this.applyOperation(operation)),
      version: this.version,
      stats: this.getStats(),
    };
  }

  applyOperation(operation) {
    if (!operation || typeof operation !== "object") {
      throw new ValidationError("Операция должна быть объектом");
    }
    const opId = normalizeId(operation.opId);
    if (this.processedOperations.has(opId)) {
      return { ...this.processedOperations.get(opId), duplicate: true };
    }

    let result;
    switch (operation.type) {
      case "select":
        result = this.selectItem(operation.id);
        break;
      case "deselect":
        result = this.deselectItem(operation.id);
        break;
      case "reorder":
        result = this.reorderItems(operation.orderedIds, operation.query);
        break;
      default:
        throw new ValidationError(`Неизвестный тип операции: ${operation.type}`);
    }

    const stored = { opId, type: operation.type, ...result, duplicate: false };
    rememberBounded(this.processedOperations, opId, stored);
    return stored;
  }

  selectItem(rawId) {
    const id = normalizeId(rawId);
    if (!this.hasItem(id)) {
      throw new ValidationError(`Элемент с ID «${id}» не существует`);
    }
    if (this.selectedSet.has(id)) return { id, changed: false };

    this.selectedSet.add(id);
    this.selectedOrder.push(id);
    this.version += 1;
    return { id, changed: true };
  }

  deselectItem(rawId) {
    const id = normalizeId(rawId);
    if (!this.selectedSet.has(id)) return { id, changed: false };

    this.selectedSet.delete(id);
    const index = this.selectedOrder.indexOf(id);
    if (index !== -1) this.selectedOrder.splice(index, 1);
    this.version += 1;
    return { id, changed: true };
  }

  reorderItems(rawOrderedIds, query = "") {
    if (!Array.isArray(rawOrderedIds) || rawOrderedIds.length < 2) {
      throw new ValidationError("Для сортировки нужны как минимум два ID");
    }
    if (rawOrderedIds.length > 5_000) {
      throw new ValidationError("За одну операцию можно переставить не более 5000 ID");
    }

    const orderedIds = rawOrderedIds.map(normalizeId);
    const uniqueIds = new Set(orderedIds);
    if (uniqueIds.size !== orderedIds.length) {
      throw new ValidationError("Список сортировки содержит повторяющиеся ID");
    }

    const normalizedQuery = normalizeQuery(query);
    for (const id of orderedIds) {
      if (!this.selectedSet.has(id)) {
        throw new ValidationError(`ID «${id}» не находится в выбранном списке`);
      }
      if (!matchesQuery(id, normalizedQuery)) {
        throw new ValidationError(`ID «${id}» не соответствует текущему фильтру`);
      }
    }

    const slots = [];
    for (let index = 0; index < this.selectedOrder.length; index += 1) {
      if (uniqueIds.has(this.selectedOrder[index])) slots.push(index);
    }
    if (slots.length !== orderedIds.length) {
      throw new ValidationError("Не все элементы сортировки найдены");
    }

    const changed = slots.some(
      (selectedIndex, orderIndex) =>
        this.selectedOrder[selectedIndex] !== orderedIds[orderIndex],
    );
    if (!changed) return { orderedIds, changed: false };

    slots.forEach((selectedIndex, orderIndex) => {
      this.selectedOrder[selectedIndex] = orderedIds[orderIndex];
    });
    this.version += 1;
    return { orderedIds, changed: true };
  }
}

export const internals = {
  matchesQuery,
  normalizeId,
  normalizeLimit,
  normalizeQuery,
};
