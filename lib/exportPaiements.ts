// Rapport d'impôts (Profil, v0.9.15) : paiements reçus d'une année civile, pour balancer avec la banque.
//   paiements_AAAA.xlsx → onglet « Dépôts » : un dépôt par ligne, selon la date du dépôt (date_recue)
//                         onglet « Total par mois » : total des dépôts de chaque mois, par mode
// Un dépôt qui paie plusieurs mois (depot_id, v0.9.10) est une seule ligne, comme à la banque.
// Pas compris : crédits au locataire, chèques encore en main, chèques sans provision.
// Les montants sont écrits avec leur résultat (pas de formules) : l'aperçu de l'iPhone n'évalue pas les formules.

import { supabase } from "./supabase";
import { parLots, toutesLesLignes } from "./paquets";
import { telechargerFichier } from "./csv";

type Paiement = {
  id: string; echeance_id: string; montant_cents: number; mode: string; date_recue: string;
  reference: string | null; notes: string | null; depot_id: string | null;
  payeur?: "locataire" | "omh"; auto?: boolean;   // migrations 022 et 023
};
type Mois = { echeance_id: string; mois: string; immeuble: string; logement: string; locataires: string | null };

const ARGENT = '#,##0.00 "$"';
const VERT = "FF1B4D34";
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MODES: Record<string, string> = {
  interac: "Interac", cheque: "Chèque", prelevement: "Prélèvement", comptant: "Comptant", depot_direct: "Dépôt direct",
};
const COLONNES_MODES = ["interac", "cheque", "prelevement", "depot_direct", "comptant"];
const enDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

