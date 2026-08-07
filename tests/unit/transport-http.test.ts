import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  startHttpTransport,
  isLoopbackHost,
  type HttpTransportHandle,
} from "../../src/transport/http.js";
import { toNodeHandler, type WebRequestHandler } from "../../src/transport/node-web-adapter.js";
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

async function jsonBody(response: Response): Promise<any> {
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? text);
}

/**
 * A bare `McpServer` rather than `createServer(config)`: the real assembly attaches a
 * CDP router and browser proxy, neither of which exists in unit tests. The transport
 * only needs something that speaks the `Protocol` handshake.
 */
async function start(overrides: Record<string, unknown> = {}): Promise<HttpTransportHandle> {
  const factory = () =>
    new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  // Port 0 lets the OS pick a free port, so parallel test files cannot collide.
  const config = loadConfig({ transport: "http", httpPort: 0, ...overrides }, {});
  const handle = await startHttpTransport({ factory, config, logger: createLogger("silent") });
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

async function startAdapterServer(handler: WebRequestHandler): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const nodeHandler = toNodeHandler(handler);
  const server = createHttpServer((req, res) => void nodeHandler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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
    expect(res.headers.get("mcp-session-id")).toBeNull();

    const body = (await jsonBody(res)) as {
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

  it("does not mint transport session IDs", async () => {
    const handle = await start();

    const first = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify(INITIALIZE),
    });
    expect(first.headers.get("mcp-session-id")).toBeNull();
    await jsonBody(first);
  });

  it("serves a 2026 request with per-request attribution and no session", async () => {
    const handle = await start();
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT,
        "MCP-Protocol-Version": "2026-07-28",
        "MCP-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((await jsonBody(res)).result?.tools).toEqual([]);
  });

  it("rejects requests to any path other than the MCP endpoint", async () => {
    const handle = await start();
    const res = await fetch(handle.url.replace("/mcp", "/"), { method: "POST" });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.message).toMatch(/\/mcp/);
  });

  it("accepts sessionless requests in stateless mode", async () => {
    const handle = await start();
    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect((await jsonBody(res)).result?.tools).toEqual([]);
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

  it("rejects a browser Origin outside the loopback allowlist", async () => {
    const handle = await start();
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT,
        Origin: "https://evil.example",
      },
      body: JSON.stringify(INITIALIZE),
    });

    expect(res.status).toBe(403);
  });

  it("accepts a localhost Host alias while the listener stays literal loopback", async () => {
    const handle = await start();
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
            Host: "localhost",
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
    expect(status).toBe(200);
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
    for (const host of ["127.0.0.1", "::1"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["localhost", "LOCALHOST", "0.0.0.0", "192.168.1.5", "::"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("refuses every non-literal-loopback bind", async () => {
    await expect(start({ httpHost: "0.0.0.0" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

describe("Node web adapter", () => {
  it("streams a Node request body into the web request", async () => {
    let sawFirstChunk: (() => void) | undefined;
    const firstChunkRead = new Promise<void>((resolve) => {
      sawFirstChunk = resolve;
    });
    const adapter = await startAdapterServer({
      fetch: async (request) => {
        const reader = request.body?.getReader();
        const first = await reader?.read();
        sawFirstChunk?.();
        const second = await reader?.read();
        const decoder = new TextDecoder();
        return new Response(decoder.decode(first?.value) + decoder.decode(second?.value));
      },
    });

    try {
      const responseBody = new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: adapter.port, method: "POST" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.once("end", () => resolve(Buffer.concat(chunks).toString()));
            res.once("error", reject);
          },
        );
        req.once("error", reject);
        req.write("first");
        void firstChunkRead.then(() => req.end("second"));
      });

      await expect(firstChunkRead).resolves.toBeUndefined();
      await expect(responseBody).resolves.toBe("firstsecond");
    } finally {
      await adapter.close();
    }
  });

  it("streams SSE response chunks before the response closes", async () => {
    let release: (() => void) | undefined;
    const encoder = new TextEncoder();
    const adapter = await startAdapterServer({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("event: ready\ndata: one\n\n"));
              release = () => {
                controller.enqueue(encoder.encode("event: done\ndata: two\n\n"));
                controller.close();
              };
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });

    try {
      const firstChunk = new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: adapter.port }, (res) => {
          expect(res.headers["content-type"]).toBe("text/event-stream");
          res.once("data", (chunk: Buffer) => resolve(chunk.toString()));
          res.once("error", reject);
          res.resume();
        });
        req.once("error", reject);
        req.end();
      });

      await expect(firstChunk).resolves.toContain("event: ready");
      release?.();
    } finally {
      await adapter.close();
    }
  });

  it("aborts the web request when the client disconnects", async () => {
    let sawAbort: (() => void) | undefined;
    let sawRequest: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });
    const received = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    const adapter = await startAdapterServer({
      fetch: (request) =>
        new Promise<Response>((resolve) => {
          sawRequest?.();
          request.signal.addEventListener(
            "abort",
            () => {
              sawAbort?.();
              resolve(new Response(null, { status: 204 }));
            },
            { once: true },
          );
        }),
    });

    try {
      const req = httpRequest({ host: "127.0.0.1", port: adapter.port });
      req.once("error", () => undefined);
      req.end();
      await received;
      req.destroy();
      await expect(aborted).resolves.toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});
