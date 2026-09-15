import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { BrokerConfig } from "./config.js";
import { AttemptStore } from "./attempt-store.js";
import { MetaClient } from "./meta-client.js";

export function createApp(config: BrokerConfig, store = new AttemptStore(), meta = new MetaClient(config)) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.desktopOrigin, methods: ["GET", "POST"] }));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response) => response.json({ ok: true }));

  app.post("/oauth/start", (_request, response) => {
    const attempt = store.create();
    response.json({ ...attempt, authorizationUrl: meta.authorizationUrl(attempt.state) });
  });

  app.get("/oauth/callback", async (request, response) => {
    const state = stringParam(request.query.state);
    const code = stringParam(request.query.code);
    const error = stringParam(request.query.error_description) ?? stringParam(request.query.error);
    if (!state || !store.exists(state)) return response.status(400).send(resultPage("認証情報が無効か期限切れです。", false));
    if (error) return response.status(400).send(resultPage(`Instagram認証を完了できませんでした: ${escapeHtml(error)}`, false));
    if (!code) return response.status(400).send(resultPage("認証コードがありません。", false));

    try {
      const connection = await meta.exchangeCode(code);
      if (!store.complete(state, connection)) throw new Error("Authentication attempt has expired");
      const callback = new URL(config.desktopOrigin + "/oauth/callback");
      callback.searchParams.set("state", state);
      response.redirect(callback.toString());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unknown error";
      response.status(502).send(resultPage(`Meta APIとの通信に失敗しました: ${escapeHtml(message)}`, false));
    }
  });

  app.post("/oauth/redeem", (request, response) => {
    const state = typeof request.body?.state === "string" ? request.body.state : "";
    const verifier = typeof request.body?.verifier === "string" ? request.body.verifier : "";
    const connection = store.redeem(state, verifier);
    if (!connection) return response.status(400).json({ error: "認証結果が無効か、すでに使用されています。" });
    response.json(connection);
  });

  return app;
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function resultPage(message: string, success: boolean): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>IGUP</title><body><h1>${success ? "完了" : "エラー"}</h1><p>${message}</p></body></html>`;
}
