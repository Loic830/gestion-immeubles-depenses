// Frais fixes (v0.8.6) : types et calculs de la page (hypothèques, assurances, taxes).
// Les intérêts viennent de lib/amortissement.ts ; le relevé du prêteur a priorité.

import { resumeAnnee, tableauVersements, type ResumeAnnee, type Versement } from "./amortissement";
import { aujourdhuiIso } from "./dates";

export type ImmeubleFF = { id: string; nom: string; actif: boolean };

export type Hypotheque = {
  id: string;
  immeuble_id: string;
  nom_pret: string;
  preteur: string | null;
  no_pret: string | null;
  solde_debut_terme_cents: number;
  taux: number;
  debut_terme: string;
  fin_terme: string;
  premier_versement: string;
  amortissement_mois: number | null;
  versement_cents: number;
  notes: string | null;
  tableau_preteur?: Versement[];  // v0.9.18 : tableau d'amortissement du prêteur (hypotheque_versements)
};

/** Ligne de la table hypotheque_versements (v0.9.18). */
export type LigneTableauPreteur = {
  hypotheque_id: string;
  no: number;
  date_versement: string;
  interets_cents: number;
  capital_cents: number;
  solde_cents: number;
};

/** Range les lignes du tableau du prêteur sur chaque prêt. */
export function avecTableauPreteur(hypotheques: Hypotheque[], lignes: LigneTableauPreteur[]): Hypotheque[] {
  return hypotheques.map((h) => {
    const t = lignes.filter((l) => l.hypotheque_id === h.id).map((l) => ({
      no: l.no, date: l.date_versement, interets: Number(l.interets_cents), capital: Number(l.capital_cents), solde: Number(l.solde_cents),
    }));
    return t.length ? { ...h, tableau_preteur: t } : h;
  });
}

export type Releve = {
  id: string;
  hypotheque_id: string;
  annee: number;
  interets_releve_cents: number;
  solde_fin_cents: number | null;
};

export type Assurance = {
  id: string;
  immeuble_id: string;
  assureur: string;
  no_police: string | null;
  prime_annuelle_cents: number;
  date_debut: string;
  date_renouvellement: string;
  mode_paiement: "annuel" | "mensuel";
  document_id: string | null;
  date_paiement: string | null;
  depense_id: string | null;
  notes: string | null;
};

export type TypeTaxe = "fonciere" | "scolaire";

export type TaxeVersement = {
  id: string;
  immeuble_id: string;
  type: TypeTaxe;
  annee: number;
  echeance: string;
  montant_cents: number;
  date_paiement: string | null;
  depense_id: string | null;
  notes: string | null;
};

export const LIBELLE_TAXE: Record<TypeTaxe, string> = { fonciere: "Taxes foncières", scolaire: "Taxes scolaires" };

/** Fournisseur proposé pour la dépense d'un versement de taxes. */
export const FOURNISSEUR_TAXE: Record<TypeTaxe, string> = { fonciere: "Ville d'Alma", scolaire: "Taxe scolaire" };

/** Un prêt compte pour l'année si son terme la touche (versements datés dans l'année). */
export function pretDansAnnee(h: Hypotheque, annee: number): boolean {
  return h.premier_versement <= `${annee}-12-31` && h.fin_terme >= `${annee}-01-01`;
}

/** Une police compte pour l'année si son terme commence dans l'année ou la chevauche. */
export function assuranceDansAnnee(a: Assurance, annee: number): boolean {
  return a.date_debut <= `${annee}-12-31` && a.date_renouvellement > `${annee}-01-01`;
}

export type InteretsAnnee = ResumeAnnee & {
  releve: Releve | null;
  retenus: number;            // intérêts à déclarer : relevé s'il existe, sinon le calcul
};

export function interetsAnnee(h: Hypotheque, annee: number, releves: Releve[]): InteretsAnnee {
  const r = resumeAnnee(h, annee, tableauVersements(h));
  const releve = releves.find((x) => x.hypotheque_id === h.id && x.annee === annee) ?? null;
  return { ...r, releve, retenus: releve ? releve.interets_releve_cents : r.interets };
}

export type StatutVersement = "paye" | "retard" | "a_payer";

export function statutVersement(datePaiement: string | null, echeance: string, aujourdhui = aujourdhuiIso()): StatutVersement {
  if (datePaiement) return "paye";
  return echeance < aujourdhui ? "retard" : "a_payer";
}

export type TotauxImmeuble = { interets: number; assurances: number; taxes: number; total: number };

/**
 * Total des frais fixes de l'année pour un immeuble :
 * intérêts retenus de tous ses prêts + primes des polices qui commencent dans l'année
 * + versements de taxes de l'année (payés ou non).
 */
export function totauxImmeuble(
  immeubleId: string, annee: number,
  hypotheques: Hypotheque[], releves: Releve[], assurances: Assurance[], taxes: TaxeVersement[],
): TotauxImmeuble {
  const interets = hypotheques
    .filter((h) => h.immeuble_id === immeubleId && pretDansAnnee(h, annee))
    .reduce((s, h) => s + interetsAnnee(h, annee, releves).retenus, 0);
  const primes = assurances
    .filter((a) => a.immeuble_id === immeubleId && a.date_debut.startsWith(String(annee)))
    .reduce((s, a) => s + a.prime_annuelle_cents, 0);
  const tx = taxes
    .filter((t) => t.immeuble_id === immeubleId && t.annee === annee)
    .reduce((s, t) => s + t.montant_cents, 0);
  return { interets, assurances: primes, taxes: tx, total: interets + primes + tx };
}

/** « 4,79 » → 4.79 ; null si invalide. */
export function versTaux(saisie: string): number | null {
  const propre = saisie.replace(/[\s%]/g, "").replace(",", ".");
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(propre)) return null;
  return parseFloat(propre);
}

/** 4.79 → « 4,79 % » */
export function formatTaux(taux: number | string): string {
  return `${Number(taux).toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} %`;
}
