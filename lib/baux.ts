// Période de l'onglet Baux : une ou plusieurs années, de l'année du plus vieux bail à l'année courante (v0.9.11).
// Un bail fait partie de la période s'il couvre au moins un jour d'une année choisie.
// Les baux à venir (déjà signés) suivent l'année courante.
// Dans l'adresse : ?a=tout (toutes les années), ?a=2016-2026 (plage), ?a=1998,2010-2012 (mélange).

export type BailPeriode = {
  statut: "a_venir" | "actif" | "termine";
  date_debut: string;
  date_fin: string | null;
  date_depart: string | null;
};

const PLUS_VIEILLE_ANNEE = 1900;

export function anneeCourante(): number {
  return new Date().getFullYear();
}

/** Années proposées : de l'année courante jusqu'à l'année du plus vieux bail (ex. 2026, 2025, … 1996) */
export function anneesDisponibles(baux: { date_debut: string }[]): number[] {
  const a = anneeCourante();
  const premiere = baux.reduce((min, b) => Math.min(min, Number(b.date_debut.slice(0, 4)) || a), a);
  const debut = Math.max(PLUS_VIEILLE_ANNEE, premiere);
  return Array.from({ length: a - debut + 1 }, (_, i) => a - i);
}

/** « 2024,2026 », « 2016-2026 » ou « tout » (adresse) → [2026, 2024] ; vide ou invalide → année courante */
export function lireAnnees(texte: string | null, disponibles: number[]): number[] {
  if (texte === "tout") return disponibles;
  const max = anneeCourante();
  const liste: number[] = [];
  for (const morceau of (texte ?? "").split(",")) {
    const [x, y] = morceau.split("-").map(Number);
    const de = Math.max(PLUS_VIEILLE_ANNEE, Math.min(x, y || x));
    const a = Math.min(max, Math.max(x, y || x));
    if (!Number.isInteger(de) || !Number.isInteger(a)) continue;
    for (let n = de; n <= a; n++) liste.push(n);
  }
  return liste.length ? Array.from(new Set(liste)).sort((p, q) => q - p) : [max];
}

/** Années consécutives regroupées : [1998, 1999, 2000, 2010] → [[1998, 2000], [2010, 2010]] */
function plages(annees: number[]): [number, number][] {
  const t = Array.from(new Set(annees)).sort((x, y) => x - y);
  const r: [number, number][] = [];
  for (const a of t) {
    const der = r[r.length - 1];
    if (der && a === der[1] + 1) der[1] = a;
    else r.push([a, a]);
  }
  return r;
}

/** Pour l'adresse : « tout » si toutes les années proposées, sinon « 1998-2000,2010 » ; null = année courante seule */
export function ecrireAnnees(annees: number[], disponibles: number[]): string | null {
  if (annees.length === 1 && annees[0] === anneeCourante()) return null;
  if (disponibles.length > 1 && disponibles.every((a) => annees.includes(a))) return "tout";
  return plages(annees).map(([de, a]) => (de === a ? String(de) : `${de}-${a}`)).join(",");
}

/** Années consécutives regroupées : [2026, 2025, 2024] → « 2024 à 2026 » ; [2026, 2023] → « 2023 et 2026 » ;
 *  [1998, 1999, 2000, 2005, 2010…2026] → « 1998 à 2000, 2005 et 2010 à 2026 » */
export function libellePeriode(annees: number[]): string {
  const morceaux = plages(annees).map(([de, a]) => (de === a ? String(de) : `${de} à ${a}`));
  if (morceaux.length <= 1) return morceaux[0] ?? "";
  return `${morceaux.slice(0, -1).join(", ")} et ${morceaux[morceaux.length - 1]}`;
}

/** Dernier jour réel du bail (départ, sinon fin) ; null = durée indéterminée */
export function finReelle(b: BailPeriode): string | null {
  return b.date_depart ?? b.date_fin;
}

export function bailDansAnnees(b: BailPeriode, annees: number[]): boolean {
  if (b.statut === "a_venir" && annees.includes(anneeCourante())) return true;
  const fin = finReelle(b) ?? "9999-12-31";
  return annees.some((a) => b.date_debut <= `${a}-12-31` && fin >= `${a}-01-01`);
}

/** Pour un nom de fichier : « 2024-2026 » ou « 1998-2000_2010 » */
export function periodeFichier(annees: number[]): string {
  return plages(annees).map(([de, a]) => (de === a ? String(de) : `${de}-${a}`)).join("_");
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
