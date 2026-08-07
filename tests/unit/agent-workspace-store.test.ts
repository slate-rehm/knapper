import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeAgent,
  openAgent,
  readAgent,
  requireAgent,
  touchAgent,
} from "../../src/agent/store.js";
import {
  createWorkspaceRecord,
  readWorkspace,
  removeWorkspaceRecord,
  requireWorkspace,
  touchWorkspace,
} from "../../src/workspace/store.js";
import { agentsDir, workspacesDir } from "../../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-agent-workspace-"));
  env = { ...process.env, KNAP_HOME: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("agent and workspace handles", () => {
  it("mints opaque 192-bit handles and stores private records", async () => {
    const agent = await openAgent({ label: "test agent", env });
    const workspace = await createWorkspaceRecord({
      agentHandle: agent.handle,
      kind: "isolated",
      sessionKey: "test-a3f19c22",
      env,
    });

    expect(agent.handle).toMatch(/^agt_[A-Za-z0-9_-]{32}$/);
    expect(workspace.handle).toMatch(/^wsp_[A-Za-z0-9_-]{32}$/);
    expect((await stat(join(agentsDir(env), `${agent.handle}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(workspacesDir(env), `${workspace.handle}.json`))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("records observed client software without treating it as identity", async () => {
    const agent = await openAgent({ label: "client audit", env });
    await touchAgent(agent.handle, { name: "opencode", version: "1.2.3" }, env);
    const updated = await readAgent(agent.handle, env);
    expect(updated?.observedClients).toMatchObject([{ name: "opencode", version: "1.2.3" }]);
    expect(updated?.handle).toBe(agent.handle);
  });

  it("keeps concurrent touches readable and extends both leases", async () => {
    const agent = await openAgent({ label: "concurrent", env });
    const workspace = await createWorkspaceRecord({
      agentHandle: agent.handle,
      kind: "default",
      env,
    });

    await Promise.all([
      touchAgent(agent.handle, { name: "opencode", version: "1" }, env),
      touchAgent(agent.handle, { name: "kimi", version: "1" }, env),
      touchWorkspace(workspace.handle, env),
    ]);

    expect((await readAgent(agent.handle, env))?.observedClients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "opencode", version: "1" }),
        expect.objectContaining({ name: "kimi", version: "1" }),
      ]),
    );
    expect(
      JSON.parse(await readFile(join(agentsDir(env), `${agent.handle}.json`), "utf8")),
    ).toBeTruthy();
    expect(await requireWorkspace(workspace.handle, env)).toMatchObject({
      agentHandle: agent.handle,
      kind: "default",
    });
  });

  it("expires stale workspace handles", async () => {
    const agent = await openAgent({ label: "expired", env });
    const workspace = await createWorkspaceRecord({
      agentHandle: agent.handle,
      kind: "default",
      now: new Date("2000-01-01T00:00:00.000Z"),
      env,
    });

    await expect(requireWorkspace(workspace.handle, env)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("fails closed when persisted expiry dates are malformed", async () => {
    const agent = await openAgent({ label: "malformed", env });
    const workspace = await createWorkspaceRecord({
      agentHandle: agent.handle,
      kind: "default",
      env,
    });
    await writeFile(
      join(agentsDir(env), `${agent.handle}.json`),
      JSON.stringify({ ...agent, expiresAt: "not-a-date" }),
    );
    await writeFile(
      join(workspacesDir(env), `${workspace.handle}.json`),
      JSON.stringify({ ...workspace, expiresAt: "not-a-date" }),
    );

    await expect(requireAgent(agent.handle, env)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(requireWorkspace(workspace.handle, env)).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("allows an expired agent record to be closed", async () => {
    const agent = await openAgent({
      label: "expired agent",
      now: new Date("2000-01-01T00:00:00.000Z"),
      env,
    });

    await expect(closeAgent(agent.handle, env)).resolves.toBe(true);
    expect(await readAgent(agent.handle, env)).toBeUndefined();
  });

  it("removes records without touching unrelated state", async () => {
    const agent = await openAgent({ label: "cleanup", env });
    const unrelatedAgent = await openAgent({ label: "unrelated", env });
    const workspace = await createWorkspaceRecord({
      agentHandle: agent.handle,
      kind: "default",
      env,
    });
    const unrelatedWorkspace = await createWorkspaceRecord({
      agentHandle: unrelatedAgent.handle,
      kind: "default",
      env,
    });
    await removeWorkspaceRecord(workspace.handle, env);
    await closeAgent(agent.handle, env);
    expect(await readWorkspace(workspace.handle, env)).toBeUndefined();
    expect(await readAgent(agent.handle, env)).toBeUndefined();
    expect(await readWorkspace(unrelatedWorkspace.handle, env)).toMatchObject({
      agentHandle: unrelatedAgent.handle,
    });
    expect(await readAgent(unrelatedAgent.handle, env)).toMatchObject({
      handle: unrelatedAgent.handle,
    });
  });
});
