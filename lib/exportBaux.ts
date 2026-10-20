// « Dossier prêteur » d'un immeuble pour les années choisies dans l'onglet Baux : un ZIP contenant
//   etat_des_loyers.xlsx → onglet « État des loyers » : un bail par ligne (tous les baux de la période,
//                          logements sans bail inclus), loyer, extras, loyers dus et reçus dans la période,
//                          lien vers la copie du bail ; onglet « Par année » : loyers et occupation
//                          onglet « Copies des baux » : un fichier par ligne, avec son lien
//   baux/                → chaque page de bail : Gauthier_6_1-bail-2023_Tremblay_p1.jpg
// v0.9.5 : pour chaque bail de la période, la chaîne complète est jointe : le bail d'origine signé,
// chaque renouvellement et la cession (Gauthier_6_2-renouvellement-2024_…, Gauthier_6_3-cession-2025_…),
// même si ces baux précédents sont avant la période choisie.
// Même principe que le dossier comptable : décompresser avant d'ouvrir le fichier Excel.

import { supabase, BUCKET_RECUS } from "./supabase";
import { triNumero } from "./dates";
import { bailDansAnnees, chaineDe, libellePeriode, moisDansAnnees, periodeFichier, LIBELLE_ORIGINE, type OrigineBail } from "./baux";

type Logement = { id: string; numero: string };
type Bail = {
  id: string;
  logement_id: string;
  statut: "a_venir" | "actif" | "termine";
  date_debut: string;
  date_fin: string | null;
  date_depart: string | null;
  loyer_cents: number;
  extras_cents: number;
  mode_paiement: string;
  inclusions: string | null;
  locataires: string | null;
  bail_precedent_id: string | null;
  origine: OrigineBail;
};
type Doc = { bail_id: string; storage_key: string; mime_type: string; created_at: string };
type Mois = { bail_id: string; mois: string; montant_du_cents: number; recu_cents: number };

const MODES: Record<string, string> = { interac: "Virement Interac", cheque: "Chèques postdatés", prelevement: "Prélèvement", comptant: "Comptant" };
const STATUTS: Record<string, string> = { actif: "En cours", a_venir: "À venir", termine: "Terminé" };
const TYPE_FICHIER: Record<OrigineBail, string> = { nouveau: "bail", renouvellement: "renouvellement", cession: "cession" };

function nomSur(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "x";
}

function versDate(iso: string | null): Date | null {
  if (!iso) return null;
  const [a, m, j] = iso.split("-").map(Number);
  return new Date(a, m - 1, j);
}