export async function exporterPaiementsAnnee(annee: number, progression: (etape: string) => void) {
  progression("Lecture des paiements…");
  const paiements = await toutesLesLignes<Paiement>((debut, fin) => supabase.from("paiements")
    .select("*")
    .eq("statut", "recu").neq("mode", "credit").is("deleted_at", null)
    .gte("date_recue", `${annee}-01-01`).lte("date_recue", `${annee}-12-31`)
    .order("date_recue").order("id")
    .range(debut, fin));
  const enMain = (await toutesLesLignes<{ id: string }>((debut, fin) => supabase.from("paiements")
    .select("id").eq("statut", "en_main").is("deleted_at", null).order("id").range(debut, fin))).length;
  if (paiements.length === 0) return { depots: 0, total: 0, enMain };

  const ids = Array.from(new Set(paiements.map((p) => p.echeance_id)));
  const mois = await parLots<Mois>(ids, (lot, debut, fin) => supabase.from("v_soldes")
    .select("echeance_id, mois, immeuble, logement, locataires")
    .in("echeance_id", lot).order("echeance_id").range(debut, fin));
  const moisDe = new Map(mois.map((m) => [m.echeance_id, m]));

  // Un dépôt = les paiements d'un même depot_id (sinon le paiement seul)
  type Depot = { date: string; montant: number; payeur: string; mode: string; reference: string; immeuble: string;
                 logement: string; locataires: string; mois: string[]; auto: boolean };
  const depots = new Map<string, Depot>();
  for (const p of paiements) {
    const m = moisDe.get(p.echeance_id);
    const cle = p.depot_id ?? p.id;
    const d = depots.get(cle) ?? {
      date: p.date_recue, montant: 0, payeur: p.payeur === "omh" ? "OMH" : "Locataire",
      mode: MODES[p.mode] ?? p.mode, reference: p.reference ?? "",
      immeuble: m?.immeuble ?? "", logement: m?.logement ?? "", locataires: m?.locataires ?? "", mois: [], auto: false,
    };
    d.montant += Number(p.montant_cents);
    if (m) d.mois.push(m.mois);
    d.auto = d.auto || (p.auto ?? false) || (p.notes ?? "").startsWith("Marqué payé");
    depots.set(cle, d);
  }
  const liste = Array.from(depots.values()).sort((a, b) => a.date.localeCompare(b.date) || a.immeuble.localeCompare(b.immeuble));

  progression("Préparation du fichier Excel…");
  const { default: ExcelJS } = await import("exceljs");
  const classeur = new ExcelJS.Workbook();
  const entete = (ligne: import("exceljs").Row, titres: string[]) => {
    titres.forEach((t, i) => (ligne.getCell(i + 1).value = t));
    ligne.font = { bold: true, color: { argb: "FFFFFFFF" } };
    ligne.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };
    ligne.alignment = { wrapText: true, vertical: "middle" };
  };

  // 1. Dépôts : un par ligne, dans l'ordre des dates
  const feuille = classeur.addWorksheet("Dépôts", { views: [{ state: "frozen", ySplit: 1 }] });
  const titres = ["Date du dépôt", "Montant", "Payé par", "Mode", "Référence", "Immeuble", "Logement", "Locataires", "Mois payés", "Note"];
  [13, 13, 11, 13, 14, 16, 10, 28, 26, 34].forEach((w, i) => (feuille.getColumn(i + 1).width = w));
  entete(feuille.getRow(1), titres);
  let r = 2;
  let total = 0;
  for (const d of liste) {
    const ligne = feuille.getRow(r++);
    ligne.getCell(1).value = enDate(d.date);
    ligne.getCell(1).numFmt = "yyyy-mm-dd";
    ligne.getCell(2).value = d.montant / 100;
    ligne.getCell(2).numFmt = ARGENT;
    ligne.getCell(3).value = d.payeur;
    ligne.getCell(4).value = d.mode;
    ligne.getCell(5).value = d.reference;
    ligne.getCell(6).value = d.immeuble;
    ligne.getCell(7).value = d.logement;
    ligne.getCell(8).value = d.locataires;
    ligne.getCell(9).value = d.mois.sort().map((m) => `${MOIS_FR[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`).join(", ");
    ligne.getCell(10).value = d.auto ? "Marqué payé à la création du bail : vérifier la date" : "";
    total += d.montant;
  }
  const ligneTotal = feuille.getRow(r + 1);
  ligneTotal.getCell(1).value = "TOTAL";
  ligneTotal.getCell(2).value = total / 100;
  ligneTotal.getCell(2).numFmt = ARGENT;
  ligneTotal.font = { bold: true };

  // 2. Total par mois du dépôt, par mode (le comptant n'est pas toujours déposé à la banque)
  const resume = classeur.addWorksheet("Total par mois");
  resume.getCell("A1").value = `Paiements reçus en ${annee}, selon la date du dépôt`;
  resume.getCell("A1").font = { bold: true, size: 14 };
  resume.getCell("A2").value = "Pas compris : crédits au locataire, chèques encore en main et chèques sans provision." +
    (enMain ? ` Chèques en main en ce moment : ${enMain}.` : "");
  resume.getCell("A2").font = { color: { argb: "FF666666" } };
  const titresMois = ["Mois", "Nombre de dépôts", "Total", ...COLONNES_MODES.map((m) => MODES[m]), "dont OMH"];
  [14, 11, ...titresMois.slice(2).map(() => 14)].forEach((w, i) => (resume.getColumn(i + 1).width = w));
  entete(resume.getRow(4), titresMois);
  const somme = (ds: Depot[]) => ds.reduce((s, d) => s + d.montant, 0) / 100;
  const ecrire = (ligne: import("exceljs").Row, nom: string, ds: Depot[]) => {
    ligne.getCell(1).value = nom;
    ligne.getCell(2).value = ds.length;
    const valeurs = [somme(ds), ...COLONNES_MODES.map((m) => somme(ds.filter((d) => d.mode === MODES[m]))), somme(ds.filter((d) => d.payeur === "OMH"))];
    valeurs.forEach((v, i) => { ligne.getCell(i + 3).value = v; ligne.getCell(i + 3).numFmt = ARGENT; });
  };
  for (let i = 0; i < 12; i++) {
    const cle = `${annee}-${String(i + 1).padStart(2, "0")}`;
    ecrire(resume.getRow(5 + i), MOIS_FR[i], liste.filter((d) => d.date.startsWith(cle)));
  }
  ecrire(resume.getRow(18), "TOTAL", liste);
  resume.getRow(18).font = { bold: true };

  progression("Téléchargement…");
  const tampon = await classeur.xlsx.writeBuffer();
  telechargerFichier(new Blob([tampon], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `paiements_${annee}.xlsx`);
  return { depots: liste.length, total, enMain };
}
