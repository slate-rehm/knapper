/**
 * Optional Streamable HTTP transport.
 *
 * The default transport is stdio, where the client owns the process lifetime. HTTP
 * exists for hosts that cannot spawn a child process, and for attaching a second
 * agent to an already-running server.
 *
 * Security note: every tool this server exposes drives the user's live Obsidian
 * window — keystrokes, file writes, plugin installs. An HTTP listener therefore
 * hands remote control of a desktop app to anyone who can reach the port, which is
 * why the default bind is loopback and a non-loopback bind is warned about loudly.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import { UobError } from "../util/errors.js";

/** Path the MCP endpoint is served on; clients are configured with `<origin>/mcp`. */
export const MCP_ENDPOINT = "/mcp";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** Wildcard binds accept connections on every interface, so no single Host value is knowable. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", ""]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface HttpTransportOptions {
  server: McpServer;
  config: Config;
  logger: Logger;
}

export interface HttpTransportHandle {
  /** Origin the listener is reachable at, with the port actually bound. */
  url: string;
  port: number;
  close(): Promise<void>;
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  res.writeHead(status, { "Content-Type": "application/json" }).end(body);
}

/**
 * Host header values accepted when DNS-rebinding protection is on. The port is only
 * known after `listen` resolves (callers may pass 0 for an ephemeral port), so this
 * is built afterwards rather than at construction time.
 */
function allowedHostsFor(host: string, port: number): string[] {
  const hosts = new Set([`${host}:${port}`]);
  if (isLoopbackHost(host)) {
    hosts.add(`127.0.0.1:${port}`);
    hosts.add(`localhost:${port}`);
    hosts.add(`[::1]:${port}`);
  }
  return [...hosts];
}

export async function startHttpTransport({
  server,
  config,
  logger: parentLogger,
}: HttpTransportOptions): Promise<HttpTransportHandle> {
  const logger = parentLogger.child("http");
  const host = config.httpHost;

  if (!isLoopbackHost(host)) {
    logger.warn(
      `binding the MCP endpoint to ${host}, which is not a loopback address — anyone who can ` +
        "reach this port gains full control of your live Obsidian UI, including file writes and " +
        "plugin installs. Bind 127.0.0.1 (MCP_HOST) unless you have put authentication in front " +
        "of this listener.",
    );
  }

  const httpServer = createHttpServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      reject(
        err.code === "EADDRINUSE"
          ? new UobError(
              "INVALID_ARGUMENT",
              `Port ${config.httpPort} on ${host} is already in use.`,
              {
                remediation:
                  "Another process — often a second copy of this server — already owns the port. " +
                  "Stop it, or pick a different port with --port / MCP_PORT.",
                cause: err,
                details: { host, port: config.httpPort },
              },
            )
          : err,
      );
    };
    httpServer.once("error", onError);
    httpServer.listen(config.httpPort, host, () => {
      httpServer.removeListener("error", onError);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo | null;
  const port = address?.port ?? config.httpPort;
  const allowedHosts = allowedHostsFor(host, port);

  /**
   * One MCP session at a time. The SDK requires either a fresh transport per stateless
   * request or one transport per session, and a transport can only be bound to one
   * `Protocol` instance — but a `ServerContext` owns a single CDP attachment to a single
   * Obsidian window, so spinning up a server per session would multiply that attachment.
   * Concurrent agents would fight over the same UI anyway, so the session is armed lazily
   * and re-armed after the client terminates it with DELETE.
   */
  let active: Promise<StreamableHTTPServerTransport> | undefined;
  let closing = false;

  const arm = async (): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Plain JSON replies instead of a one-shot SSE stream per POST. Server-initiated
      // messages still use the standalone GET stream; this only affects request/response.
      enableJsonResponse: true,
      // Wildcard binds have no single legitimate Host value, so an allowlist there would
      // reject every real client rather than protect anything.
      ...(WILDCARD_HOSTS.has(host) ? {} : { enableDnsRebindingProtection: true, allowedHosts }),
      onsessionclosed: (sessionId: string) => {
        logger.info("session terminated by client", { sessionId });
        active = undefined;
      },
    });
    await server.connect(transport);
    return transport;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (closing) {
      jsonRpcError(res, 503, -32000, "Server is shutting down");
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path !== MCP_ENDPOINT) {
      jsonRpcError(res, 404, -32601, `Unknown endpoint. MCP is served at ${MCP_ENDPOINT}.`);
      return;
    }
    // `active` is replaced, never awaited twice concurrently on a stale value: reads and
    // the assignment below both happen synchronously on the event loop turn.
    active ??= arm();
    const transport = await active;
    await transport.handleRequest(req, res);
  };

  httpServer.on("request", (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error("request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
      else res.end();
    });
  });

  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}${MCP_ENDPOINT}`;

  return {
    url,
    port,
    close: async (): Promise<void> => {
      closing = true;
      const transport = active;
      active = undefined;
      if (transport) await (await transport).close().catch(() => undefined);
      // Idle keep-alive sockets and any open SSE stream would otherwise hold `close`
      // open until the client happens to disconnect.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
