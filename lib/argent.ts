// Montants : toujours manipulés en cents (entiers) pour éviter les erreurs d'arrondi.

export const TAUX_TPS = 0.05;
export const TAUX_TVQ = 0.09975;

/** « 142,37 », « 142.37 », « 1 142,37 $ » → 14237. Retourne null si invalide. */
export function versCents(saisie: string): number | null {
  const propre = saisie.replace(/[\s$ ]/g, "").replace(",", ".");
  if (propre === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(propre)) return null;
  return Math.round(parseFloat(propre) * 100);
}

/** 14237 → « 142,37 $ » */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("fr-CA", { style: "currency", currency: "CAD" });
}

/** 14237 → « 142,37 » (pour remplir un champ de saisie) */
export function centsVersSaisie(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** Décompose un total taxes incluses en sous-total, TPS et TVQ (Québec). */
export function decomposerTaxes(totalCents: number) {
  const sousTotal = Math.round(totalCents / (1 + TAUX_TPS + TAUX_TVQ));
  const tps = Math.round(sousTotal * TAUX_TPS);
  const tvq = totalCents - sousTotal - tps; // l'arrondi restant va à la TVQ
  return { sousTotal, tps, tvq };
}
