import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  startHttpTransport,
  isLoopbackHost,
  type HttpTransportHandle,
} from "../../src/transport/http.js";
import { createLogger } from "../../src/util/logger.js";

const MCP_ACCEPT = "application/json, text/event-stream";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  },
} as const;

const started: HttpTransportHandle[] = [];

/**
 * A bare `McpServer` rather than `createServer(config)`: the real assembly attaches a
 * CDP router and browser proxy, neither of which exists in unit tests. The transport
 * only needs something that speaks the `Protocol` handshake.
 */
async function start(overrides: Record<string, unknown> = {}): Promise<HttpTransportHandle> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  // Port 0 lets the OS pick a free port, so parallel test files cannot collide.
  const config = loadConfig({ transport: "http", httpPort: 0, ...overrides }, {});
  const handle = await startHttpTransport({ server, config, logger: createLogger("silent") });
  started.push(handle);
  return handle;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((handle) => handle.close()));
});

describe("startHttpTransport", () => {
  it("completes a real MCP initialize handshake over HTTP", async () => {
    const handle = await start();

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(INITIALIZE),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result?: { serverInfo?: { name?: string }; protocolVersion?: string };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result?.serverInfo?.name).toBe("test");
    expect(body.result?.protocolVersion).toBeTruthy();
  });

  it("serves a fresh session after the client terminates one with DELETE", async () => {
    const handle = await start();

    const first = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(INITIALIZE),
    });
    const sessionId = first.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await first.json();

    const deleted = await fetch(handle.url, {
      method: "DELETE",
      headers: { Accept: MCP_ACCEPT, "mcp-session-id": sessionId ?? "" },
    });
    expect(deleted.status).toBeLessThan(300);

    const second = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(INITIALIZE),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("mcp-session-id")).not.toBe(sessionId);
    await second.json();
  });

  it("rejects requests to any path other than the MCP endpoint", async () => {
    const handle = await start();
    const res = await fetch(handle.url.replace("/mcp", "/"), { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/\/mcp/);
  });

  it("rejects a non-initialize request that carries no session", async () => {
    const handle = await start();
    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it("rejects a Host header that is not the address it was bound to", async () => {
    const handle = await start();
    // `fetch` refuses to override Host (it is a forbidden header there), and Host is
    // exactly what DNS-rebinding protection inspects, so this one goes over raw http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: MCP_ACCEPT,
            Host: "evil.example",
          },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.once("error", reject);
      req.end(JSON.stringify(INITIALIZE));
    });
    expect(status).toBe(403);
  });

  it("releases the port on close", async () => {
    const handle = await start();
    expect(await portIsFree(handle.port)).toBe(false);
    await handle.close();
    started.length = 0;
    expect(await portIsFree(handle.port)).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it("recognizes the addresses that keep the listener off the network", () => {
    for (const host of ["127.0.0.1", "::1", "localhost", "LOCALHOST"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "192.168.1.5", "::"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
