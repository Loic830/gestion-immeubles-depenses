// Rapport d'impôts (Profil, v0.9.0) : dépenses d'une année complète.
//   chargerDepensesAnnee → toutes les lignes de v_depenses_detail du 1er janvier au 31 décembre
//                          (par paquets de 1000, la limite de Supabase par requête)
//   exporterCsvDepenses  → une ligne par ligne de dépense, avec la ligne T776, prête pour Excel

import { supabase } from "./supabase";
import { genererCsv, montantCsv, telechargerFichier } from "./csv";
import type { LigneExport } from "./exportDossier";

export type LigneDepense = LigneExport & { mode_paiement: string | null; nb_pieces: number };

const PAQUET = 1000;

export async function chargerDepensesAnnee(annee: number): Promise<LigneDepense[]> {
  const lignes: LigneDepense[] = [];
  for (let debut = 0; ; debut += PAQUET) {
    const { data, error } = await supabase
      .from("v_depenses_detail")
      .select("*")
      .gte("date_facture", `${annee}-01-01`)
      .lte("date_facture", `${annee}-12-31`)
      .order("date_facture", { ascending: false })
      .order("ligne_id")
      .range(debut, debut + PAQUET - 1);
    if (error) throw new Error(error.message);
    lignes.push(...((data ?? []) as LigneDepense[]));
    if (!data || data.length < PAQUET) return lignes;
  }
}

export function exporterCsvDepenses(lignes: LigneDepense[], nom: string) {
  const entetes = [
    "Date", "Fournisseur", "Immeuble", "Logement", "Catégorie", "Catégorie principale", "Ligne T776",
    "Nature", "Montant", "Avant taxes", "TPS", "TVQ", "Total facture", "Paiement", "No facture",
    "Statut", "Description", "Notes", "Nb reçus",
  ];
  const rangs = lignes.map((l) => [
    l.date_facture, l.fournisseur, l.immeuble, l.logement, l.categorie, l.categorie_parent ?? l.categorie,
    l.code_fiscal, l.nature, montantCsv(l.montant_cents), montantCsv(l.sous_total_cents),
    montantCsv(l.tps_cents), montantCsv(l.tvq_cents), montantCsv(l.total_cents), l.mode_paiement,
    l.no_facture, l.statut, l.description, l.notes, l.nb_pieces,
  ]);
  telechargerFichier(genererCsv(entetes, rangs), nom);
}
