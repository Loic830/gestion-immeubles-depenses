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

// État d'un bail pour le filtre et les pastilles de l'onglet Baux (v0.9.3).
// « Actif » couvre tous les baux en cours ; renouvelé, départ et relocation précisent un bail en cours.
export type EtatBail = "actif" | "a_venir" | "renouvele" | "depart" | "relocation" | "termine";

export const ETATS: { code: EtatBail; libelle: string }[] = [
  { code: "actif", libelle: "Actifs" },
  { code: "a_venir", libelle: "À venir" },
  { code: "renouvele", libelle: "Renouvelés" },
  { code: "depart", libelle: "Départ prévu" },
  { code: "relocation", libelle: "Relocation faite" },
  { code: "termine", libelle: "Terminés" },
];

/** États d'un bail : un bail en cours a « actif » plus, au besoin, renouvelé / départ / relocation.
 *  aVenirApres = un bail à venir existe sur le même logement. */
export function etatsBail(b: BailPeriode, aVenirApres: boolean): EtatBail[] {
  if (b.statut !== "actif") return [b.statut];
  if (b.date_depart) return ["actif", aVenirApres ? "relocation" : "depart"];
  return aVenirApres ? ["actif", "renouvele"] : ["actif"];
}

/** « actif,termine » (adresse) → états connus seulement */
export function lireEtats(texte: string | null): EtatBail[] {
  const codes = ETATS.map((e) => e.code);
  return (texte ?? "").split(",").filter((x): x is EtatBail => (codes as string[]).includes(x));
}

// Type de bail (v0.9.5) : un renouvellement ou une cession suit le bail précédent (bail_precedent_id).
// Le dossier prêteur remonte cette chaîne pour joindre le bail d'origine signé et chaque suite.
export type OrigineBail = "nouveau" | "renouvellement" | "cession";

export const LIBELLE_ORIGINE: Record<OrigineBail, string> = {
  nouveau: "Nouveau bail",
  renouvellement: "Renouvellement",
  cession: "Cession",
};

/** Titre des photos « bail » sur la fiche, selon le type */
export const TITRE_COPIE: Record<OrigineBail, { titre: string; aide: string }> = {
  nouveau: { titre: "Bail signé", aide: "Photo ou PDF du bail, pour le dossier du prêteur et les renouvellements." },
  renouvellement: {
    titre: "Renouvellement signé",
    aide: "Photo de l'avis de renouvellement (ou du nouveau bail) signé. Le dossier du prêteur joint aussi le bail d'origine.",
  },
  cession: {
    titre: "Entente de cession",
    aide: "Photo de l'entente de cession signée. Le dossier du prêteur joint aussi le bail d'origine et ses renouvellements.",
  },
};

export type MaillonBail = { id: string; bail_precedent_id: string | null; origine: OrigineBail };

/** Chaîne d'un bail, du bail d'origine jusqu'à lui : on remonte tant que le bail est un renouvellement ou une cession. */
export function chaineDe<T extends MaillonBail>(bail: T, tous: T[]): T[] {
  const chaine = [bail];
  const vus = new Set([bail.id]);
  let courant = bail;
  while ((courant.origine ?? "nouveau") !== "nouveau" && courant.bail_precedent_id && !vus.has(courant.bail_precedent_id)) {
    const precedent = tous.find((b) => b.id === courant.bail_precedent_id);
    if (!precedent) break;
    chaine.unshift(precedent);
    vus.add(precedent.id);
    courant = precedent;
  }
  return chaine;
}
