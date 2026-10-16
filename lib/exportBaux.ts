// « Dossier prêteur » d'un immeuble : un ZIP contenant
//   etat_des_loyers.xlsx → un logement par ligne (occupé ou vacant), locataires, dates,
//                          loyer, extras, total mensuel et annuel, lien vers la copie du bail
//   baux/                → chaque page de bail : Gauthier_6_Tremblay_p1.jpg
// Même principe que le dossier comptable : décompresser avant d'ouvrir le fichier Excel.

import { supabase, BUCKET_RECUS } from "./supabase";
import { triNumero } from "./dates";

type Logement = { id: string; numero: string };
type Bail = {
  id: string;
  logement_id: string;
  statut: string;
  date_debut: string;
  date_fin: string | null;
  loyer_cents: number;
  extras_cents: number;
  mode_paiement: string;
  inclusions: string | null;
  locataires: string | null;
};
type Doc = { bail_id: string; storage_key: string; mime_type: string; created_at: string };

const MODES: Record<string, string> = { interac: "Virement Interac", cheque: "Chèques postdatés", prelevement: "Prélèvement", comptant: "Comptant" };

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
  progression: (etape: string) => void
) {
  progression("Préparation…");
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import("exceljs"), import("jszip")]);

  // 1. Données de l'immeuble
  const [lo, ba] = await Promise.all([
    supabase.from("logements").select("id, numero").eq("immeuble_id", immeuble.id).is("deleted_at", null).eq("actif", true),
    supabase.from("v_baux")
      .select("id, logement_id, statut, date_debut, date_fin, loyer_cents, extras_cents, mode_paiement, inclusions, locataires")
      .eq("immeuble_id", immeuble.id)
      .in("statut", ["actif", "a_venir"])
      .order("date_debut"),
  ]);
  if (lo.error) throw new Error(lo.error.message);
  if (ba.error) throw new Error(ba.error.message);
  const logements = ((lo.data ?? []) as Logement[]).sort((a, b) => triNumero(a.numero, b.numero));
  const baux = (ba.data ?? []) as Bail[];
  // Un logement = son bail actif, sinon celui à venir
  const bailDe = (logementId: string) =>
    baux.find((b) => b.logement_id === logementId && b.statut === "actif") ??
    baux.find((b) => b.logement_id === logementId && b.statut === "a_venir");

  const bailIds = logements.map((l) => bailDe(l.id)?.id).filter((x): x is string => Boolean(x));
  const docs: Doc[] = [];
  if (bailIds.length) {
    const { data, error } = await supabase
      .from("documents")
      .select("bail_id, storage_key, mime_type, created_at")
      .in("bail_id", bailIds)
      .eq("type", "bail")
      .order("created_at");
    if (error) throw new Error(error.message);
    docs.push(...((data ?? []) as Doc[]));
  }

  // 2. Copies des baux
  const zip = new JSZip();
  const dossier = zip.folder("baux")!;
  const fichiersParBail = new Map<string, string[]>();
  const manquants: string[] = [];
  let faits = 0;
  for (const l of logements) {
    const b = bailDe(l.id);
    if (!b) continue;
    const pages = docs.filter((d) => d.bail_id === b.id);
    const nomLoc = nomSur((b.locataires ?? "locataire").split(",")[0].trim().split(" ").slice(-1)[0]);
    const noms: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const ext = p.mime_type === "application/pdf" ? "pdf" : "jpg";
      const nom = `${nomSur(immeuble.nom)}_${nomSur(l.numero)}_${nomLoc}${pages.length > 1 ? `_p${i + 1}` : ""}.${ext}`;
      const { data, error } = await supabase.storage.from(BUCKET_RECUS).download(p.storage_key);
      if (error || !data) manquants.push(nom);
      else { dossier.file(nom, data); noms.push(nom); }
      faits++;
      progression(`Copies de baux ${faits} / ${docs.length}`);
    }
    fichiersParBail.set(b.id, noms);
  }

  // 3. État des loyers
  progression("Création de l'état des loyers…");
  const classeur = new ExcelJS.Workbook();
  classeur.creator = "Gestion des immeubles";
  classeur.created = new Date();
  const feuille = classeur.addWorksheet("État des loyers", { views: [{ state: "frozen", ySplit: 4 }] });
  const argent = '#,##0.00 "$"';

  feuille.getCell("A1").value = `État des loyers — ${immeuble.nom}`;
  feuille.getCell("A1").font = { bold: true, size: 14 };
  feuille.getCell("A2").value = `${immeuble.adresse ?? ""}${immeuble.adresse ? " · " : ""}En date du ${new Date().toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" })}`;
  feuille.getCell("A2").font = { color: { argb: "FF666666" } };

  const colonnes = [
    { titre: "Logement", cle: "logement", largeur: 11 },
    { titre: "Locataires", cle: "locataires", largeur: 30 },
    { titre: "Début du bail", cle: "debut", largeur: 13, format: "yyyy-mm-dd" },
    { titre: "Fin du bail", cle: "fin", largeur: 13, format: "yyyy-mm-dd" },
    { titre: "Loyer mensuel", cle: "loyer", largeur: 14, format: argent },
    { titre: "Extras mensuels", cle: "extras", largeur: 14, format: argent },
    { titre: "Total mensuel", cle: "total", largeur: 14, format: argent },
    { titre: "Total annuel", cle: "annuel", largeur: 15, format: argent },
    { titre: "Paiement", cle: "paiement", largeur: 18 },
    { titre: "Inclusions", cle: "inclusions", largeur: 24 },
    { titre: "Copie du bail", cle: "copie", largeur: 34 },
  ];
  colonnes.forEach((c, i) => {
    const col = feuille.getColumn(i + 1);
    col.width = c.largeur;
    if (c.format) col.numFmt = c.format;
  });
  const entete = feuille.getRow(4);
  colonnes.forEach((c, i) => (entete.getCell(i + 1).value = c.titre));
  entete.font = { bold: true, color: { argb: "FFFFFFFF" } };
  entete.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };

  let premiere = 5;
  let rangee = premiere;
  let occupes = 0;
  for (const l of logements) {
    const b = bailDe(l.id);
    const r = feuille.getRow(rangee++);
    r.getCell(1).value = l.numero;
    if (!b) {
      r.getCell(2).value = "Vacant";
      r.getCell(2).font = { italic: true, color: { argb: "FFB3261E" } };
      continue;
    }
    occupes++;
    r.getCell(2).value = (b.locataires ?? "") + (b.statut === "a_venir" ? " (bail à venir)" : "");
    r.getCell(3).value = versDate(b.date_debut);
    r.getCell(4).value = b.date_fin ? versDate(b.date_fin) : "Indéterminée";
    r.getCell(5).value = b.loyer_cents / 100;
    r.getCell(6).value = b.extras_cents / 100;
    r.getCell(7).value = { formula: `E${r.number}+F${r.number}` };
    r.getCell(8).value = { formula: `G${r.number}*12` };
    r.getCell(9).value = MODES[b.mode_paiement] ?? b.mode_paiement;
    r.getCell(10).value = b.inclusions ?? "";
    const fichiers = fichiersParBail.get(b.id) ?? [];
    if (fichiers.length) {
      r.getCell(11).value = { text: fichiers.length > 1 ? `${fichiers[0]} (+${fichiers.length - 1})` : fichiers[0], hyperlink: `baux/${fichiers[0]}` };
      r.getCell(11).font = { color: { argb: "FF1F4E79" }, underline: true };
    } else {
      r.getCell(11).value = "Copie à ajouter";
      r.getCell(11).font = { italic: true, color: { argb: "FF999999" } };
    }
  }
  const derniere = rangee - 1;
  const total = feuille.getRow(rangee + 1);
  total.getCell(1).value = "TOTAL";
  total.getCell(2).value = `${occupes} / ${logements.length} logements occupés`;
  for (const c of [5, 6, 7, 8]) {
    const lettre = String.fromCharCode(64 + c);
    total.getCell(c).value = { formula: `SUM(${lettre}${premiere}:${lettre}${derniere})` };
  }
  total.font = { bold: true };

  zip.file("etat_des_loyers.xlsx", await classeur.xlsx.writeBuffer());
  if (manquants.length) zip.file("COPIES_MANQUANTES.txt", manquants.join("\r\n"));
  zip.file(
    "LISEZMOI.txt",
    `Dossier prêteur — ${immeuble.nom}\r\n\r\n` +
    "1. Décompresser ce fichier ZIP.\r\n" +
    "2. Ouvrir etat_des_loyers.xlsx : un logement par ligne, avec un lien vers la copie du bail.\r\n" +
    "3. Le dossier baux contient les copies (photos ou PDF) à transmettre au prêteur.\r\n"
  );

  progression("Compression…");
  const contenu = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(contenu);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dossier_preteur_${nomSur(immeuble.nom)}_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  const sansCopie = logements.filter((l) => {
    const b = bailDe(l.id);
    return b && (fichiersParBail.get(b.id) ?? []).length === 0;
  }).length;
  return { occupes, total: logements.length, sansCopie, manquants: manquants.length };
}
