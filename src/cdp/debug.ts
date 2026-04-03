const isDebug = (process.env.DEBUG ?? "").includes("silbercuechrome");

export function debug(message: string, ...args: unknown[]): void {
  if (!isDebug) return;
  console.error(`[silbercuechrome] ${message}`, ...args);
}
