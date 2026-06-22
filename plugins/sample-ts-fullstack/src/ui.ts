import { formatLine, type RpcResponse } from "./shared";

const output = document.getElementById("sample-ts-output");
const pingButton = document.getElementById("sample-ts-ping");
const countButton = document.getElementById("sample-ts-count");

function append(message: string) {
  if (!output) return;
  output.textContent = `${message}\n${output.textContent || ""}`;
}

async function rpc(method: string, params?: unknown): Promise<RpcResponse> {
  const res = await fetch("/api/plugins/sample-ts-fullstack/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || res.statusText);
  }
  return body.result as RpcResponse;
}

pingButton?.addEventListener("click", async () => {
  try {
    append(formatLine("ping", await rpc("ping")));
  } catch (err) {
    append(`ping failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

countButton?.addEventListener("click", async () => {
  try {
    append(formatLine("increment", await rpc("increment", { by: 1 })));
  } catch (err) {
    append(`increment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});
