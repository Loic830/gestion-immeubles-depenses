// Rapport d'impôts (Profil, v0.9.12) : revenus de loyers d'une année civile, pour le comptable.
//   loyers_AAAA.xlsx → onglet « Par immeuble » : loyers dus, reçus du locataire, reçus de l'OMH, crédits, solde
//                      onglet « Par mois » : un logement et un mois par ligne
// La part de l'OMH (supplément au loyer) fait partie des loyers : elle est payée au propriétaire
// à la place du locataire. Les montants sont écrits avec leur résultat (pas de formules) :
// l'aperçu de l'iPhone n'évalue pas les formules.

import { supabase } from "./supabase";
import { parLots, toutesLesLignes } from "./paquets";
import { triNumero } from "./dates";
import { telechargerFichier } from "./csv";

type Mois = {
  echeance_id: string; mois: string; immeuble_id: string; immeuble: string; logement: string; locataires: string | null;
  loyer_cents: number; extras_cents: number; montant_du_cents: number; recu_cents: number;
  omh_cents?: number; recu_omh_cents?: number;   // migration 022
};
type Credit = { echeance_id: string; montant_cents: number };

const ARGENT = '#,##0.00 "$"';
const VERT = "FF1B4D34";
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export async function exporterLoyersAnnee(annee: number, progression: (etape: string) => void) {
  progression("Lecture des loyers…");
  const mois = await toutesLesLignes<Mois>((debut, fin) => supabase.from("v_soldes")
    .select("*")
    .gte("mois", `${annee}-01-01`).lte("mois", `${annee}-12-01`)
    .order("mois").order("echeance_id")
    .range(debut, fin));
  if (mois.length === 0) return { lignes: 0, omh: 0 };
  const credits = await parLots<Credit>(mois.map((m) => m.echeance_id), (lot, debut, fin) => supabase.from("paiements")
    .select("echeance_id, montant_cents")
    .in("echeance_id", lot).eq("mode", "credit").eq("statut", "recu").is("deleted_at", null)
    .order("id").range(debut, fin));
  const creditDe = new Map<string, number>();
  for (const c of credits) creditDe.set(c.echeance_id, (creditDe.get(c.echeance_id) ?? 0) + c.montant_cents);

  progression("Préparation du fichier Excel…");
  const { default: ExcelJS } = await import("exceljs");
  const classeur = new ExcelJS.Workbook();
  const enDate = new Date().toLocaleDateString("fr-CA");

  // Montants d'une ligne : reçu du locataire = reçu total moins l'OMH et les crédits
  const chiffres = (m: Mois) => {
    const omh = Number(m.recu_omh_cents ?? 0);
    const credit = creditDe.get(m.echeance_id) ?? 0;
    return {
      du: Number(m.montant_du_cents), partOmh: Number(m.omh_cents ?? 0),
      recuLoc: Number(m.recu_cents) - omh - credit, recuOmh: omh, credit,
      solde: Number(m.montant_du_cents) - Number(m.recu_cents),
    };
  };
  const tries = [...mois].sort((a, b) => a.immeuble.localeCompare(b.immeuble) || triNumero(a.logement, b.logement) || a.mois.localeCompare(b.mois));
  const titresMontants = ["Loyers dus", "dont part de l'OMH", "Reçu du locataire", "Reçu de l'OMH", "Crédits au locataire", "Reste à recevoir"];
  const cles = ["du", "partOmh", "recuLoc", "recuOmh", "credit", "solde"] as const;

  // 1. Par immeuble
  const resume = classeur.addWorksheet("Par immeuble");
  resume.getCell("A1").value = `Revenus de loyers ${annee}`;
  resume.getCell("A1").font = { bold: true, size: 14 };
  resume.getCell("A2").value = `Loyers des mois de janvier à décembre ${annee}, en date du ${enDate}. ` +
    "Le supplément au loyer de l'OMH fait partie des loyers (payé au propriétaire à la place du locataire).";
  resume.getCell("A2").font = { color: { argb: "FF666666" } };
  [24, ...titresMontants.map(() => 17)].forEach((w, i) => (resume.getColumn(i + 1).width = w));
  const ent = resume.getRow(4);
  ["Immeuble", ...titresMontants].forEach((t, i) => (ent.getCell(i + 1).value = t));
  ent.font = { bold: true, color: { argb: "FFFFFFFF" } };
  ent.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };
  ent.alignment = { wrapText: true, vertical: "middle" };
  const immeubles = Array.from(new Set(tries.map((m) => m.immeuble)));
  const total = { du: 0, partOmh: 0, recuLoc: 0, recuOmh: 0, credit: 0, solde: 0 };
  let r = 5;
  for (const nom of immeubles) {
    const somme = { du: 0, partOmh: 0, recuLoc: 0, recuOmh: 0, credit: 0, solde: 0 };
    for (const m of tries.filter((x) => x.immeuble === nom)) {
      const c = chiffres(m);
      for (const k of cles) { somme[k] += c[k]; total[k] += c[k]; }
    }
    const ligne = resume.getRow(r++);
    ligne.getCell(1).value = nom;
    cles.forEach((k, i) => { ligne.getCell(i + 2).value = somme[k] / 100; ligne.getCell(i + 2).numFmt = ARGENT; });
  }
  const ligneTotal = resume.getRow(r + 1);
  ligneTotal.getCell(1).value = "TOTAL";
  cles.forEach((k, i) => { ligneTotal.getCell(i + 2).value = total[k] / 100; ligneTotal.getCell(i + 2).numFmt = ARGENT; });
  ligneTotal.font = { bold: true };

  // 2. Par mois : un logement et un mois par ligne
  const detail = classeur.addWorksheet("Par mois", { views: [{ state: "frozen", ySplit: 1 }] });
  const titres = ["Immeuble", "Logement", "Locataires", "Mois", "Loyer", "Extras et crédits mensuels", ...titresMontants];
  [16, 10, 30, 16, 12, 14, ...titresMontants.map(() => 15)].forEach((w, i) => (detail.getColumn(i + 1).width = w));
  const e = detail.getRow(1);
  titres.forEach((t, i) => (e.getCell(i + 1).value = t));
  e.font = { bold: true, color: { argb: "FFFFFFFF" } };
  e.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };
  e.alignment = { wrapText: true, vertical: "middle" };
  let rd = 2;
  for (const m of tries) {
    const c = chiffres(m);
    const ligne = detail.getRow(rd++);
    ligne.getCell(1).value = m.immeuble;
    ligne.getCell(2).value = m.logement;
    ligne.getCell(3).value = m.locataires ?? "";
    ligne.getCell(4).value = `${MOIS_FR[Number(m.mois.slice(5, 7)) - 1]} ${m.mois.slice(0, 4)}`;
    ligne.getCell(5).value = Number(m.loyer_cents) / 100;
    ligne.getCell(6).value = Number(m.extras_cents) / 100;
    cles.forEach((k, i) => (ligne.getCell(i + 7).value = c[k] / 100));
    for (let col = 5; col <= 12; col++) ligne.getCell(col).numFmt = ARGENT;
  }

  progression("Téléchargement…");
  const tampon = await classeur.xlsx.writeBuffer();
  telechargerFichier(new Blob([tampon], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `loyers_${annee}.xlsx`);
  return { lignes: mois.length, omh: total.recuOmh, recu: total.recuLoc + total.recuOmh };
}
