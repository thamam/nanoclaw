// Local command execution — child_process wrapper used by the `self` scope
// of the bash tool. Output is capped at 256KB per stream; timeout is capped
// at 300s server-side (default 60s).

import { spawn } from 'node:child_process';

export interface LocalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface LocalExecOptions {
  /** Seconds, default 60, max 300. */
  timeout?: number;
}

export const LOCAL_EXEC_MAX_TIMEOUT = 300;
export const LOCAL_EXEC_DEFAULT_TIMEOUT = 60;
export const LOCAL_EXEC_MAX_OUTPUT = 256 * 1024; // 256KB per stream

/**
 * Execute a shell command locally via `bash -c`. Captures stdout/stderr with
 * a hard cap, enforces a timeout that SIGKILLs the child, and returns a result
 * with the same shape as SshResult (stdout/stderr/exitCode; 124 on timeout).
 */
export function localExec(
  command: string,
  options: LocalExecOptions = {},
): Promise<LocalExecResult> {
  const requested = options.timeout ?? LOCAL_EXEC_DEFAULT_TIMEOUT;
  const timeoutSec = Math.min(Math.max(1, requested), LOCAL_EXEC_MAX_TIMEOUT);

  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let timedOut = false;
    let settled = false;

    const append = (existing: string, chunk: string, cap: number): [string, boolean] => {
      if (existing.length >= cap) return [existing, true];
      const remaining = cap - existing.length;
      if (chunk.length <= remaining) return [existing + chunk, false];
      return [existing + chunk.slice(0, remaining), true];
    };

    proc.stdout.on('data', (buf: Buffer) => {
      const [next, trunc] = append(stdout, buf.toString('utf8'), LOCAL_EXEC_MAX_OUTPUT);
      stdout = next;
      if (trunc) stdoutTrunc = true;
    });
    proc.stderr.on('data', (buf: Buffer) => {
      const [next, trunc] = append(stderr, buf.toString('utf8'), LOCAL_EXEC_MAX_OUTPUT);
      stderr = next;
      if (trunc) stderrTrunc = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore — process may already be gone
      }
    }, timeoutSec * 1000);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutTrunc) stdout += `\n[truncated at ${LOCAL_EXEC_MAX_OUTPUT} bytes]`;
      if (stderrTrunc) stderr += `\n[truncated at ${LOCAL_EXEC_MAX_OUTPUT} bytes]`;
      if (timedOut) {
        resolve({
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + `Command timed out after ${timeoutSec}s.`,
          exitCode: 124,
        });
      } else {
        resolve({ stdout, stderr, exitCode });
      }
    };

    proc.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(1);
    });
    proc.on('close', (code, signal) => {
      finish(code === null ? (signal === 'SIGKILL' ? 137 : 1) : code);
    });
  });
}
