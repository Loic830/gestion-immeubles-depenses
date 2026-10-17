// Dossier véhicule pour le comptable : un ZIP contenant
//   vehicule_AAAA.xlsx → onglets « Résumé » (km, %, frais, part déductible par immeuble),
//                        « Journal de bord » (date, immeuble, motif, destination, km)
//                        et « Frais » (lien vers chaque reçu)
//   recus/             → reçus du véhicule (photos ou PDF)

import { supabase, BUCKET_RECUS } from "./supabase";
import { calculerResume, TYPES_FRAIS, type ImmeubleVeh } from "./vehicule";

type Deplacement = { date_trajet: string; km: number; immeuble_id: string | null; motif: string; destination: string | null };
type FraisLigne = {
  id: string; date_frais: string; type: string; montant_cents: number;
  fournisseur: string | null; notes: string | null; storage_key: string | null; mime_type: string | null;
};

function nomSur(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "x";
}
function versDate(iso: string): Date {
  const [a, m, j] = iso.split("-").map(Number);
  return new Date(a, m - 1, j);
}
const ARGENT = '#,##0.00 "$"';
const VERT = "FF1B4D34";

/** Nom d'onglet Excel valide (31 caractères, sans : \ / ? * [ ]) */
function nomOnglet(t: string): string {
  return t.replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
}

/** Charge les relevés, trajets et frais d'une année et calcule le prorata */
export async function chargerDonneesVehicule(vehiculeId: string, annee: number, immeubles: ImmeubleVeh[]) {
  const debut = `${annee}-01-01`;
  const fin = `${annee}-12-31`;
  const [re, de, fr] = await Promise.all([
    supabase.from("releves_odometre").select("date_releve, km").eq("vehicule_id", vehiculeId).is("deleted_at", null),
    supabase.from("deplacements").select("date_trajet, km, immeuble_id, motif, destination")
      .eq("vehicule_id", vehiculeId).is("deleted_at", null).gte("date_trajet", debut).lte("date_trajet", fin).order("date_trajet"),
    supabase.from("frais_vehicule").select("id, date_frais, type, montant_cents, fournisseur, notes, storage_key, mime_type")
      .eq("vehicule_id", vehiculeId).is("deleted_at", null).gte("date_frais", debut).lte("date_frais", fin).order("date_frais"),
  ]);
  const err = [re, de, fr].find((x) => x.error)?.error;
  if (err) throw new Error(err.message);
  const releves = ((re.data ?? []) as { date_releve: string; km: number }[]).map((x) => ({ ...x, km: Number(x.km) }));
  const trajets = ((de.data ?? []) as Deplacement[]).map((t) => ({ ...t, km: Number(t.km) }));
  const frais = (fr.data ?? []) as FraisLigne[];
  return { trajets, frais, resume: calculerResume(annee, releves, trajets, frais, immeubles) };
}
export type DonneesVehicule = Awaited<ReturnType<typeof chargerDonneesVehicule>>;

/**
 * Ajoute les 3 onglets du véhicule (Résumé, Journal de bord, Frais) à un classeur
 * et ses reçus dans un dossier du ZIP. Sert à l'export Véhicule et au dossier comptable.
 */
