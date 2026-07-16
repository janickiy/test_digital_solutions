import {
  BatchedReadQueue,
  DeduplicatedAddQueue,
  DeduplicatedMutationQueue,
} from "./queues.js";

const elements = {
  totalCount: document.querySelector("#total-count"),
  availableCount: document.querySelector("#available-count"),
  selectedCount: document.querySelector("#selected-count"),
  customCount: document.querySelector("#custom-count"),
  stateVersion: document.querySelector("#state-version"),
  availableBadge: document.querySelector("#available-badge"),
  selectedBadge: document.querySelector("#selected-badge"),
  availableSearch: document.querySelector("#available-search"),
  selectedSearch: document.querySelector("#selected-search"),
  availableScroll: document.querySelector("#available-scroll"),
  selectedScroll: document.querySelector("#selected-scroll"),
  availableRows: document.querySelector("#available-rows"),
  selectedRows: document.querySelector("#selected-rows"),
  availableFooter: document.querySelector("#available-footer"),
  selectedFooter: document.querySelector("#selected-footer"),
  addForm: document.querySelector("#add-form"),
  newId: document.querySelector("#new-id"),
  readQueueStatus: document.querySelector("#read-queue-status"),
  mutationQueueStatus: document.querySelector("#mutation-queue-status"),
  addQueueStatus: document.querySelector("#add-queue-status"),
  toastRegion: document.querySelector("#toast-region"),
};

const numberFormatter = new Intl.NumberFormat("ru-RU");
const pendingSelectionIds = new Set();
let latestStats = null;

function formatNumber(value) {
  return numberFormatter.format(value ?? 0);
}

