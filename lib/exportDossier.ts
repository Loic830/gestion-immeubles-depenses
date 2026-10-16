// Export « dossier comptable » : un ZIP contenant
//   depenses.xlsx      → une ligne par dépense, avec un lien cliquable vers son reçu
//                        + un onglet « Par catégorie » (totaux par ligne T776)
//   recus/             → chaque photo ou PDF, renommé : 2026-10-16_Simplex_384,13.jpg
//
// Les liens du fichier Excel sont relatifs (recus/...) : il faut DÉCOMPRESSER le ZIP
// avant d'ouvrir le fichier, sinon Excel ne trouve pas les reçus.
//
// Les bibliothèques (ExcelJS, JSZip) sont chargées seulement au moment de l'export
// pour ne pas alourdir l'application.

import { supabase, BUCKET_RECUS } from "./supabase";

export type LigneExport = {
  depense_id: string;
  date_facture: string;
  statut: string;
  fournisseur: string | null;
  immeuble: string;
  logement: string | null;
  categorie: string | null;
  categorie_parent: string | null;
  code_fiscal: string | null;
  nature: string;
  montant_cents: number | null;
  sous_total_cents: number | null;
  tps_cents: number;
  tvq_cents: number;
  total_cents: number | null;
  mode_paiement: string | null;
  no_facture: string | null;
  description: string | null;
  notes: string | null;
};

type Piece = { depense_id: string; storage_key: string; mime_type: string; created_at: string };

export type Progression = (etape: string) => void;

/** « Rona / Alma : été » → « Rona-Alma-ete » (nom de fichier sûr sur Windows, Mac et iPhone) */
function nomSur(texte: string): string {
  return texte
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "sans-nom";
}

function montantNom(cents: number | null): string {
  return cents === null ? "montant-a-preciser" : (cents / 100).toFixed(2).replace(".", ",");
}

function versDateExcel(iso: string): Date {
  const [a, m, j] = iso.split("-").map(Number);
  return new Date(a, m - 1, j);
}

/** Récupère les pièces jointes par paquets (évite les adresses trop longues). */
async function chargerPieces(depenseIds: string[]): Promise<Piece[]> {
  const toutes: Piece[] = [];
  for (let i = 0; i < depenseIds.length; i += 100) {
    const paquet = depenseIds.slice(i, i + 100);
    const { data, error } = await supabase
      .from("pieces_jointes")
      .select("depense_id, storage_key, mime_type, created_at")
      .in("depense_id", paquet)
      .order("created_at");
    if (error) throw new Error(error.message);
    toutes.push(...((data ?? []) as Piece[]));
  }
  return toutes;
}

