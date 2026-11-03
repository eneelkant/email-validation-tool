/**
 * Mitigate CSV formula injection when opening results in spreadsheet apps.
 */
export function sanitizeCsvCell(value: string): string {
  if (value === '') return value;
  const first = value[0];
  if (first && '=@+-'.includes(first)) {
    return `'${value}`;
  }
  return value;
}
