// Calcul du prorata d'utilisation du véhicule pour les immeubles.
//   % immeubles = km inscrits au journal de bord / km totaux de l'année (compteur)
//   part déductible = frais de l'année × %
// La part déductible est ensuite répartie entre les immeubles selon les km de chacun ;
// les trajets « plusieurs immeubles » sont répartis selon le nombre de logements.

import { repartirSelonPoids } from "./repartition";

export type Releve = { date_releve: string; km: number };
export type Trajet = { date_trajet: string; km: number; immeuble_id: string | null };
export type Frais = { date_frais: string; type: string; montant_cents: number };
export type ImmeubleVeh = { id: string; nom: string; nb_logements: number | null };

export type Resume = {
  kmDebut: number | null;
  kmFin: number | null;
  dateDebut: string | null;
  dateFin: string | null;
  kmTotal: number | null;          // null tant qu'il manque un relevé
  kmImmeubles: number;
  pourcentage: number | null;      // 0 à 1
  provisoire: boolean;             // pas de relevé de fin d'année
  incoherent: boolean;             // plus de km au journal qu'au compteur
  fraisParType: Record<string, number>;
  fraisTotal: number;
  deductible: number | null;
  parImmeuble: { id: string; nom: string; km: number; deductible: number }[];
};

const JOURS_TOLERANCE = 31;

function decalerJours(iso: string, n: number): string {
  const [a, m, j] = iso.split("-").map(Number);
  const d = new Date(a, m - 1, j + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function calculerResume(
  annee: number,
  releves: Releve[],
  trajets: Trajet[],
  frais: Frais[],
  immeubles: ImmeubleVeh[],
): Resume {
  const debutAnnee = `${annee}-01-01`;
  const finAnnee = `${annee}-12-31`;

  // Compteur : relevé le plus proche du 1er janvier (jusqu'à 31 jours avant) et du 31 décembre
  // (jusqu'à 31 jours après) ; à défaut, le premier et le dernier relevé de l'année.
  const tries = [...releves].sort((a, b) => a.date_releve.localeCompare(b.date_releve));
  const fenetre = tries.filter(
    (r) => r.date_releve >= decalerJours(debutAnnee, -JOURS_TOLERANCE) && r.date_releve <= decalerJours(finAnnee, JOURS_TOLERANCE),
  );
  const avantDebut = fenetre.filter((r) => r.date_releve <= debutAnnee);
  const debut = avantDebut.length ? avantDebut[avantDebut.length - 1] : fenetre.find((r) => r.date_releve >= debutAnnee) ?? null;
  const apresFin = fenetre.filter((r) => r.date_releve >= finAnnee);
  const fin = apresFin.length ? apresFin[0] : [...fenetre].reverse().find((r) => r.date_releve <= finAnnee) ?? null;

  const kmTotal = debut && fin && fin.date_releve > debut.date_releve ? Math.max(fin.km - debut.km, 0) : null;

  const trajetsAnnee = trajets.filter((t) => t.date_trajet >= debutAnnee && t.date_trajet <= finAnnee);
  const kmImmeubles = Math.round(trajetsAnnee.reduce((s, t) => s + Number(t.km), 0) * 10) / 10;

  const pourcentage = kmTotal && kmTotal > 0 ? Math.min(kmImmeubles / kmTotal, 1) : null;

  const fraisAnnee = frais.filter((f) => f.date_frais >= debutAnnee && f.date_frais <= finAnnee);
  const fraisParType: Record<string, number> = {};
  for (const f of fraisAnnee) fraisParType[f.type] = (fraisParType[f.type] ?? 0) + f.montant_cents;
  const fraisTotal = fraisAnnee.reduce((s, f) => s + f.montant_cents, 0);
  const deductible = pourcentage === null ? null : Math.round(fraisTotal * pourcentage);

  // Part de chaque immeuble
  const kmSans = trajetsAnnee.filter((t) => !t.immeuble_id).reduce((s, t) => s + Number(t.km), 0);
  const totalLogements = immeubles.reduce((s, i) => s + (i.nb_logements ?? 0), 0);
  const poids = immeubles.map((im) => {
    const kmPropres = trajetsAnnee.filter((t) => t.immeuble_id === im.id).reduce((s, t) => s + Number(t.km), 0);
    const partSans = totalLogements > 0 ? (kmSans * (im.nb_logements ?? 0)) / totalLogements : kmSans / Math.max(immeubles.length, 1);
    return kmPropres + partSans;
  });
  const parts = deductible !== null && kmImmeubles > 0 ? repartirSelonPoids(deductible, poids) : immeubles.map(() => 0);
  const parImmeuble = immeubles.map((im, i) => ({
    id: im.id, nom: im.nom, km: Math.round(poids[i] * 10) / 10, deductible: parts[i],
  }));

  return {
    kmDebut: debut?.km ?? null,
    kmFin: fin?.km ?? null,
    dateDebut: debut?.date_releve ?? null,
    dateFin: fin?.date_releve ?? null,
    kmTotal,
    kmImmeubles,
    pourcentage,
    provisoire: !fin || fin.date_releve < `${annee}-12-01`,
    incoherent: kmTotal !== null && kmImmeubles > kmTotal,
    fraisParType,
    fraisTotal,
    deductible,
    parImmeuble,
  };
}

export const TYPES_FRAIS: { code: string; libelle: string }[] = [
  { code: "essence", libelle: "Essence" },
  { code: "entretien", libelle: "Entretien et réparations" },
  { code: "assurance", libelle: "Assurance" },
  { code: "immatriculation", libelle: "Immatriculation (SAAQ)" },
  { code: "interets", libelle: "Intérêts sur le prêt" },
  { code: "location", libelle: "Location (crédit-bail)" },
  { code: "autre", libelle: "Autre (lavage, stationnement…)" },
];

export const MOTIFS = [
  "Collecte des loyers",
  "Supervision de travaux",
  "Réparations / entretien",
  "Achat de matériel",
  "Visite / location d'un logement",
  "Gestion (banque, comptable…)",
];

export function formatKm(km: number | null): string {
  if (km === null) return "—";
  return `${km.toLocaleString("fr-CA", { maximumFractionDigits: 1 })} km`;
}
