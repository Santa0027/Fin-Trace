function cell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Quote everything, and neutralise cells a spreadsheet would run as a formula.
  return `"${(/^[=+\-@]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

/** Save rows as a CSV file. Values are written exactly as given (amounts stay as the backend's decimal strings). */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
