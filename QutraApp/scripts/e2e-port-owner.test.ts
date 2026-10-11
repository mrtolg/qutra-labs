import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_SERVER_OWNER_FILE,
  devServerOwner,
  writeDevServerOwner,
} from "./dev-server-owner";

/* The gate may stop only the Vite this checkout started and recorded (PID and
   start time). Anything else on the port is named and left running. These
   tests hold real listeners on ephemeral ports, never 5174 or 5184, which
   belong to the other checkouts. */

const PORT_OWNER_SCRIPT = path.join(__dirname, "e2e-port-owner.ps1");

interface Listener {
  child: ChildProcess;
  pid: number;
  port: number;
  timeOrigin: number;
  listenedAt: number;
}

const listeners: ChildProcess[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const child of listeners.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "qutra-port-owner-"));
  roots.push(root);
  return root;
}

/** A plain Node listener on an ephemeral port, spelled the way a real dev server is started:
    `node -e <code> <root>/node_modules/vite/bin/vite.js`. The command line
    names this checkout's Vite, yet only the record may make it ours. */
function startListener(root: string): Promise<Listener> {
  const code = [
    "const s = require('net').createServer();",
    "s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({",
    "  pid: process.pid, port: s.address().port,",
    "  timeOrigin: performance.timeOrigin, listenedAt: Date.now() })));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["-e", code, path.join(root, "node_modules", "vite", "bin", "vite.js")],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  listeners.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve({ child, ...JSON.parse(out) });
    });
    child.once("exit", (exitCode) => reject(new Error(`listener exited ${exitCode}`)));
  });
}

function clearPort(port: number, appRoot: string) {
  const command = [
    // The gate runs with this preference (gate.ps1), so a failed cast is not
    // fatal there: the script carries on to the next statement.
    "$ErrorActionPreference = 'Continue'",
    `. '${PORT_OWNER_SCRIPT}'`,
    `$r = Clear-E2ePort -Port ${port} -AppRoot '${appRoot}'`,
    "Write-Output $r.Message",
    "exit $r.Code",
  ].join("; ");
  const run = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe.skipIf(process.platform !== "win32")("gate e2e port ownership", () => {
  it("stops the recorded Vite of this checkout", async () => {
    const root = tempRoot();
    const held = await startListener(root);
    writeDevServerOwner(root, {
      pid: held.pid,
      port: held.port,
      startedAtMs: held.timeOrigin,
      recordedAtMs: held.listenedAt,
    });

    const result = clearPort(held.port, root);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`PID ${held.pid}`);
    expect(await exited(held.child, 10_000)).toBe(true);
    expect(existsSync(path.join(root, DEV_SERVER_OWNER_FILE))).toBe(false);
  }, 40_000);

  it("leaves a recycled PID alone when its start time differs from the record", async () => {
    const root = tempRoot();
    const held = await startListener(root);
    // The record is from an earlier process that had this PID: it started and
    // recorded a minute before the process that now holds the port.
    writeDevServerOwner(root, {
      pid: held.pid,
      port: held.port,
      startedAtMs: held.timeOrigin - 60_000,
      recordedAtMs: held.timeOrigin - 59_000,
    });

    const result = clearPort(held.port, root);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`PID ${held.pid}`);
    expect(result.output).toContain("will not stop it");
    expect(await exited(held.child, 1_500)).toBe(false);
  }, 40_000);

  it("leaves a PID recycled within seconds alone: it started after the record was written", async () => {
    const root = tempRoot();
    const held = await startListener(root);
    // Start times are 2 s apart, inside the clock tolerance; the record was
    // written before the current holder existed, so the holder is not ours.
    writeDevServerOwner(root, {
      pid: held.pid,
      port: held.port,
      startedAtMs: held.timeOrigin - 2_000,
      recordedAtMs: held.timeOrigin - 1_500,
    });

    const result = clearPort(held.port, root);

    expect(result.code).toBe(1);
    expect(result.output).toContain("will not stop it");
    expect(await exited(held.child, 1_500)).toBe(false);
  }, 40_000);

  it("fails without touching a holder this checkout never recorded", async () => {
    const root = tempRoot();
    const held = await startListener(root);

    const result = clearPort(held.port, root);

    expect(result.code).toBe(1);
    expect(result.output).toContain(`PID ${held.pid}`);
    expect(result.output).toContain("will not stop it");
    expect(await exited(held.child, 1_500)).toBe(false);
  }, 40_000);

  it("does not trust a record written for another port", async () => {
    const root = tempRoot();
    const held = await startListener(root);
    writeDevServerOwner(root, {
      pid: held.pid,
      port: held.port + 1,
      startedAtMs: held.timeOrigin,
      recordedAtMs: held.listenedAt,
    });

    const result = clearPort(held.port, root);

    expect(result.code).toBe(1);
    expect(await exited(held.child, 1_500)).toBe(false);
  }, 40_000);

  it("never trusts a malformed record, whatever its timestamps say", async () => {
    const root = tempRoot();
    const held = await startListener(root);
    const started = Math.floor(held.timeOrigin);
    const record = (pid: string, port: string, startedAtMs = `${started}`, recordedAtMs = `${held.listenedAt}`) =>
      `{"pid":${pid},"port":${port},"startedAtMs":${startedAtMs},"recordedAtMs":${recordedAtMs}}\n`;
    const pid = `${held.pid}`;
    const port = `${held.port}`;
    // The timestamps match the holder, so only the PID and port checks stand
    // between it and Stop-Process. A failed [int64] cast once skipped them.
    const malformed = [
      record('"bad"', port),
      record(pid, '"bad"'),
      record('"9223372036854775808"', port),
      record("9223372036854775808", port),
      record(`"${pid}"`, port),
      record(`${pid}.5`, port),
      record(pid, "-1"),
      record("null", port),
      record("true", port),
      record(pid, port, '"bad"'),
      record(pid, port, `${started}`, '"bad"'),
      `[${pid},${port}]\n`,
    ];

    for (const text of malformed) {
      writeFileSync(path.join(root, DEV_SERVER_OWNER_FILE), text);
      const result = clearPort(held.port, root);
      expect(result.code, `${text}${result.output}`).toBe(1);
      expect(result.output, text).toContain("will not stop it");
      expect(await exited(held.child, 300), text).toBe(false);
    }
  }, 120_000);

  it("passes when nothing holds the port", async () => {
    const root = tempRoot();
    const held = await startListener(root);
    held.child.kill();
    await exited(held.child, 10_000);

    const result = clearPort(held.port, root);

    expect(result.code, result.output).toBe(0);
  }, 40_000);
});

