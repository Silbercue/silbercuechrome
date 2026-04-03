/**
 * Wrap CDP connection errors into user-friendly error messages.
 * Used across all tools to provide consistent error messages during reconnect scenarios.
 */
export function wrapCdpError(err: unknown, toolName: string): string {
  const message = err instanceof Error ? err.message : String(err);

  if (
    message.includes("CdpClient is closed") ||
    message.includes("CdpClient closed") ||
    message.includes("Transport is not connected") ||
    message.includes("Transport closed unexpectedly")
  ) {
    return "CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.";
  }

  return `${toolName} failed: ${message}`;
}
