import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ItemStore, ValidationError } from "./store.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const publicDirectory = path.resolve(currentDirectory, "../public");

export function createApp({ store = new ItemStore() } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, stats: store.getStats() });
  });

  app.get("/api/stats", (_request, response) => {
    response.json(store.getStats());
  });

  app.get("/api/items/available", (request, response) => {
    response.json(store.getAvailablePage(request.query));
  });

  app.get("/api/items/selected", (request, response) => {
    response.json(store.getSelectedPage(request.query));
  });

  app.post("/api/read/batch", (request, response) => {
    const requests = request.body?.requests;
    if (!Array.isArray(requests)) {
      throw new ValidationError("requests должен быть массивом");
    }
    if (requests.length > 100) {
      throw new ValidationError("За один батч можно выполнить не более 100 чтений");
    }

    const results = requests.map((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string") {
        throw new ValidationError("Каждое чтение должно содержать строковый key");
      }

      let data;
      switch (entry.resource) {
        case "available":
          data = store.getAvailablePage(entry.params);
          break;
        case "selected":
          data = store.getSelectedPage(entry.params);
          break;
        case "stats":
          data = store.getStats();
          break;
        default:
          throw new ValidationError(`Неизвестный ресурс: ${entry.resource}`);
      }
      return { key: entry.key, data };
    });

    response.json({ results });
  });

  app.post("/api/items/batch", (request, response) => {
    const result = store.addItems(request.body?.ids, request.body?.requestId);
    response.status(result.added.length ? 201 : 200).json(result);
  });

  app.post("/api/state/batch", (request, response) => {
    response.json(store.applyOperations(request.body?.operations));
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "Метод API не найден" });
  });

  app.use(express.static(publicDirectory, { extensions: ["html"] }));
  app.get("/{*path}", (_request, response) => {
    response.sendFile(path.join(publicDirectory, "index.html"));
  });

  app.use((error, _request, response, _next) => {
    const status = error.status ?? (error instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(error);
    response.status(status).json({
      error: status >= 500 ? "Внутренняя ошибка сервера" : error.message,
      details: error.details,
    });
  });

  return app;
}

export function startServer({
  port = Number(process.env.PORT) || 4173,
  host = process.env.HOST || "127.0.0.1",
} = {}) {
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`Million Item Selector: http://${host}:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal}: graceful shutdown`);
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}

if (process.argv[1] === currentFile) startServer();
