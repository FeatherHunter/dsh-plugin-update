/**
 * T0 spike 的进程底座（throwaway —— 思路抄自 dsh-prompt scripts/real/harness/proc.mjs）。
 * T1 会把它并进正式 harness；本文件只为把「起宿主 / 起浏览器 / 杀进程树 / 等端口」跑通。
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

export const IS_WIN = process.platform === 'win32';

export function quoteShellArg(arg: unknown): string {
  const s = String(arg);
  if (IS_WIN) {
    if (s === '') return '""';
    return /[\s"&|<>^()%!]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  return /[^\w@%+=:,./-]/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s;
}

export function buildCommandLine(command: string, args: string[] = []): string {
  return [command, ...args].map(quoteShellArg).join(' ');
}

function shellInvocation(line: string): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (IS_WIN) {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + line + '"'],
      windowsVerbatimArguments: true,
    };
  }
  return { file: '/bin/sh', args: ['-c', line], windowsVerbatimArguments: false };
}

export function runCommand(command: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}) {
  const line = buildCommandLine(command, args);
  const inv = shellInvocation(line);
  const startedAt = Date.now();
  const res = spawnSync(inv.file, inv.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
    stdio: 'pipe',
  });
  const timedOut = res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM';
  return {
    commandLine: line,
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    timedOut,
    error: res.error ? String(res.error.message ?? res.error) : null,
    ms: Date.now() - startedAt,
  };
}

export function startLongRunning(command: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string | undefined>; stdio?: any } = {}) {
  const line = buildCommandLine(command, args);
  const inv = shellInvocation(line);
  return spawn(inv.file, inv.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN,
  });
}

export function killTree(pid: number | null | undefined): void {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function waitForExit(child: any, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    let done = false;
    const finish = (exited) => { if (done) return; done = true; clearTimeout(timer); resolve(exited); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', () => finish(true));
  });
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => { socket.removeAllListeners(); socket.destroy(); resolve(free); };
    socket.setTimeout(500);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

export async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

export function findPortOwner(port: number): number | null {
  if (IS_WIN) {
    const r = runCommand('powershell.exe', ['-NoProfile', '-Command',
      '(Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess'], { timeoutMs: 30_000 });
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const lsof = runCommand('lsof', ['-ti', 'tcp:' + Number(port), '-sTCP:LISTEN'], { timeoutMs: 30_000 });
  const n = Number((lsof.stdout.split(/\r?\n/)[0] ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function redactUrl(text: unknown): string {
  return String(text ?? '').replace(/([?&]token=)[^\s"'&]+/g, '$1***');
}

export function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
