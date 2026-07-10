/**
 * Alt-screen ANSI lifecycle + full-frame repaint. Each frame: cursor home,
 * write lines, clear-to-EOL per line, clear below. No scrollback pollution,
 * no flicker at 1 Hz.
 */

const CSI = '\x1b[';

export class Screen {
  private active = false;

  enter(): void {
    if (this.active || !process.stdout.isTTY) return;
    process.stdout.write(`${CSI}?1049h${CSI}?25l`); // alt screen, hide cursor
    this.active = true;
  }

  leave(): void {
    if (!this.active) return;
    process.stdout.write(`${CSI}?25h${CSI}?1049l`); // show cursor, main screen
    this.active = false;
  }

  /** Paint a full frame. Lines are truncated to terminal width upstream. */
  paint(lines: string[]): void {
    const rows = process.stdout.rows || 40;
    const frame = lines.slice(0, rows);
    const buf = `${CSI}H${frame.map((l) => `${l}${CSI}K`).join('\n')}\n${CSI}J`;
    process.stdout.write(buf);
  }

  width(): number {
    return process.stdout.columns || 120;
  }
}

/** Visible length ignoring ANSI SGR sequences. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Truncate to visible width, appending ellipsis + SGR reset. */
export function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < width - 1) {
    // eslint-disable-next-line no-control-regex
    const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (m && m[0]) {
      out += m[0];
      i += m[0].length;
    } else {
      out += s[i];
      visible++;
      i++;
    }
  }
  return `${out}…${CSI}0m`;
}

/** Pad string to visible width (right-pad default). */
export function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const len = visibleLength(s);
  if (len >= width) return s;
  const fill = ' '.repeat(width - len);
  return align === 'left' ? s + fill : fill + s;
}

export const fmt = {
  dim: (s: string) => `${CSI}2m${s}${CSI}0m`,
  bold: (s: string) => `${CSI}1m${s}${CSI}0m`,
  green: (s: string) => `${CSI}32m${s}${CSI}0m`,
  red: (s: string) => `${CSI}31m${s}${CSI}0m`,
  yellow: (s: string) => `${CSI}33m${s}${CSI}0m`,
  cyan: (s: string) => `${CSI}36m${s}${CSI}0m`,
};
