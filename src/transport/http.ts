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
import {
  createMcpHandler,
  type McpServerFactory,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import { UobError } from "../util/errors.js";
import { toNodeHandler } from "./node-web-adapter.js";

/** Path the MCP endpoint is served on; clients are configured with `<origin>/mcp`. */
export const MCP_ENDPOINT = "/mcp";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_REQUEST_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface HttpTransportOptions {
  factory: McpServerFactory;
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

export async function startHttpTransport({
  factory,
  config,
  logger: parentLogger,
}: HttpTransportOptions): Promise<HttpTransportHandle> {
  const logger = parentLogger.child("http");
  const host = config.httpHost;

  if (!isLoopbackHost(host)) {
    throw new UobError("INVALID_ARGUMENT", `HTTP host ${host} is not allowed.`, {
      remediation: "Bind Knapper to exactly 127.0.0.1 or ::1.",
      details: { host, allowed: [...LOOPBACK_HOSTS] },
    });
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

  let closing = false;
  const handler = createMcpHandler(factory, {
    legacy: "stateless",
    onerror: (error) => logger.error("MCP request failed", { error: error.message }),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => logger.error("HTTP adapter failed", { error: error.message }),
  });

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
    const hostResult = validateHostHeader(req.headers.host, LOOPBACK_REQUEST_HOSTS);
    if (!hostResult.ok) {
      jsonRpcError(res, 403, -32000, hostResult.message);
      return;
    }
    const originResult = validateOriginHeader(req.headers.origin, LOOPBACK_REQUEST_HOSTS);
    if (!originResult.ok) {
      jsonRpcError(res, 403, -32000, originResult.message);
      return;
    }
    await nodeHandler(req, res);
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
      await handler.close().catch(() => undefined);
      // Idle keep-alive sockets and any open SSE stream would otherwise hold `close`
      // open until the client happens to disconnect.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
