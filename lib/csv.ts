// Export CSV lisible directement par Excel en français (Québec) :
// séparateur « ; », virgule décimale, encodage UTF-8 avec BOM (accents corrects).

function cellule(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 14237 → « 142,37 » (sans symbole, pour qu'Excel le lise comme un nombre) */
export function montantCsv(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function genererCsv(entetes: string[], lignes: unknown[][]): Blob {
  const texte = [entetes, ...lignes].map((l) => l.map(cellule).join(";")).join("\r\n");
  return new Blob(["﻿" + texte], { type: "text/csv;charset=utf-8" });
}

export function telechargerFichier(blob: Blob, nom: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
