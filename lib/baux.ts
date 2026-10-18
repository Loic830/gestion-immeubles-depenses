// Période de l'onglet Baux : une ou plusieurs années (année courante à année courante − 6).
// Un bail fait partie de la période s'il couvre au moins un jour d'une année choisie.
// Les baux à venir (déjà signés) suivent l'année courante.

export const NB_ANNEES = 7;

export type BailPeriode = {
  statut: "a_venir" | "actif" | "termine";
  date_debut: string;
  date_fin: string | null;
  date_depart: string | null;
};

/** Années proposées : 2026, 2025, … 2020 */
export function anneesProposees(): number[] {
  const a = new Date().getFullYear();
  return Array.from({ length: NB_ANNEES }, (_, i) => a - i);
}

/** « 2024,2026 » (adresse) → [2026, 2024] ; vide ou invalide → année courante */
export function lireAnnees(texte: string | null): number[] {
  const permises = anneesProposees();
  const liste = (texte ?? "").split(",").map(Number).filter((n) => permises.includes(n));
  return liste.length ? Array.from(new Set(liste)).sort((x, y) => y - x) : [permises[0]];
}

/** Dernier jour réel du bail (départ, sinon fin) ; null = durée indéterminée */
export function finReelle(b: BailPeriode): string | null {
  return b.date_depart ?? b.date_fin;
}

export function bailDansAnnees(b: BailPeriode, annees: number[]): boolean {
  const courante = new Date().getFullYear();
  if (b.statut === "a_venir" && annees.includes(courante)) return true;
  const fin = finReelle(b) ?? "9999-12-31";
  return annees.some((a) => b.date_debut <= `${a}-12-31` && fin >= `${a}-01-01`);
}

/** Années consécutives regroupées : [2026, 2025, 2024] → « 2024 à 2026 » ; [2026, 2023] → « 2023 et 2026 » */
export function libellePeriode(annees: number[]): string {
  const t = [...annees].sort((x, y) => x - y);
  if (t.length === 1) return String(t[0]);
  const suivies = t.every((a, i) => i === 0 || a === t[i - 1] + 1);
  if (suivies) return `${t[0]} à ${t[t.length - 1]}`;
  return `${t.slice(0, -1).join(", ")} et ${t[t.length - 1]}`;
}

/** Pour un nom de fichier : « 2024-2026 » ou « 2023_2026 » */
export function periodeFichier(annees: number[]): string {
  const t = [...annees].sort((x, y) => x - y);
  const suivies = t.every((a, i) => i === 0 || a === t[i - 1] + 1);
  return t.length === 1 ? String(t[0]) : suivies ? `${t[0]}-${t[t.length - 1]}` : t.join("_");
}

/** Le mois (AAAA-MM-01) fait-il partie d'une année choisie ? */
export function moisDansAnnees(mois: string, annees: number[]): boolean {
  return annees.includes(Number(mois.slice(0, 4)));
}
