// Small CSV reader for the indicator import.
// It understands quoted commas and quotes inside quotes. Extra columns are kept
// on the record so the importer can ignore them.

export function parseCsv(text: string): { headers: string[]; records: Record<string, string>[] } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = parseRows(source).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) throw new Error("The CSV file is empty.");

  const headers = rows[0].map((header) => header.trim());
  if (headers.some((header) => header.length === 0)) {
    throw new Error("The CSV header has an empty column name.");
  }

  const records: Record<string, string>[] = [];
  for (const cells of rows.slice(1)) {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!(header in record)) record[header] = (cells[index] ?? "").trim();
    });
    records.push(record);
  }
  return { headers, records };
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }

  if (inQuotes) throw new Error("The CSV has a quoted value that never closes.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
