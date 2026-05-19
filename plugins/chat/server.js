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

    const cols = ctx.db
      .prepare(`PRAGMA table_info(messages)`)
      .all()
      .map((r) => r.name);
    if (!cols.includes("attachment_name")) {
      try {
        ctx.db.exec(`ALTER TABLE messages ADD COLUMN attachment_name TEXT`);
      } catch (_) {}
    }
    if (!cols.includes("attachment_mime")) {
      try {
        ctx.db.exec(`ALTER TABLE messages ADD COLUMN attachment_mime TEXT`);
      } catch (_) {}
    }
    if (!cols.includes("attachment_data")) {
      try {
        ctx.db.exec(`ALTER TABLE messages ADD COLUMN attachment_data BLOB`);
      } catch (_) {}
    }
  },

  onEvent(ctx, clientId, event, payload) {
    if (event === "chat_message") {
      const ts = Date.now();
      const info = ctx.db
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
        id: Number(info.lastInsertRowid),
        clientId,
        sender: payload.from || "Unknown",
        direction: "from_target",
        text: payload.text || "",
        timestamp: ts,
      });
    }
    if (event === "chat_attachment") {
      const ts = Date.now();
      const name = payload.name || "file";
      const mime = payload.mime || "application/octet-stream";
      let buf = null;
      try {
        buf = Buffer.from(payload.dataB64 || "", "base64");
      } catch (_) {
        buf = null;
      }
      if (!buf || buf.length === 0) return;
      const info = ctx.db
        .prepare(
          `INSERT INTO messages(client_id, sender, direction, text, timestamp, attachment_name, attachment_mime, attachment_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          clientId,
          payload.from || "Unknown",
          "from_target",
          "",
          ts,
          name,
          mime,
          buf
        );
      ctx.broadcast("new_message", {
        id: Number(info.lastInsertRowid),
        clientId,
        sender: payload.from || "Unknown",
        direction: "from_target",
        text: "",
        timestamp: ts,
        attachment: { name, mime, size: buf.length },
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
          `SELECT id, client_id, sender, direction, text, timestamp,
                  attachment_name, attachment_mime,
                  CASE WHEN attachment_data IS NULL THEN 0 ELSE length(attachment_data) END AS attachment_size
           FROM messages WHERE client_id = ? ORDER BY timestamp ASC LIMIT 500`
        )
        .all(params.clientId)
        .map((r) => ({
          id: r.id,
          clientId: r.client_id,
          sender: r.sender,
          direction: r.direction,
          text: r.text,
          timestamp: r.timestamp,
          attachment: r.attachment_name
            ? {
                name: r.attachment_name,
                mime: r.attachment_mime,
                size: r.attachment_size,
              }
            : null,
        }));
    },

    get_attachment(ctx, params) {
      const row = ctx.db
        .prepare(
          `SELECT attachment_name, attachment_mime, attachment_data FROM messages WHERE id = ?`
        )
        .get(params.id);
      if (!row || !row.attachment_data) {
        return { ok: false, error: "not found" };
      }
      const buf = Buffer.isBuffer(row.attachment_data)
        ? row.attachment_data
        : Buffer.from(row.attachment_data);
      return {
        ok: true,
        name: row.attachment_name,
        mime: row.attachment_mime,
        dataB64: buf.toString("base64"),
      };
    },

    store_message(ctx, params) {
      const ts = Date.now();
      const info = ctx.db
        .prepare(
          `INSERT INTO messages(client_id, sender, direction, text, timestamp) VALUES (?, ?, ?, ?, ?)`
        )
        .run(params.clientId, params.sender, "to_target", params.text, ts);
      ctx.broadcast("new_message", {
        id: Number(info.lastInsertRowid),
        clientId: params.clientId,
        sender: params.sender,
        direction: "to_target",
        text: params.text,
        timestamp: ts,
      });
      return { ok: true, id: Number(info.lastInsertRowid), timestamp: ts };
    },

    store_attachment(ctx, params) {
      const ts = Date.now();
      const name = params.name || "file";
      const mime = params.mime || "application/octet-stream";
      let buf = null;
      try {
        buf = Buffer.from(params.dataB64 || "", "base64");
      } catch (_) {}
      if (!buf || buf.length === 0) {
        return { ok: false, error: "empty data" };
      }
      const info = ctx.db
        .prepare(
          `INSERT INTO messages(client_id, sender, direction, text, timestamp, attachment_name, attachment_mime, attachment_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.clientId,
          params.sender,
          "to_target",
          "",
          ts,
          name,
          mime,
          buf
        );
      ctx.broadcast("new_message", {
        id: Number(info.lastInsertRowid),
        clientId: params.clientId,
        sender: params.sender,
        direction: "to_target",
        text: "",
        timestamp: ts,
        attachment: { name, mime, size: buf.length },
      });
      return { ok: true, id: Number(info.lastInsertRowid), timestamp: ts };
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