function debounce(callback, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast${type === "error" ? " is-error" : ""}`;
  node.textContent = message;
  elements.toastRegion.append(node);
  setTimeout(() => node.remove(), 4_500);
}

function updateQueueStatus() {
  const readCount = readQueue.size;
  elements.readQueueStatus.classList.toggle("is-active", readCount > 0);
  elements.readQueueStatus.lastChild.textContent = readCount
    ? ` Чтение · ${readCount}`
    : " Чтение · пусто";

  const mutationCount = mutationQueue.size;
  elements.mutationQueueStatus.classList.toggle("is-active", mutationCount > 0);
  elements.mutationQueueStatus.lastChild.textContent = mutationCount
    ? ` Изменения · ${mutationCount}`
    : " Изменения · пусто";

  const addCount = addQueue.size;
  elements.addQueueStatus.classList.toggle("is-active", addCount > 0);
  if (addCount) {
    const seconds = Math.max(1, Math.ceil((addQueue.nextFlushAt - Date.now()) / 1_000));
    elements.addQueueStatus.lastChild.textContent = ` Добавление · ${addCount} · ${seconds} с`;
  } else {
    elements.addQueueStatus.lastChild.textContent = " Добавление · пусто";
  }
}

function updateStats(stats) {
  latestStats = stats;
  elements.totalCount.textContent = formatNumber(stats.total);
  elements.availableCount.textContent = formatNumber(stats.available);
  elements.selectedCount.textContent = formatNumber(stats.selected);
  elements.customCount.textContent = formatNumber(stats.custom);
  elements.availableBadge.textContent = `${formatNumber(stats.available)} доступно`;
  elements.selectedBadge.textContent = `${formatNumber(stats.selected)} выбрано`;
  elements.stateVersion.textContent = `Версия состояния: ${stats.version}`;
}

const readQueue = new BatchedReadQueue({ onChange: updateQueueStatus });

const mutationQueue = new DeduplicatedMutationQueue({
  onChange: updateQueueStatus,
  onSuccess: (payload) => {
    payload.results.forEach((result) => {
      if (result.id) pendingSelectionIds.delete(result.id);
    });
    updateStats(payload.stats);
    refreshLists();
  },
  onError: (error, willRetry) => {
    if (!willRetry) pendingSelectionIds.clear();
    toast(
      `Изменения не отправлены: ${error.message}.${willRetry ? " Очередь повторит запрос." : ""}`,
      "error",
    );
    availableList.render();
    selectedList.render();
  },
});

const addQueue = new DeduplicatedAddQueue({
  onChange: updateQueueStatus,
  onSuccess: (payload) => {
    const parts = [];
    if (payload.added.length) parts.push(`добавлено: ${payload.added.length}`);
    if (payload.duplicates.length) parts.push(`уже существовало: ${payload.duplicates.length}`);
    if (payload.rejected.length) parts.push(`отклонено: ${payload.rejected.length}`);
    toast(parts.length ? `Пакет обработан — ${parts.join(", ")}.` : "Пустой пакет обработан.");
    refreshLists();
  },
  onError: (error, willRetry) => {
    toast(
      `Добавление не отправлено: ${error.message}.${willRetry ? " Очередь повторит запрос." : ""}`,
      "error",
    );
  },
});

class InfiniteCollection {
  constructor({ resource, scroll, rows, footer, renderRow, emptyMessage }) {
    this.resource = resource;
    this.scroll = scroll;
    this.rows = rows;
    this.footer = footer;
    this.renderRow = renderRow;
    this.emptyMessage = emptyMessage;
    this.query = "";
    this.items = [];
    this.itemIds = new Set();
    this.cursor = undefined;
    this.hasMore = true;
    this.loading = false;
    this.error = null;
    this.generation = 0;

    scroll.addEventListener("scroll", () => {
      const remaining = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
      if (remaining < 180) this.loadMore();
    });
  }

  reset(query = this.query) {
    this.generation += 1;
    this.query = query.trim();
    this.items = [];
    this.itemIds.clear();
    this.cursor = undefined;
    this.hasMore = true;
    this.loading = false;
    this.error = null;
    this.scroll.scrollTop = 0;
    this.render();
    this.loadMore();
  }

  async loadMore() {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    this.error = null;
    this.renderFooter();
    const generation = this.generation;

    try {
      const page = await readQueue.enqueue(this.resource, {
        query: this.query,
        cursor: this.cursor,
        limit: 20,
      });
      if (generation !== this.generation) return;
      for (const item of page.items) {
        if (!this.itemIds.has(item.id)) {
          this.items.push(item);
          this.itemIds.add(item.id);
        }
      }
      this.cursor = page.nextCursor ?? undefined;
      this.hasMore = page.hasMore;
      this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error;
      this.render();
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
        if (
          this.hasMore &&
          this.scroll.scrollHeight <= this.scroll.clientHeight + 10
        ) {
          queueMicrotask(() => this.loadMore());
        }
      }
    }
  }

  render() {
    this.rows.replaceChildren();
    if (!this.items.length && !this.loading && !this.error && !this.hasMore) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = this.emptyMessage;
      this.rows.append(empty);
    } else {
      this.items.forEach((item, index) => this.rows.append(this.renderRow(item, index)));
    }
    this.renderFooter();
  }

  renderFooter() {
    this.footer.replaceChildren();
    if (this.error) {
      const button = document.createElement("button");
      button.className = "retry-button";
      button.type = "button";
      button.textContent = `Ошибка · повторить`;
      button.title = this.error.message;
      button.addEventListener("click", () => this.loadMore());
      this.footer.append(button);
      return;
    }
    if (this.loading) {
      const loader = document.createElement("span");
      loader.className = "loader";
      loader.setAttribute("aria-label", "Загрузка");
      this.footer.append(loader);
      return;
    }
    this.footer.textContent = this.hasMore
      ? "Прокрутите ниже для следующей порции"
      : this.items.length
        ? `Показано: ${this.items.length} · конец списка`
        : "";
  }
}

function createItemInfo(id, meta) {
  const info = document.createElement("div");
  info.className = "item-info";

  const mark = document.createElement("span");
  mark.className = "id-mark";
  mark.textContent = "ID";

  const copy = document.createElement("div");
  copy.className = "item-copy";
  const value = document.createElement("div");
  value.className = "item-id";
  value.textContent = id;
  value.title = id;
  const caption = document.createElement("div");
  caption.className = "item-meta";
  caption.textContent = meta;
  copy.append(value, caption);
  info.append(mark, copy);
  return info;
}

function createAvailableRow(item) {
  const row = document.createElement("div");
  row.className = `item-row${pendingSelectionIds.has(item.id) ? " is-pending" : ""}`;
  row.dataset.id = item.id;
  row.append(createItemInfo(item.id, "доступен для выбора"));

  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.textContent = "+";
  button.title = `Выбрать ID ${item.id}`;
  button.setAttribute("aria-label", button.title);
  button.disabled = pendingSelectionIds.has(item.id);
  button.addEventListener("click", () => {
    pendingSelectionIds.add(item.id);
    mutationQueue.enqueue(`selection:${item.id}`, { type: "select", id: item.id });
    row.classList.add("is-pending");
    button.disabled = true;
    updateQueueStatus();
  });
  row.append(button);
  return row;
}

function createSelectedRow(item) {
  const row = document.createElement("div");
  row.className = `item-row${pendingSelectionIds.has(item.id) ? " is-pending" : ""}`;
  row.dataset.id = item.id;
  row.draggable = true;
  row.append(createItemInfo(item.id, "выбранный элемент"));

  const actions = document.createElement("div");
  actions.className = "selected-actions";
  const dragHandle = document.createElement("span");
  dragHandle.className = "drag-handle";
  dragHandle.textContent = "⠿";
  dragHandle.title = "Перетащите или используйте стрелки";
  dragHandle.tabIndex = 0;
  dragHandle.setAttribute("role", "button");
  dragHandle.setAttribute("aria-label", `Изменить порядок ID ${item.id}`);
  dragHandle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    moveSelectedItem(item.id, event.key === "ArrowUp" ? -1 : 1);
  });

  const removeButton = document.createElement("button");
  removeButton.className = "icon-button remove-button";
  removeButton.type = "button";
  removeButton.textContent = "−";
  removeButton.title = `Убрать ID ${item.id} из выбранных`;
  removeButton.setAttribute("aria-label", removeButton.title);
  removeButton.disabled = pendingSelectionIds.has(item.id);
  removeButton.addEventListener("click", () => {
    pendingSelectionIds.add(item.id);
    mutationQueue.enqueue(`selection:${item.id}`, { type: "deselect", id: item.id });
    row.classList.add("is-pending");
    removeButton.disabled = true;
    updateQueueStatus();
  });
  actions.append(dragHandle, removeButton);
  row.append(actions);
  return row;
}

const availableList = new InfiniteCollection({
  resource: "available",
  scroll: elements.availableScroll,
  rows: elements.availableRows,
  footer: elements.availableFooter,
  renderRow: createAvailableRow,
  emptyMessage: "По этому запросу доступных элементов нет.",
});

const selectedList = new InfiniteCollection({
  resource: "selected",
  scroll: elements.selectedScroll,
  rows: elements.selectedRows,
  footer: elements.selectedFooter,
  renderRow: createSelectedRow,
  emptyMessage: "Здесь появятся выбранные элементы. Добавьте их из списка слева.",
});

async function loadStats() {
  try {
    updateStats(await readQueue.enqueue("stats"));
  } catch (error) {
    toast(`Не удалось получить статистику: ${error.message}`, "error");
  }
}

function refreshLists() {
  availableList.reset(elements.availableSearch.value);
  selectedList.reset(elements.selectedSearch.value);
  loadStats();
}

elements.availableSearch.addEventListener(
  "input",
  debounce(() => availableList.reset(elements.availableSearch.value), 260),
);
elements.selectedSearch.addEventListener(
  "input",
  debounce(() => selectedList.reset(elements.selectedSearch.value), 260),
);

elements.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const id = elements.newId.value.trim();
  if (!id) return;
  if (addQueue.enqueue(id)) {
    toast(`ID «${id}» добавлен в очередь.`);
    elements.newId.value = "";
  } else {
    toast(`ID «${id}» уже ожидает отправки.`);
  }
  updateQueueStatus();
});

let draggedId = null;
let dragStartOrder = "";

elements.selectedRows.addEventListener("dragstart", (event) => {
  const row = event.target.closest(".item-row[data-id]");
  if (!row || event.target.closest("button")) {
    event.preventDefault();
    return;
  }
  draggedId = row.dataset.id;
  dragStartOrder = selectedList.items.map((item) => item.id).join("\u0000");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedId);
  requestAnimationFrame(() => row.classList.add("is-dragging"));
});

elements.selectedRows.addEventListener("dragover", (event) => {
  if (!draggedId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const target = event.target.closest(".item-row[data-id]");
  const dragged = elements.selectedRows.querySelector(
    `.item-row[data-id="${CSS.escape(draggedId)}"]`,
  );
  if (!target || !dragged || target === dragged) return;
  const rectangle = target.getBoundingClientRect();
  const after = event.clientY > rectangle.top + rectangle.height / 2;
  elements.selectedRows.insertBefore(dragged, after ? target.nextSibling : target);
});

function commitDragOrder() {
  if (!draggedId) return;
  const orderedIds = [...elements.selectedRows.querySelectorAll(".item-row[data-id]")].map(
    (row) => row.dataset.id,
  );
  const nextOrder = orderedIds.join("\u0000");
  draggedId = null;
  elements.selectedRows
    .querySelectorAll(".is-dragging")
    .forEach((row) => row.classList.remove("is-dragging"));
  if (nextOrder === dragStartOrder || orderedIds.length < 2) return;

  queueSelectedOrder(orderedIds, "Новый порядок добавлен в очередь.");
}

function queueSelectedOrder(orderedIds, message) {
  const itemById = new Map(selectedList.items.map((item) => [item.id, item]));
  selectedList.items = orderedIds.map((id) => itemById.get(id));
  mutationQueue.enqueue("reorder:selected", {
    type: "reorder",
    orderedIds,
    query: selectedList.query,
  });
  selectedList.render();
  toast(message);
  updateQueueStatus();
}

function moveSelectedItem(id, direction) {
  const orderedIds = selectedList.items.map((item) => item.id);
  const sourceIndex = orderedIds.indexOf(id);
  const targetIndex = sourceIndex + direction;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= orderedIds.length) return;
  [orderedIds[sourceIndex], orderedIds[targetIndex]] = [
    orderedIds[targetIndex],
    orderedIds[sourceIndex],
  ];
  queueSelectedOrder(orderedIds, "Порядок изменен с клавиатуры.");
  requestAnimationFrame(() => {
    elements.selectedRows
      .querySelector(`.item-row[data-id="${CSS.escape(id)}"] .drag-handle`)
      ?.focus();
  });
}

elements.selectedRows.addEventListener("drop", (event) => {
  event.preventDefault();
  commitDragOrder();
});
elements.selectedRows.addEventListener("dragend", commitDragOrder);

document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    event.preventDefault();
    elements.availableSearch.focus();
  }
});

window.addEventListener("pagehide", () => {
  mutationQueue.flushWithBeacon();
  addQueue.flushWithBeacon();
});

setInterval(updateQueueStatus, 1_000);
refreshLists();
updateQueueStatus();

window.__millionSelect = {
  get stats() {
    return latestStats;
  },
  queues: { readQueue, mutationQueue, addQueue },
};
