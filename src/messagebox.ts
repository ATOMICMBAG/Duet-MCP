/**
 * The message box of the firmware (state.messageBox): M291 shows one, M292 acknowledges it. A filament change (M600 -> filament-change.g)
 * usually waits for an OK in such a box. Pure helpers, no I/O.
 *
 * Modes (M291 S): 0 message only, 1 with a close button, 2 waits for OK, 3 waits for OK or Cancel, 4 multiple choice, 5 integer, 6 float, 7 text.
 */
export interface MessageBox {
  mode: number;
  title: string;
  message: string;
  timeout: number; // seconds, 0 = none
}

export function parseMessageBox(raw: unknown): MessageBox | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const message = typeof r.message === "string" ? r.message : "";
  const title = typeof r.title === "string" ? r.title : "";
  if (!message && !title) return undefined;
  return { mode: typeof r.mode === "number" ? r.mode : 0, title, message, timeout: typeof r.timeout === "number" ? r.timeout : 0 };
}

/** The firmware (and a running job or macro) waits for an answer. */
export const waitsForAnswer = (m: MessageBox) => m.mode >= 2;
/** The server can answer it with M292 (OK, or Cancel in mode 3). Modes 4-7 need a value and are left to the human. */
export const canAcknowledge = (m: MessageBox) => m.mode >= 1 && m.mode <= 3;
export const isFilamentRelated = (m: MessageBox) => /filament|spool|load|unload|runout/i.test(`${m.title} ${m.message}`);

export const messageKey = (m: MessageBox) => `${m.mode}|${m.title}|${m.message}`;

export function describeMessageBox(m: MessageBox): string {
  const kind = m.mode === 0 ? "message only" : m.mode === 1 ? "close button" : m.mode === 2 ? "waits for OK" : m.mode === 3 ? "waits for OK or Cancel" : "waits for a value (cannot be answered here)";
  return `${m.title ? `"${m.title}": ` : ""}${m.message} [${kind}${m.timeout ? `, timeout ${m.timeout} s` : ""}]`;
}
