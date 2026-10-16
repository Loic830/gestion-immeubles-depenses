// Répartition d'un montant (en cents) entre plusieurs lignes, sans perdre un seul cent.
// Méthode du plus fort reste : chaque part est arrondie vers le bas, puis les cents
// restants vont aux lignes qui avaient la plus grande partie décimale.

export function repartirSelonPoids(totalCents: number, poids: number[]): number[] {
  const somme = poids.reduce((s, p) => s + p, 0);
  if (poids.length === 0) return [];
  if (somme <= 0) return repartirSelonPoids(totalCents, poids.map(() => 1));

  const exactes = poids.map((p) => (totalCents * p) / somme);
  const parts = exactes.map(Math.floor);
  let reste = totalCents - parts.reduce((s, p) => s + p, 0);

  const ordre = exactes
    .map((x, i) => ({ i, decimale: x - Math.floor(x) }))
    .sort((a, b) => b.decimale - a.decimale || a.i - b.i);
  for (let k = 0; reste > 0; k = (k + 1) % ordre.length, reste--) {
    parts[ordre[k].i] += 1;
  }
  return parts;
}

export function repartirEgalement(totalCents: number, nbLignes: number): number[] {
  return repartirSelonPoids(totalCents, Array.from({ length: nbLignes }, () => 1));
}
