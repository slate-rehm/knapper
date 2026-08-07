import type { IncomingMessage, ServerResponse } from "node:http";

export interface WebRequestHandler {
  fetch(request: Request): Promise<Response>;
}

export interface NodeWebHandlerOptions {
  onerror?: (error: Error) => void;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

export function toWebRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const authority = firstHeader(req.headers.host) ?? "localhost";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(req),
    signal,
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = req as unknown as RequestInit["body"];
    init.duplex = "half";
  }

  return new Request(`http://${authority}${req.url ?? "/"}`, init);
}

async function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.removeListener("drain", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    res.once("drain", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function writeWebResponse(
  response: Response,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  for (const [name, value] of response.headers) res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.statusCode = response.status;

  if (response.body === null) {
    res.end();
    return;
  }

  res.flushHeaders();
  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await waitForDrain(res, signal);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  if (!res.destroyed && !res.writableEnded) res.end();
}

function internalServerError(res: ServerResponse): void {
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.end();
    return;
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null,
  });
  res.writeHead(500, { "Content-Type": "application/json" }).end(body);
}

export function toNodeHandler(
  handler: WebRequestHandler,
  options: NodeWebHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    const abort = new AbortController();
    let finished = false;
    const disconnect = (): void => {
      if (!finished) abort.abort();
    };
    req.once("aborted", disconnect);
    res.once("close", disconnect);

    try {
      const request = toWebRequest(req, abort.signal);
      const response = await handler.fetch(request);
      await writeWebResponse(response, res, abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) {
        const reported = error instanceof Error ? error : new Error(String(error));
        try {
          options.onerror?.(reported);
        } catch {
          // Error reporting must not replace the HTTP fallback.
        }
        internalServerError(res);
      }
    } finally {
      finished = true;
      req.removeListener("aborted", disconnect);
      res.removeListener("close", disconnect);
    }
  };
}