export async function exporterDossier(lignes: LigneExport[], nomZip: string, progression: Progression) {
  progression("Préparation…");
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import("exceljs"), import("jszip")]);

  // 1. Pièces jointes et noms de fichiers
  const depenseIds = Array.from(new Set(lignes.map((l) => l.depense_id)));
  const pieces = await chargerPieces(depenseIds);
  const premiereLigne = new Map(lignes.map((l) => [l.depense_id, l]));
  const fichiersParDepense = new Map<string, { cle: string; nom: string }[]>();
  const nomsUtilises = new Set<string>();

  for (const id of depenseIds) {
    const liste = pieces.filter((p) => p.depense_id === id);
    const l = premiereLigne.get(id)!;
    const base = `${l.date_facture}_${nomSur(l.fournisseur ?? "fournisseur")}_${montantNom(l.total_cents)}`;
    const noms = liste.map((p, i) => {
      const ext = p.mime_type === "application/pdf" ? "pdf" : "jpg";
      let nom = `${base}${liste.length > 1 ? `_p${i + 1}` : ""}.${ext}`;
      let n = 2;
      while (nomsUtilises.has(nom)) nom = `${base}_${n++}${liste.length > 1 ? `_p${i + 1}` : ""}.${ext}`;
      nomsUtilises.add(nom);
      return { cle: p.storage_key, nom };
    });
    fichiersParDepense.set(id, noms);
  }

  // 2. Téléchargement des reçus (4 à la fois)
  const zip = new JSZip();
  const dossier = zip.folder("recus")!;
  const aTelecharger = Array.from(fichiersParDepense.values()).flat();
  const manquants: string[] = [];
  let faits = 0;
  const file = [...aTelecharger];
  async function travailleur() {
    for (let f = file.shift(); f; f = file.shift()) {
      const { data, error } = await supabase.storage.from(BUCKET_RECUS).download(f.cle);
      if (error || !data) manquants.push(f.nom);
      else dossier.file(f.nom, data);
      faits++;
      progression(`Reçus ${faits} / ${aTelecharger.length}`);
    }
  }
  await Promise.all([travailleur(), travailleur(), travailleur(), travailleur()]);

  // 3. Fichier Excel
  progression("Création du fichier Excel…");
  const classeur = new ExcelJS.Workbook();
  classeur.creator = "Gestion des immeubles";
  classeur.created = new Date();

  const formatArgent = '#,##0.00 "$"';
  const feuille = classeur.addWorksheet("Dépenses", { views: [{ state: "frozen", ySplit: 1 }] });
  feuille.columns = [
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Fournisseur", key: "fournisseur", width: 24 },
    { header: "Immeuble", key: "immeuble", width: 14 },
    { header: "Logement", key: "logement", width: 10 },
    { header: "Catégorie", key: "categorie", width: 24 },
    { header: "Catégorie principale", key: "parent", width: 28 },
    { header: "Ligne T776", key: "t776", width: 11 },
    { header: "Nature", key: "nature", width: 10 },
    { header: "Montant", key: "montant", width: 13, style: { numFmt: formatArgent } },
    { header: "Avant taxes", key: "avant", width: 13, style: { numFmt: formatArgent } },
    { header: "TPS", key: "tps", width: 10, style: { numFmt: formatArgent } },
    { header: "TVQ", key: "tvq", width: 10, style: { numFmt: formatArgent } },
    { header: "Paiement", key: "paiement", width: 16 },
    { header: "No facture", key: "nofacture", width: 14 },
    { header: "Statut", key: "statut", width: 11 },
    { header: "Notes", key: "notes", width: 30 },
    { header: "Reçu", key: "recu", width: 40 },
  ];

  for (const l of lignes) {
    const fichiers = fichiersParDepense.get(l.depense_id) ?? [];
    const rang = feuille.addRow({
      date: versDateExcel(l.date_facture),
      fournisseur: l.fournisseur ?? "",
      immeuble: l.immeuble,
      logement: l.logement ?? "",
      categorie: l.categorie ?? "À préciser",
      parent: l.categorie_parent ?? l.categorie ?? "",
      t776: l.code_fiscal ?? "",
      nature: l.nature === "capital" ? "Capital" : "Courante",
      montant: l.montant_cents === null ? null : l.montant_cents / 100,
      avant: l.sous_total_cents === null ? null : l.sous_total_cents / 100,
      tps: l.sous_total_cents === null ? null : l.tps_cents / 100,
      tvq: l.sous_total_cents === null ? null : l.tvq_cents / 100,
      paiement: l.mode_paiement ?? "",
      nofacture: l.no_facture ?? "",
      statut: l.statut === "brouillon" ? "Brouillon" : "Complète",
      notes: [l.description, l.notes].filter(Boolean).join(" · "),
      recu: "",
    });
    const cellule = rang.getCell("recu");
    if (fichiers.length > 0) {
      const premier = fichiers[0];
      cellule.value = {
        text: fichiers.length > 1 ? `${premier.nom} (+${fichiers.length - 1} page${fichiers.length > 2 ? "s" : ""})` : premier.nom,
        hyperlink: `recus/${premier.nom}`,
      };
      cellule.font = { color: { argb: "FF1B4D34" }, underline: true };
    } else {
      cellule.value = "Aucun reçu";
      cellule.font = { color: { argb: "FF999999" }, italic: true };
    }
  }

  // Ligne de total
  const derniere = feuille.rowCount;
  const total = feuille.addRow({ fournisseur: "TOTAL" });
  total.getCell("montant").value = { formula: `SUM(I2:I${derniere})` };
  total.font = { bold: true };

  const entete = feuille.getRow(1);
  entete.font = { bold: true, color: { argb: "FFFFFFFF" } };
  entete.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B4D34" } };
  feuille.autoFilter = { from: { row: 1, column: 1 }, to: { row: derniere, column: feuille.columnCount } };

  // Onglet résumé par catégorie (utile pour le formulaire T776 / TP-128)
  const resume = classeur.addWorksheet("Par catégorie");
  resume.columns = [
    { header: "Catégorie principale", key: "cat", width: 34 },
    { header: "Ligne T776", key: "t776", width: 12 },
    { header: "Nature", key: "nature", width: 10 },
    { header: "Total", key: "total", width: 15, style: { numFmt: formatArgent } },
  ];
  const groupes = new Map<string, { cat: string; t776: string; nature: string; cents: number }>();
  for (const l of lignes) {
    const cat = l.categorie_parent ?? l.categorie ?? "À préciser";
    const nature = l.nature === "capital" ? "Capital" : "Courante";
    const cle = `${cat}|${nature}`;
    const g = groupes.get(cle) ?? { cat, t776: l.code_fiscal ?? "", nature, cents: 0 };
    g.cents += l.montant_cents ?? 0;
    groupes.set(cle, g);
  }
  Array.from(groupes.values())
    .sort((a, b) => b.cents - a.cents)
    .forEach((g) => resume.addRow({ cat: g.cat, t776: g.t776, nature: g.nature, total: g.cents / 100 }));
  const totalResume = resume.addRow({ cat: "TOTAL" });
  totalResume.getCell("total").value = { formula: `SUM(D2:D${resume.rowCount - 1})` };
  totalResume.font = { bold: true };
  resume.getRow(1).font = { bold: true };

  const tampon = await classeur.xlsx.writeBuffer();
  zip.file("depenses.xlsx", tampon);

  if (manquants.length) {
    zip.file("RECUS_MANQUANTS.txt", `Ces reçus n'ont pas pu être téléchargés :\r\n${manquants.join("\r\n")}\r\n`);
  }
  zip.file(
    "LISEZMOI.txt",
    "1. Décompresser ce fichier ZIP (double-clic).\r\n" +
    "2. Ouvrir depenses.xlsx.\r\n" +
    "3. Cliquer sur un lien de la colonne « Reçu » pour ouvrir la photo correspondante.\r\n" +
    "Les liens ne fonctionnent que si depenses.xlsx et le dossier recus restent ensemble.\r\n"
  );

  // 4. ZIP final
  progression("Compression…");
  const contenu = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(contenu);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomZip;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  return { nbRecus: aTelecharger.length - manquants.length, manquants: manquants.length };
}