export async function ajouterVehicule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  classeur: any, zip: any,
  vehicule: { id: string; nom: string },
  annee: number,
  immeubles: ImmeubleVeh[],
  progression: (etape: string) => void,
  opts: { dossierRecus: string; prefixe: string },
  donnees?: DonneesVehicule,
) {
  const { trajets, frais, resume: r } = donnees ?? (await chargerDonneesVehicule(vehicule.id, annee, immeubles));
  const nomImmeuble = (id: string | null) => (id ? immeubles.find((i) => i.id === id)?.nom ?? "" : "Plusieurs immeubles");
  const libelleType = (c: string) => TYPES_FRAIS.find((t) => t.code === c)?.libelle ?? c;

  // Reçus
  const dossier = zip.folder(opts.dossierRecus)!;
  const nomRecu = new Map<string, string>();
  const manquants: string[] = [];
  const avecRecu = frais.filter((f) => f.storage_key);
  for (let i = 0; i < avecRecu.length; i++) {
    const f = avecRecu[i];
    progression(`Reçus du véhicule ${i + 1} / ${avecRecu.length}`);
    const ext = f.mime_type === "application/pdf" ? "pdf" : "jpg";
    const nom = `${f.date_frais}_${nomSur(libelleType(f.type).split(" ")[0])}_${nomSur(f.fournisseur ?? "")}_${(f.montant_cents / 100).toFixed(2).replace(".", ",")}_${i + 1}.${ext}`;
    const { data, error } = await supabase.storage.from(BUCKET_RECUS).download(f.storage_key!);
    if (error || !data) manquants.push(nom);
    else { dossier.file(nom, data); nomRecu.set(f.id, nom); }
  }

  // --- Résumé
  const res = classeur.addWorksheet(nomOnglet(`${opts.prefixe}Résumé`));
  res.getColumn(1).width = 44;
  res.getColumn(2).width = 18;
  res.getColumn(3).width = 18;
  res.getCell("A1").value = `Véhicule — ${vehicule.nom} — ${annee}`;
  res.getCell("A1").font = { bold: true, size: 14 };
  const lignes: [string, unknown, string?][] = [
    ["Compteur au début", r.kmDebut !== null ? `${r.kmDebut.toLocaleString("fr-CA")} km (${r.dateDebut})` : "Relevé manquant"],
    ["Compteur à la fin", r.kmFin !== null ? `${r.kmFin.toLocaleString("fr-CA")} km (${r.dateFin})` : "Relevé manquant"],
    ["Km totaux de l'année", r.kmTotal ?? "—"],
    ["Km pour les immeubles (journal de bord)", r.kmImmeubles],
    ["Pourcentage d'utilisation pour les immeubles", r.pourcentage ?? "—", "0.0%"],
  ];
  let ligne = 3;
  for (const [titre, valeur, format] of lignes) {
    res.getCell(ligne, 1).value = titre;
    res.getCell(ligne, 2).value = valeur as never;
    if (format) res.getCell(ligne, 2).numFmt = format;
    ligne++;
  }
  if (r.provisoire) {
    res.getCell(ligne, 1).value = "Provisoire : il manque le relevé du compteur de fin d'année.";
    res.getCell(ligne, 1).font = { italic: true, color: { argb: "FFA15C00" } };
    ligne++;
  }
  ligne++;
  const enteteFrais = res.getRow(ligne);
  ["Frais du véhicule", "Total (100 %)", "Part immeubles"].forEach((t, i) => (enteteFrais.getCell(i + 1).value = t));
  enteteFrais.font = { bold: true, color: { argb: "FFFFFFFF" } };
  enteteFrais.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };
  ligne++;
  for (const t of TYPES_FRAIS) {
    const cents = r.fraisParType[t.code];
    if (!cents) continue;
    res.getCell(ligne, 1).value = t.libelle;
    res.getCell(ligne, 2).value = cents / 100;
    res.getCell(ligne, 3).value = r.pourcentage === null ? null : Math.round(cents * r.pourcentage) / 100;
    res.getCell(ligne, 2).numFmt = ARGENT;
    res.getCell(ligne, 3).numFmt = ARGENT;
    ligne++;
  }
  res.getCell(ligne, 1).value = "TOTAL";
  res.getCell(ligne, 2).value = r.fraisTotal / 100;
  res.getCell(ligne, 3).value = r.deductible === null ? "—" : r.deductible / 100;
  res.getCell(ligne, 2).numFmt = ARGENT;
  res.getCell(ligne, 3).numFmt = ARGENT;
  res.getRow(ligne).font = { bold: true };
  ligne += 2;
  const enteteIm = res.getRow(ligne);
  ["Répartition par immeuble", "Km", "Part déductible"].forEach((t, i) => (enteteIm.getCell(i + 1).value = t));
  enteteIm.font = { bold: true, color: { argb: "FFFFFFFF" } };
  enteteIm.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };
  ligne++;
  for (const p of r.parImmeuble) {
    res.getCell(ligne, 1).value = p.nom;
    res.getCell(ligne, 2).value = p.km;
    res.getCell(ligne, 3).value = p.deductible / 100;
    res.getCell(ligne, 3).numFmt = ARGENT;
    ligne++;
  }
  ligne++;
  res.getCell(ligne, 1).value =
    "Trajets « plusieurs immeubles » répartis selon le nombre de logements. " +
    "La déduction pour amortissement (DPA) du véhicule n'est pas incluse : à calculer par le comptable.";
  res.getCell(ligne, 1).font = { italic: true, color: { argb: "FF666666" } };

  // --- Journal de bord
  const jou = classeur.addWorksheet(nomOnglet(`${opts.prefixe}Journal de bord`), { views: [{ state: "frozen", ySplit: 1 }] });
  jou.columns = [
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Immeuble", key: "immeuble", width: 20 },
    { header: "Motif", key: "motif", width: 32 },
    { header: "Destination / détail", key: "destination", width: 34 },
    { header: "Km (aller-retour)", key: "km", width: 16 },
  ];
  for (const t of trajets) {
    jou.addRow({ date: versDate(t.date_trajet), immeuble: nomImmeuble(t.immeuble_id), motif: t.motif, destination: t.destination ?? "", km: t.km });
  }
  const totalJ = jou.addRow({ motif: "TOTAL" });
  totalJ.getCell("km").value = { formula: `SUM(E2:E${jou.rowCount - 1})`, result: r.kmImmeubles };
  totalJ.font = { bold: true };
  jou.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  jou.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };

  // --- Frais
  const fra = classeur.addWorksheet(nomOnglet(`${opts.prefixe}Frais`), { views: [{ state: "frozen", ySplit: 1 }] });
  fra.columns = [
    { header: "Date", key: "date", width: 12, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Type", key: "type", width: 26 },
    { header: "Fournisseur", key: "fournisseur", width: 22 },
    { header: "Montant (100 %)", key: "montant", width: 15, style: { numFmt: ARGENT } },
    { header: "Notes", key: "notes", width: 28 },
    { header: "Reçu", key: "recu", width: 40 },
  ];
  for (const f of frais) {
    const row = fra.addRow({
      date: versDate(f.date_frais), type: libelleType(f.type), fournisseur: f.fournisseur ?? "",
      montant: f.montant_cents / 100, notes: f.notes ?? "",
    });
    const nom = nomRecu.get(f.id);
    if (nom) {
      row.getCell("recu").value = { text: nom, hyperlink: `${opts.dossierRecus}/${nom}` };
      row.getCell("recu").font = { color: { argb: VERT }, underline: true };
    } else {
      row.getCell("recu").value = "Aucun reçu";
      row.getCell("recu").font = { italic: true, color: { argb: "FF999999" } };
    }
  }
  const totalF = fra.addRow({ fournisseur: "TOTAL" });
  totalF.getCell("montant").value = { formula: `SUM(D2:D${fra.rowCount - 1})`, result: r.fraisTotal / 100 };
  totalF.font = { bold: true };
  fra.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  fra.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERT } };

  return { resume: r, trajets: trajets.length, frais: frais.length, manquants, ongletResume: res.name as string };
}