describe("devServerOwner plugin", () => {
  function fakeServer(root: string, port: number) {
    const httpServer = Object.assign(new EventEmitter(), {
      address: () => ({ address: "127.0.0.1", family: "IPv4", port }),
    });
    return { config: { root }, httpServer };
  }

  function runPlugin(server: ReturnType<typeof fakeServer>) {
    const plugin = devServerOwner();
    const hook = plugin.configureServer as (s: unknown) => void;
    hook(server);
  }

  it("records this process's PID, port and start time once Vite listens", () => {
    const root = tempRoot();
    const server = fakeServer(root, 45_123);
    runPlugin(server);
    const file = path.join(root, DEV_SERVER_OWNER_FILE);
    expect(existsSync(file)).toBe(false);

    server.httpServer.emit("listening");

    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.port).toBe(45_123);
    expect(record.startedAtMs).toBe(Math.floor(performance.timeOrigin));
    expect(record.recordedAtMs).toBeGreaterThanOrEqual(record.startedAtMs);
  });

  it("removes its own record when Vite closes", () => {
    const root = tempRoot();
    const server = fakeServer(root, 45_124);
    runPlugin(server);
    server.httpServer.emit("listening");

    server.httpServer.emit("close");

    expect(existsSync(path.join(root, DEV_SERVER_OWNER_FILE))).toBe(false);
  });

  it("keeps a record that another Vite wrote after this one", () => {
    const root = tempRoot();
    const server = fakeServer(root, 45_125);
    runPlugin(server);
    server.httpServer.emit("listening");
    writeDevServerOwner(root, {
      pid: process.pid + 1,
      port: 45_126,
      startedAtMs: 1,
      recordedAtMs: 2,
    });

    server.httpServer.emit("close");

    const record = JSON.parse(readFileSync(path.join(root, DEV_SERVER_OWNER_FILE), "utf8"));
    expect(record.pid).toBe(process.pid + 1);
  });
});
