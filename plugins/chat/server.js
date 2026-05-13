export default {
  setup(ctx) {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id   TEXT NOT NULL,
        sender      TEXT NOT NULL,
        direction   TEXT NOT NULL,
        text        TEXT NOT NULL,
        timestamp   INTEGER NOT NULL
      );
    `);
    try {
      ctx.db.exec(
        `CREATE INDEX IF NOT EXISTS msg_by_client ON messages(client_id, timestamp)`
      );
    } catch (_) {}
  },

  onEvent(ctx, clientId, event, payload) {
    if (event === "chat_message") {
      const ts = Date.now();
      ctx.db
        .prepare(
          `INSERT INTO messages(client_id, sender, direction, text, timestamp) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          clientId,
          payload.from || "Unknown",
          "from_target",
          payload.text || "",
          ts
        );
      ctx.broadcast("new_message", {
        clientId,
        sender: payload.from || "Unknown",
        direction: "from_target",
        text: payload.text || "",
        timestamp: ts,
      });
    }
    if (event === "chat_opened") {
      ctx.broadcast("chat_status", { clientId, status: "opened" });
    }
    if (event === "chat_closed") {
      ctx.broadcast("chat_status", { clientId, status: "closed" });
    }
  },

  rpc: {
    get_history(ctx, params) {
      return ctx.db
        .prepare(
          `SELECT * FROM messages WHERE client_id = ? ORDER BY timestamp ASC LIMIT 500`
        )
        .all(params.clientId);
    },

    store_message(ctx, params) {
      const ts = Date.now();
      ctx.db
        .prepare(
          `INSERT INTO messages(client_id, sender, direction, text, timestamp) VALUES (?, ?, ?, ?, ?)`
        )
        .run(params.clientId, params.sender, "to_target", params.text, ts);
      ctx.broadcast("new_message", {
        clientId: params.clientId,
        sender: params.sender,
        direction: "to_target",
        text: params.text,
        timestamp: ts,
      });
      return { ok: true, timestamp: ts };
    },

    clear_history(ctx, params) {
      ctx.db
        .prepare(`DELETE FROM messages WHERE client_id = ?`)
        .run(params.clientId);
      ctx.broadcast("history_cleared", { clientId: params.clientId });
      return { ok: true };
    },
  },
};
