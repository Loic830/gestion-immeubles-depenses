// Dates manipulées comme chaînes AAAA-MM-JJ (pas de décalage de fuseau horaire).

export function aujourdhuiIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function versIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Fin d'un bail de n mois : 2026-07-01 + 12 mois → 2027-06-30 */
export function finApresMois(debut: string, mois: number): string {
  const [a, m, j] = debut.split("-").map(Number);
  return versIso(new Date(a, m - 1 + mois, j - 1));
}

/** Prochain 1er juillet (date de début la plus courante au Québec) */
export function prochainPremierJuillet(): string {
  const d = new Date();
  const annee = d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear();
  return `${annee}-07-01`;
}

/** « 2027-06-30 » → « 30 juin 2027 » */
export function dateLisible(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [a, m, j] = iso.split("-").map(Number);
  return new Date(a, m - 1, j).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
}

/** « 2026-10-01 » → « octobre 2026 » */
export function moisLisible(iso: string): string {
  const [a, m] = iso.split("-").map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
}

/** Tri naturel des numéros de logement : 2 < 10 < 680 */
export function triNumero(a: string, b: string): number {
  return a.localeCompare(b, "fr-CA", { numeric: true });
}

/** Lendemain : « 2027-01-15 » → « 2027-01-16 » */
export function lendemain(iso: string): string {
  const [a, m, j] = iso.split("-").map(Number);
  return versIso(new Date(a, m - 1, j + 1));
}

/** Dernier jour du mois : « 2026-10-16 » → « 2026-10-31 » */
export function finDuMois(iso: string): string {
  const [a, m] = iso.split("-").map(Number);
  return versIso(new Date(a, m, 0));
}
