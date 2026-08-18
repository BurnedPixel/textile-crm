// Pure display formatting for periodKey strings ('YYYY-Www' | 'YYYY-MM') — split
// out of the island so it has a vitest home like every other pure helper here.

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

/** 'Semana 2026-W34' for a weekly periodKey; 'Agosto 2026' for a monthly one. */
export function periodLabel(periodKey: string): string {
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (monthMatch) {
    const month = MONTH_NAMES[Number(monthMatch[2]) - 1];
    return month ? `${month} ${monthMatch[1]}` : periodKey;
  }
  if (/^\d{4}-W\d{2}$/.test(periodKey)) return `Semana ${periodKey}`;
  return periodKey;
}