export async function exporterDossierPreteur(
  immeuble: { id: string; nom: string; adresse?: string | null },
  annees: number[],
  progression: (etape: string) => void
) {
  progression("Préparation…");
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import("exceljs"), import("jszip")]);
  const periode = libellePeriode(annees);
  const anneesTriees = [...annees].sort((x, y) => x - y);

  // 1. Données de l'immeuble : tous les baux qui touchent la période
  const [lo, ba] = await Promise.all([
    supabase.from("logements").select("id, numero").eq("immeuble_id", immeuble.id).is("deleted_at", null).eq("actif", true),
    supabase.from("v_baux")
      .select("id, logement_id, statut, date_debut, date_fin, date_depart, loyer_cents, extras_cents, mode_paiement, inclusions, locataires, bail_precedent_id, origine")
      .eq("immeuble_id", immeuble.id)
      .order("date_debut"),
  ]);
  if (lo.error) throw new Error(lo.error.message);
  if (ba.error) throw new Error(ba.error.message);
  const logements = ((lo.data ?? []) as Logement[]).sort((a, b) => triNumero(a.numero, b.numero));
  const tous = (ba.data ?? []) as Bail[];
  const baux = tous.filter((b) => bailDansAnnees(b, annees));
  const bauxDe = (logementId: string) => baux.filter((b) => b.logement_id === logementId);

  const bailIds = baux.filter((b) => logements.some((l) => l.id === b.logement_id)).map((b) => b.id);
  // Chaîne de chaque bail : bail d'origine → renouvellements → cession (v0.9.5)
  const chaines = new Map<string, Bail[]>();
  for (const b of baux) chaines.set(b.id, chaineDe(b, tous));
  const idsCopies = Array.from(new Set(bailIds.flatMap((id) => (chaines.get(id) ?? []).map((x) => x.id))));
  const docs: Doc[] = [];
  const mois: Mois[] = [];
  if (bailIds.length) {
    const [d, m] = await Promise.all([
      supabase.from("documents")
        .select("bail_id, storage_key, mime_type, created_at")
        .in("bail_id", idsCopies)
        .eq("type", "bail")
        .is("deleted_at", null)
        .order("created_at"),
      supabase.from("v_soldes")
        .select("bail_id, mois, montant_du_cents, recu_cents")
        .in("bail_id", bailIds),
    ]);
    if (d.error) throw new Error(d.error.message);
    if (m.error) throw new Error(m.error.message);
    docs.push(...((d.data ?? []) as Doc[]));
    mois.push(...((m.data ?? []) as Mois[]).filter((x) => moisDansAnnees(x.mois, annees)));
  }

  // 2. Copies des baux
  const zip = new JSZip();
  const dossier = zip.folder("baux")!;
  const fichiersParBail = new Map<string, string[]>();
  const copies: { logement: string; bail: Bail; position: number; nom: string }[] = [];
  const manquants: string[] = [];
  let faits = 0;
  for (const l of logements) {
    for (const b of bauxDe(l.id)) {
      const chaine = chaines.get(b.id) ?? [b];
      for (let position = 1; position <= chaine.length; position++) {
        const maillon = chaine[position - 1];
        if (fichiersParBail.has(maillon.id)) continue;  // déjà joint avec un autre bail de la chaîne
        const pages = docs.filter((d) => d.bail_id === maillon.id);
        const nomLoc = nomSur((maillon.locataires ?? "locataire").split(",")[0].trim().split(" ").slice(-1)[0]);
        const noms: string[] = [];
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          const ext = p.mime_type === "application/pdf" ? "pdf" : "jpg";
          const nom = `${nomSur(immeuble.nom)}_${nomSur(l.numero)}_${position}-${TYPE_FICHIER[maillon.origine] ?? "bail"}-${maillon.date_debut.slice(0, 4)}_${nomLoc}` +
            `${pages.length > 1 ? `_p${i + 1}` : ""}.${ext}`;
          const { data, error } = await supabase.storage.from(BUCKET_RECUS).download(p.storage_key);
          if (error || !data) manquants.push(nom);
          else { dossier.file(nom, data); noms.push(nom); copies.push({ logement: l.numero, bail: maillon, position, nom }); }
          faits++;
          progression(`Copies de baux ${faits} / ${docs.length}`);
        }
        fichiersParBail.set(maillon.id, noms);
      }
    }
  }

  // 3. État des loyers
  progression("Création de l'état des loyers…");
  const classeur = new ExcelJS.Workbook();
  classeur.creator = "Gestion des immeubles";
  classeur.created = new Date();
  const feuille = classeur.addWorksheet("État des loyers", { views: [{ state: "frozen", ySplit: 4 }] });
  const argent = '#,##0.00 "$"';
  const enDate = new Date().toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
  const bornes = anneesTriees.length > 1 && anneesTriees.every((a, i) => i === 0 || a === anneesTriees[i - 1] + 1)
    ? ` (1er janvier ${anneesTriees[0]} au 31 décembre ${anneesTriees[anneesTriees.length - 1]})`
    : "";

  feuille.getCell("A1").value = `État des loyers — ${immeuble.nom} — ${periode}`;
  feuille.getCell("A1").font = { bold: true, size: 14 };
  feuille.getCell("A2").value = `${immeuble.adresse ?? ""}${immeuble.adresse ? " · " : ""}Période : ${periode}${bornes} · En date du ${enDate}`;
  feuille.getCell("A2").font = { color: { argb: "FF666666" } };

  const colonnes = [
    { titre: "Logement", largeur: 11 },
    { titre: "Locataires", largeur: 30 },
    { titre: "Statut", largeur: 11 },
    { titre: "Type", largeur: 15 },
    { titre: "Début du bail", largeur: 13, format: "yyyy-mm-dd" },
    { titre: "Fin du bail", largeur: 13, format: "yyyy-mm-dd" },
    { titre: "Loyer mensuel", largeur: 14, format: argent },
    { titre: "Extras / crédits", largeur: 14, format: argent },
    { titre: "Total mensuel", largeur: 14, format: argent },
    { titre: "Mois dans la période", largeur: 11 },
    { titre: "Loyers dus (période)", largeur: 16, format: argent },
    { titre: "Loyers reçus (période)", largeur: 16, format: argent },
    { titre: "Paiement", largeur: 18 },
    { titre: "Inclusions", largeur: 24 },
    { titre: "Copies (bail d'origine, renouvellements, cession)", largeur: 46 },
  ];
  colonnes.forEach((c, i) => {
    const col = feuille.getColumn(i + 1);
    col.width = c.largeur;
    if (c.format) col.numFmt = c.format;
  });
  const entete = feuille.getRow(4);
  colonnes.forEach((c, i) => (entete.getCell(i + 1).value = c.titre));
  entete.font = { bold: true, color: { argb: "FFFFFFFF" } };
  entete.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B4D34" } };
  entete.alignment = { wrapText: true, vertical: "middle" };

  const premiere = 5;
  let rangee = premiere;
  let logementsAvecBail = 0;
  // Résultats précalculés : l'aperçu de l'iPhone (et Google Sheets à l'import) n'évalue pas
  // les formules ; sans « result », les cellules de total paraissent vides.
  const sommes = { 10: 0, 11: 0, 12: 0 } as Record<number, number>;
  for (const l of logements) {
    const liste = bauxDe(l.id);
    if (liste.length === 0) {
      const r = feuille.getRow(rangee++);
      r.getCell(1).value = l.numero;
      r.getCell(2).value = "Aucun bail dans la période (vacant)";
      r.getCell(2).font = { italic: true, color: { argb: "FFB3261E" } };
      continue;
    }
    logementsAvecBail++;
    for (const b of liste) {
      const r = feuille.getRow(rangee++);
      r.getCell(1).value = l.numero;
      r.getCell(2).value = b.locataires ?? "";
      r.getCell(3).value = STATUTS[b.statut] ?? b.statut;
      r.getCell(4).value = LIBELLE_ORIGINE[b.origine] ?? "";
      r.getCell(5).value = versDate(b.date_debut);
      const fin = b.date_depart ?? b.date_fin;
      r.getCell(6).value = fin ? versDate(fin) : "Indéterminée";
      r.getCell(7).value = b.loyer_cents / 100;
      r.getCell(8).value = b.extras_cents / 100;
      r.getCell(9).value = { formula: `G${r.number}+H${r.number}`, result: (b.loyer_cents + b.extras_cents) / 100 };
      const sesMois = mois.filter((m) => m.bail_id === b.id);
      const du = sesMois.reduce((s, m) => s + m.montant_du_cents, 0);
      const recu = sesMois.reduce((s, m) => s + m.recu_cents, 0);
      r.getCell(10).value = sesMois.length;
      r.getCell(11).value = du / 100;
      r.getCell(12).value = recu / 100;
      sommes[10] += sesMois.length;
      sommes[11] += du;
      sommes[12] += recu;
      r.getCell(13).value = MODES[b.mode_paiement] ?? b.mode_paiement;
      r.getCell(14).value = b.inclusions ?? "";
      // Toute la chaîne : « bail 2023 · renouvellement 2024 · cession 2025 » ; lien vers la première copie
      const chaine = chaines.get(b.id) ?? [b];
      const fichiers = chaine.flatMap((x) => fichiersParBail.get(x.id) ?? []);
      const parties = chaine.map((x) => {
        const n = (fichiersParBail.get(x.id) ?? []).length;
        return `${TYPE_FICHIER[x.origine] ?? "bail"} ${x.date_debut.slice(0, 4)}${n === 0 ? " (copie à ajouter)" : ""}`;
      });
      if (fichiers.length) {
        r.getCell(15).value = {
          text: chaine.length > 1 ? `${parties.join(" · ")} — ${fichiers.length} fichier(s)` : fichiers.length > 1 ? `${fichiers[0]} (+${fichiers.length - 1})` : fichiers[0],
          hyperlink: `baux/${fichiers[0]}`,
        };
        r.getCell(15).font = { color: { argb: "FF1B4D34" }, underline: true };
      } else {
        r.getCell(15).value = chaine.length > 1 ? `Copies à ajouter : ${parties.join(" · ")}` : "Copie à ajouter";
        r.getCell(15).font = { italic: true, color: { argb: "FF999999" } };
      }
    }
  }
  const derniere = rangee - 1;
  const total = feuille.getRow(rangee + 1);
  total.getCell(1).value = "TOTAL";
  total.getCell(2).value = `${bailIds.length} bail(s) · ${logementsAvecBail} / ${logements.length} logements loués dans la période`;
  for (const c of [10, 11, 12]) {
    const lettre = String.fromCharCode(64 + c);
    total.getCell(c).value = derniere >= premiere
      ? { formula: `SUM(${lettre}${premiere}:${lettre}${derniere})`, result: c === 10 ? sommes[c] : sommes[c] / 100 }
      : 0;
  }
  total.font = { bold: true };

  // Revenu mensuel actuel : baux en cours seulement (un logement ne compte qu'une fois)
  const enCours = baux.filter((b) => b.statut === "actif" && logements.some((l) => l.id === b.logement_id));
  if (enCours.length) {
    const actuel = feuille.getRow(rangee + 2);
    const mensuel = enCours.reduce((s, b) => s + b.loyer_cents + b.extras_cents, 0);
    actuel.getCell(1).value = "Baux en cours";
    actuel.getCell(2).value = `${enCours.length} logement(s) · revenu mensuel actuel ; annuel = mensuel × 12`;
    actuel.getCell(9).value = mensuel / 100;
    actuel.getCell(11).value = (mensuel * 12) / 100;
    actuel.font = { italic: true };
  }

  // 4. Par année : loyers dus, reçus, mois loués et taux d'occupation
  const parAnnee = classeur.addWorksheet("Par année");
  parAnnee.getCell("A1").value = `Loyers par année — ${immeuble.nom}`;
  parAnnee.getCell("A1").font = { bold: true, size: 14 };
  parAnnee.getCell("A2").value = `Reçus en date du ${enDate}. Occupation = mois loués / (${logements.length} logements × 12).`;
  parAnnee.getCell("A2").font = { color: { argb: "FF666666" } };
  const titres = ["Année", "Loyers dus", "Loyers reçus", "Mois loués", "Taux d'occupation"];
  [8, 16, 16, 12, 16].forEach((w, i) => (parAnnee.getColumn(i + 1).width = w));
  parAnnee.getColumn(2).numFmt = argent;
  parAnnee.getColumn(3).numFmt = argent;
  parAnnee.getColumn(5).numFmt = "0.0 %";
  const ent = parAnnee.getRow(4);
  titres.forEach((t, i) => (ent.getCell(i + 1).value = t));
  ent.font = { bold: true, color: { argb: "FFFFFFFF" } };
  ent.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B4D34" } };
  let ra = 5;
  for (const a of anneesTriees) {
    const ms = mois.filter((m) => m.mois.startsWith(`${a}-`));
    const r = parAnnee.getRow(ra++);
    r.getCell(1).value = a;
    r.getCell(2).value = ms.reduce((s, m) => s + m.montant_du_cents, 0) / 100;
    r.getCell(3).value = ms.reduce((s, m) => s + m.recu_cents, 0) / 100;
    r.getCell(4).value = ms.length;
    const capacite = logements.length * 12;
    r.getCell(5).value = { formula: capacite ? `D${r.number}/${capacite}` : "0", result: capacite ? ms.length / capacite : 0 };
  }

  // 5. Copies des baux : un fichier par ligne, dans l'ordre de chaque chaîne (v0.9.5)
  const feuilleCopies = classeur.addWorksheet("Copies des baux", { views: [{ state: "frozen", ySplit: 4 }] });
  feuilleCopies.getCell("A1").value = `Copies des baux — ${immeuble.nom} — ${periode}`;
  feuilleCopies.getCell("A1").font = { bold: true, size: 14 };
  feuilleCopies.getCell("A2").value = "Pour chaque bail : le bail d'origine signé, puis chaque renouvellement et la cession, s'il y a lieu.";
  feuilleCopies.getCell("A2").font = { color: { argb: "FF666666" } };
  const titresCopies = ["Logement", "Ordre", "Type", "Locataires", "Début", "Fin", "Fichier"];
  [11, 7, 15, 30, 13, 13, 52].forEach((w, i) => (feuilleCopies.getColumn(i + 1).width = w));
  feuilleCopies.getColumn(5).numFmt = "yyyy-mm-dd";
  feuilleCopies.getColumn(6).numFmt = "yyyy-mm-dd";
  const entCopies = feuilleCopies.getRow(4);
  titresCopies.forEach((t, i) => (entCopies.getCell(i + 1).value = t));
  entCopies.font = { bold: true, color: { argb: "FFFFFFFF" } };
  entCopies.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B4D34" } };
  let rc = 5;
  for (const c of copies) {
    const r = feuilleCopies.getRow(rc++);
    r.getCell(1).value = c.logement;
    r.getCell(2).value = c.position;
    r.getCell(3).value = LIBELLE_ORIGINE[c.bail.origine] ?? "";
    r.getCell(4).value = c.bail.locataires ?? "";
    r.getCell(5).value = versDate(c.bail.date_debut);
    const fin = c.bail.date_depart ?? c.bail.date_fin;
    r.getCell(6).value = fin ? versDate(fin) : "Indéterminée";
    r.getCell(7).value = { text: c.nom, hyperlink: `baux/${c.nom}` };
    r.getCell(7).font = { color: { argb: "FF1B4D34" }, underline: true };
  }
  if (copies.length === 0) feuilleCopies.getCell("A5").value = "Aucune copie de bail. Ajoute les photos sur la fiche de chaque bail.";

  zip.file("etat_des_loyers.xlsx", await classeur.xlsx.writeBuffer());
  if (manquants.length) zip.file("COPIES_MANQUANTES.txt", manquants.join("\r\n"));
  zip.file(
    "LISEZMOI.txt",
    `Dossier prêteur — ${immeuble.nom} — période ${periode}\r\n\r\n` +
    "1. Décompresser ce fichier ZIP.\r\n" +
    "2. Ouvrir etat_des_loyers.xlsx : un bail par ligne (tous les baux de la période), avec son type\r\n" +
    "   (nouveau bail, renouvellement ou cession) et un lien vers ses copies.\r\n" +
    "   L'onglet « Par année » donne les loyers dus, reçus et le taux d'occupation de chaque année.\r\n" +
    "   L'onglet « Copies des baux » liste chaque fichier, avec un lien.\r\n" +
    "3. Le dossier baux contient les copies (photos ou PDF) à transmettre au prêteur : pour chaque bail,\r\n" +
    "   le bail d'origine signé (1-bail), puis les renouvellements (2-renouvellement…) et la cession (…-cession).\r\n"
  );

  progression("Compression…");
  const contenu = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(contenu);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dossier_preteur_${nomSur(immeuble.nom)}_${periodeFichier(annees)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  const sansCopie = bailIds.filter((id) => (chaines.get(id) ?? []).every((x) => (fichiersParBail.get(x.id) ?? []).length === 0)).length;
  return { nbBaux: bailIds.length, total: logements.length, sansCopie, manquants: manquants.length };
}
