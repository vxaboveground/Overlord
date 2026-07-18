import { describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import {
  createUser,
  deleteUser,
  getUserById,
  setUserClientAccessRule,
  setUserClientAccessScope,
  setUserPluginAccessScope,
} from "../../users";
import { handlePluginRoutes } from "./plugin-routes";

describe("plugin dashboard contribution authorization", () => {
  test("only exposes authorized client IDs to plugins and their responses", async () => {
    const username = `pd_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const created = await createUser(username, "Aa1!PluginDashboardScopePass123", "operator", "test");
    expect(created.success).toBe(true);
    const user = getUserById(created.userId!);
    expect(user).not.toBeNull();
    expect(setUserClientAccessScope(user!.id, "allowlist").success).toBe(true);
    expect(setUserClientAccessRule(user!.id, "client-allowed", "allow").success).toBe(true);
    expect(setUserPluginAccessScope(user!.id, "all").success).toBe(true);

    const rpcCalls: any[] = [];
    const deps = {
      pluginState: {
        enabled: {},
        lastError: {},
        autoLoad: {},
        autoStartEvents: {},
        approvedNeeds: {},
      },
      listPluginManifests: async () => [{
        id: "dashboard-test",
        name: "Dashboard Test",
        dashboard: { clientBadges: [] },
      }],
      pluginRuntime: {
        isRunning: () => true,
        rpc: async (...args: any[]) => {
          rpcCalls.push(args);
          return [
            { clientId: "client-allowed", badges: [{ text: "visible" }] },
            { clientId: "client-denied", badges: [{ text: "hidden" }] },
          ];
        },
      },
    } as any;

    try {
      const token = await generateToken(user!);
      const url = new URL("https://localhost/api/plugins/dashboard-contributions");
      const response = await handlePluginRoutes(
        new Request(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ clientIds: ["client-allowed", "client-denied"] }),
        }),
        url,
        deps,
      );

      expect(response?.status).toBe(200);
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0][2]).toEqual({ clientIds: ["client-allowed"] });
      const body = await response!.json() as any;
      expect(body.contributions).toEqual([{
        pluginId: "dashboard-test",
        clientId: "client-allowed",
        badges: [{ text: "visible" }],
      }]);
    } finally {
      deleteUser(user!.id);
    }
  });
});
