import { ajouterMois, aujourdhuiIso } from "./dates";

// Entretien (v0.9.16) : équipements d'un immeuble (parties communes) ou d'un logement,
// date de remplacement prévue et entretien périodique. Les alertes sont calculées dans
// alertes_du_jour() (supabase/024_entretien.sql) : garder les mêmes libellés que libelle_equipement().

export type TypeEquipement = { code: string; nom: string; dureeVie: number | null; entretien?: { mois: number; quoi: string } };

/** Durées de vie moyennes (ans), à ajuster selon l'équipement. */
export const TYPES_EQUIPEMENT: TypeEquipement[] = [
  { code: "chauffe_eau", nom: "Chauffe-eau", dureeVie: 10, entretien: { mois: 12, quoi: "Vidanger" } },
  { code: "fournaise", nom: "Fournaise", dureeVie: 20, entretien: { mois: 12, quoi: "Inspection et filtre" } },
  { code: "thermopompe", nom: "Thermopompe", dureeVie: 15, entretien: { mois: 12, quoi: "Nettoyage et filtres" } },
  { code: "climatiseur", nom: "Climatiseur", dureeVie: 12 },
  { code: "plinthes", nom: "Plinthes électriques", dureeVie: 25 },
  { code: "echangeur_air", nom: "Échangeur d'air", dureeVie: 15, entretien: { mois: 6, quoi: "Nettoyer les filtres" } },
  { code: "toiture", nom: "Toiture", dureeVie: 20 },
  { code: "fenetres", nom: "Fenêtres", dureeVie: 25 },
  { code: "refrigerateur", nom: "Réfrigérateur", dureeVie: 13 },
  { code: "cuisiniere", nom: "Cuisinière", dureeVie: 15 },
  { code: "laveuse", nom: "Laveuse", dureeVie: 10 },
  { code: "secheuse", nom: "Sécheuse", dureeVie: 13, entretien: { mois: 12, quoi: "Nettoyer le conduit" } },
  { code: "lave_vaisselle", nom: "Lave-vaisselle", dureeVie: 10 },
  { code: "hotte", nom: "Hotte de cuisinière", dureeVie: 15 },
  { code: "detecteur_fumee", nom: "Détecteur de fumée", dureeVie: 10, entretien: { mois: 12, quoi: "Tester et changer la pile" } },
  { code: "detecteur_co", nom: "Détecteur de monoxyde de carbone", dureeVie: 7, entretien: { mois: 12, quoi: "Tester et changer la pile" } },
  { code: "extincteur", nom: "Extincteur", dureeVie: 12, entretien: { mois: 12, quoi: "Inspection" } },
  { code: "panneau_electrique", nom: "Panneau électrique", dureeVie: 40 },
  { code: "pompe_puisard", nom: "Pompe de puisard", dureeVie: 10, entretien: { mois: 12, quoi: "Tester la pompe" } },
  { code: "cheminee", nom: "Cheminée", dureeVie: null, entretien: { mois: 12, quoi: "Ramonage" } },
  { code: "autre", nom: "Autre", dureeVie: null },
];

export function typeEquipement(code: string): TypeEquipement | undefined {
  return TYPES_EQUIPEMENT.find((t) => t.code === code);
}

export type Equipement = {
  id: string;
  immeuble_id: string;
  logement_id: string | null;
  type: string;
  nom: string | null;
  marque: string | null;
  modele: string | null;
  no_serie: string | null;
  date_installation: string | null;
  duree_vie_ans: number | null;
  date_remplacement: string | null;
  garantie_fin: string | null;
  cout_cents: number | null;
  fournisseur: string | null;
  entretien_mois: number | null;
  entretien_quoi: string | null;
  dernier_entretien: string | null;
  date_retrait: string | null;
  remplace_par_id: string | null;
  notes: string | null;
};

/** Nom affiché : « Chauffe-eau », ou la précision pour un « Autre » (ex. « Asphalte du stationnement »). */
export function nomEquipement(e: Pick<Equipement, "type" | "nom">): string {
  if (e.type === "autre" && e.nom?.trim()) return e.nom.trim();
  return typeEquipement(e.type)?.nom ?? "Équipement";
}

/** Date de remplacement prévue : celle inscrite à la main, sinon installation + durée de vie. */
export function datePrevue(e: Pick<Equipement, "date_remplacement" | "date_installation" | "duree_vie_ans">): string | null {
  if (e.date_remplacement) return e.date_remplacement;
  if (e.date_installation && e.duree_vie_ans) return ajouterMois(e.date_installation, e.duree_vie_ans * 12);
  return null;
}

/** Prochain entretien : dernier entretien (ou installation) + N mois. */
export function prochainEntretien(e: Pick<Equipement, "entretien_mois" | "dernier_entretien" | "date_installation">): string | null {
  const depart = e.dernier_entretien ?? e.date_installation;
  if (!e.entretien_mois || !depart) return null;
  return ajouterMois(depart, e.entretien_mois);
}

/** Nombre de jours d'aujourd'hui à la date (négatif = passée). */
export function joursAvant(iso: string): number {
  const [a1, m1, j1] = aujourdhuiIso().split("-").map(Number);
  const [a2, m2, j2] = iso.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, j2) - Date.UTC(a1, m1 - 1, j1)) / 86400000);
}

export type Etat = "retard" | "bientot" | "ok" | "inconnu";

/** À remplacer : date passée (retard) ou dans les 180 jours (bientôt), comme les alertes. */
export function etatRemplacement(e: Equipement): Etat {
  const d = datePrevue(e);
  if (!d) return "inconnu";
  const n = joursAvant(d);
  return n < 0 ? "retard" : n <= 180 ? "bientot" : "ok";
}

/** Entretien : passé (retard) ou dans les 14 jours (bientôt), comme les alertes. */
export function etatEntretien(e: Equipement): Etat {
  const d = prochainEntretien(e);
  if (!d) return "inconnu";
  const n = joursAvant(d);
  return n < 0 ? "retard" : n <= 14 ? "bientot" : "ok";
}

/** « 4 ans » / « 8 mois » depuis l'installation */
export function age(iso: string): string {
  const [a1, m1, j1] = iso.split("-").map(Number);
  const [a2, m2, j2] = aujourdhuiIso().split("-").map(Number);
  let mois = (a2 - a1) * 12 + (m2 - m1) - (j2 < j1 ? 1 : 0);
  if (mois < 0) mois = 0;
  if (mois < 12) return `${mois} mois`;
  const ans = Math.floor(mois / 12);
  return `${ans} an${ans > 1 ? "s" : ""}`;
}
