/**
 * RFC 4180 cell encoding plus spreadsheet formula-injection protection: cells
 * starting with = + - @ (or tab/CR) are executed by Excel/Sheets, and some of
 * our cells hold user-controlled text (buyer email, invoice metadata).
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";
