// Ventilation capital / intérêts d'un prêt hypothécaire à taux fixe (Canada).
// Loi sur l'intérêt : un prêt à taux fixe est composé deux fois par année.
// Taux par versement mensuel : i = (1 + r/2)^(2/12) − 1 (r = taux annuel, ex. 0,0479).
// Chaque versement : intérêts = solde × i (arrondi au cent), capital = versement − intérêts.
// Rien n'est stocké : tout se recalcule à partir du prêt (un taux corrigé met tout à jour).
// v0.9.18 : si le tableau d'amortissement du prêteur est entré (table hypotheque_versements),
// ses lignes sont reprises telles quelles (la banque compte l'intérêt au nombre de jours) ;
// les versements après sa dernière ligne sont recalculés à partir du dernier solde.

import { ajouterMois } from "./dates";

export type Pret = {
  solde_debut_terme_cents: number;
  taux: number | string;          // en %, ex. 4.79 (Supabase renvoie parfois un numeric en texte)
  premier_versement: string;      // AAAA-MM-JJ
  fin_terme: string;              // AAAA-MM-JJ
  versement_cents: number;
  tableau_preteur?: Versement[];  // lignes du tableau du prêteur, s'il est entré
};

export type Versement = {
  no: number;
  date: string;
  interets: number;               // cents
  capital: number;                // cents
  solde: number;                  // solde après le versement, cents
  preteur?: boolean;              // ligne reprise du tableau du prêteur (v0.9.18)
};

export type ResumeAnnee = {
  interets: number;
  capital: number;
  soldeDebut: number;             // solde au 1er janvier (ou au début du terme)
  soldeFin: number;               // solde au 31 décembre (ou à la fin du terme)
  nbVersements: number;
};

/** Taux effectif par versement mensuel, composé semestriellement. */
export function tauxMensuel(tauxPct: number): number {
  return Math.pow(1 + tauxPct / 100 / 2, 1 / 6) - 1;
}

/** Versement mensuel qui rembourse le solde en n mois (pour vérifier le chiffre du prêteur). */
export function versementTheorique(soldeCents: number, tauxPct: number, mois: number): number {
  if (mois <= 0) return 0;
  const i = tauxMensuel(tauxPct);
  if (i === 0) return Math.round(soldeCents / mois);
  return Math.round((soldeCents * i) / (1 - Math.pow(1 + i, -mois)));
}

/** Tableau des versements du terme : du premier versement jusqu'à la fin du terme (incluse). */
export function tableauVersements(p: Pret): Versement[] {
  const i = tauxMensuel(Number(p.taux));
  const lignes: Versement[] = (p.tableau_preteur ?? [])
    .filter((v) => v.date <= p.fin_terme)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((v, k) => ({ ...v, no: k + 1, preteur: true }));
  let solde = lignes.length ? lignes[lignes.length - 1].solde : p.solde_debut_terme_cents;
  for (let k = lignes.length; k < 600 && solde > 0; k++) {
    const date = ajouterMois(p.premier_versement, k);
    if (date > p.fin_terme) break;
    const interets = Math.round(solde * i);
    // Le dernier versement ne rembourse que ce qui reste.
    const capital = Math.min(Math.max(p.versement_cents - interets, 0), solde);
    solde -= capital;
    lignes.push({ no: k + 1, date, interets, capital, solde });
  }
  return lignes;
}

/** Totaux d'une année civile (versements datés dans l'année). */
export function resumeAnnee(p: Pret, annee: number, tableau = tableauVersements(p)): ResumeAnnee {
  const debut = `${annee}-01-01`;
  const fin = `${annee}-12-31`;
  let soldeDebut = p.solde_debut_terme_cents;
  let soldeFin = p.solde_debut_terme_cents;
  let interets = 0;
  let capital = 0;
  let nb = 0;
  for (const v of tableau) {
    if (v.date < debut) {
      soldeDebut = v.solde;
      soldeFin = v.solde;
    } else if (v.date <= fin) {
      interets += v.interets;
      capital += v.capital;
      soldeFin = v.solde;
      nb++;
    }
  }
  return { interets, capital, soldeDebut, soldeFin, nbVersements: nb };
}

/** Le versement ne couvre même pas les intérêts du premier mois (saisie probablement erronée). */
export function versementInsuffisant(p: Pret): boolean {
  return Math.round(p.solde_debut_terme_cents * tauxMensuel(Number(p.taux))) >= p.versement_cents;
}

/** Écart relatif entre le calcul et le relevé du prêteur (0,012 = 1,2 %). */
export function ecartReleve(calculCents: number, releveCents: number): number {
  if (releveCents === 0) return calculCents === 0 ? 0 : 1;
  return Math.abs(calculCents - releveCents) / releveCents;
}

/** Au-delà de 1 % d'écart, l'app avertit ; le relevé du prêteur a toujours priorité. */
export const SEUIL_ECART_RELEVE = 0.01;
