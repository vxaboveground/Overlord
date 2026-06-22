import type { RpcResponse } from "./shared";

type PluginContext = {
  db: {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...args: unknown[]): any;
      run(...args: unknown[]): any;
    };
  };
  log: { info(message: string): void };
};

function now(): string {
  return new Date().toISOString();
}

function response(message: string, count?: number): RpcResponse {
  return { message, count, at: now() };
}

export default {
  setup(ctx: PluginContext) {
    ctx.db.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)");
    ctx.db.prepare("INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)").run();
    ctx.log.info("sample-ts-fullstack ready");
  },

  rpc: {
    ping(): RpcResponse {
      return response("hello from TypeScript server");
    },

    increment(ctx: PluginContext, params: unknown): RpcResponse {
      const by = typeof (params as any)?.by === "number" ? Math.trunc((params as any).by) : 1;
      ctx.db.prepare("UPDATE counter SET value = value + ? WHERE id = 1").run(by);
      const row = ctx.db.prepare("SELECT value FROM counter WHERE id = 1").get();
      return response("counter updated", Number(row?.value || 0));
    },
  },
};
