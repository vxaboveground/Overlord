export type RpcResponse = {
  message: string;
  count?: number;
  at: string;
};

export function formatLine(label: string, value: RpcResponse): string {
  const count = typeof value.count === "number" ? ` count=${value.count}` : "";
  return `${label}: ${value.message}${count} at ${value.at}`;
}
