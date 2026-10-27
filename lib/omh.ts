// Loyer avec subvention de l'OMH (v0.9.12) : Programme de supplément au loyer (PSL).
// Le loyer reconnu (ex. 638 $) est payé en deux parts chaque mois : la part du locataire (450 $)
// et la part de l'OMH, le supplément au loyer (188 $). Migration 022 :
//   baux.part_omh_cents, echeances.omh_cents, paiements.payeur ('locataire' | 'omh'),
//   v_soldes.solde_locataire_cents / solde_omh_cents.

import { supabase } from "./supabase";

export type Payeur = "locataire" | "omh";

export const MESSAGE_MIGRATION_OMH = "La mise à jour de la base (022) pour l'OMH n'est pas encore faite. Demande à Loïc.";

/** Part de l'OMH du bail (null = pas de subvention, ou migration 022 pas encore faite) */
export async function partOmhDuBail(bailId: string): Promise<number | null> {
  const { data, error } = await supabase.from("baux").select("part_omh_cents").eq("id", bailId).maybeSingle();
  if (error || !data) return null;
  return (data as { part_omh_cents: number | null }).part_omh_cents ?? null;
}

/** La migration 022 est-elle faite ? (la colonne part_omh_cents existe) */
export async function migrationOmhFaite(): Promise<boolean> {
  const { error } = await supabase.from("baux").select("part_omh_cents").limit(1);
  return !error;
}

/** Message d'erreur d'une fonction de la base absente avant la migration 022 */
export function messageOmh(message: string, fonction: string): string {
  return message.includes(fonction) || message.includes("part_omh") || message.includes("payeur")
    ? MESSAGE_MIGRATION_OMH : message;
}