export async function exporterDossierVehicule(
  vehicule: { id: string; nom: string },
  annee: number,
  immeubles: ImmeubleVeh[],
  progression: (etape: string) => void,
) {
  progression("Préparation…");
  const [{ default: ExcelJS }, { default: JSZip }] = await Promise.all([import("exceljs"), import("jszip")]);
  const zip = new JSZip();
  const classeur = new ExcelJS.Workbook();
  classeur.creator = "Gestion des immeubles";
  classeur.created = new Date();
  const { trajets, frais, manquants } = await ajouterVehicule(
    classeur, zip, vehicule, annee, immeubles, progression, { dossierRecus: "recus", prefixe: "" },
  );

  progression("Création du fichier Excel…");
  zip.file(`vehicule_${annee}.xlsx`, await classeur.xlsx.writeBuffer());
  if (manquants.length) zip.file("RECUS_MANQUANTS.txt", manquants.join("\r\n"));
  zip.file(
    "LISEZMOI.txt",
    `Frais de véhicule — ${vehicule.nom} — ${annee}\r\n\r\n` +
    "1. Décompresser ce fichier ZIP.\r\n" +
    `2. Ouvrir vehicule_${annee}.xlsx : résumé (km, pourcentage, part déductible par immeuble), journal de bord et frais.\r\n` +
    "3. Le dossier recus contient les reçus liés dans l'onglet Frais.\r\n",
  );

  progression("Compression…");
  const contenu = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(contenu);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dossier_vehicule_${nomSur(vehicule.nom)}_${annee}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { trajets, frais, manquants: manquants.length };
}
