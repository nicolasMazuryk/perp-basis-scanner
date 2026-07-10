import { createWriteStream, type WriteStream } from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Minimal structured JSON logger. Writes to a file (never stdout — stdout
 * belongs to the TUI). One line per event.
 */
class Logger {
  private stream: WriteStream | undefined;

  init(path: string): void {
    this.stream = createWriteStream(path, { flags: 'a' });
    this.stream.on('error', () => {
      this.stream = undefined; // logging must never crash the scanner
    });
  }

  private write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (!this.stream) return;
    this.stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  close(): void {
    this.stream?.end();
    this.stream = undefined;
  }
}

export const log = new Logger();
