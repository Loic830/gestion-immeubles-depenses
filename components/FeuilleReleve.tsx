"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { centsVersSaisie, formatCents, versCents } from "@/lib/argent";
import type { Hypotheque, Releve } from "@/lib/fraisFixes";

// Feuille « Relevé annuel du prêteur » : intérêts payés selon le relevé (a priorité sur le calcul).

type Props = {
  pret: Hypotheque;
  annee: number;
  calculCents: number;
  releve: Releve | null;
  onFermer: () => void;
  onEnregistre: (texte: string) => void;
};

export default function FeuilleReleve({ pret, annee, calculCents, releve, onFermer, onEnregistre }: Props) {
  const [interets, setInterets] = useState(releve ? centsVersSaisie(releve.interets_releve_cents) : "");
  const [soldeFin, setSoldeFin] = useState(releve?.solde_fin_cents != null ? centsVersSaisie(releve.solde_fin_cents) : "");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    const cents = versCents(interets);
    if (cents === null) return setErreur("Entre les intérêts inscrits sur le relevé (ex. 18 920,45).");
    const solde = soldeFin.trim() ? versCents(soldeFin) : null;
    if (soldeFin.trim() && solde === null) return setErreur("Solde invalide.");
    setErreur(null);
    setEnvoi(true);
    const valeurs = { interets_releve_cents: cents, solde_fin_cents: solde };
    const { error } = releve
      ? await supabase.from("hypotheque_releves").update(valeurs).eq("id", releve.id)
      : await supabase.from("hypotheque_releves").insert({ ...valeurs, hypotheque_id: pret.id, annee });
    setEnvoi(false);
    if (error) return setErreur(`Enregistrement impossible : ${error.message}`);
    onEnregistre(`Relevé ${annee} enregistré.`);
  }

  async function retirer() {
    if (!releve || !window.confirm(`Retirer le relevé ${annee} ? Le calcul de l'app sera utilisé.`)) return;
    const { error } = await supabase.from("hypotheque_releves").update({ deleted_at: new Date().toISOString() }).eq("id", releve.id);
    if (error) return setErreur(error.message);
    onEnregistre(`Relevé ${annee} retiré.`);
  }

  return (
    <div className="voile" onClick={onFermer}>
      <form className="feuille" onClick={(e) => e.stopPropagation()} onSubmit={enregistrer} role="dialog" aria-label="Relevé annuel">
        <div className="entete" style={{ marginBottom: 4 }}>
          <strong>Relevé {annee} · {pret.nom_pret}</strong>
          <button type="button" className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
        </div>
        <p className="aide" style={{ marginTop: 0 }}>Calcul de l&apos;app : {formatCents(calculCents)} d&apos;intérêts en {annee}.</p>
        {erreur && <div className="message erreur">{erreur}</div>}
        <label htmlFor="rel-interets">Intérêts payés selon le relevé du prêteur</label>
        <input id="rel-interets" inputMode="decimal" className="montant-total" value={interets} onChange={(e) => setInterets(e.target.value)} placeholder="0,00" />
        <label htmlFor="rel-solde">Solde au 31 décembre (facultatif)</label>
        <input id="rel-solde" inputMode="decimal" value={soldeFin} onChange={(e) => setSoldeFin(e.target.value)} />
        <p className="aide">Le relevé a priorité : c&apos;est ce montant qui compte pour le T776 (ligne 8710).</p>
        <button className="bouton principal plein" style={{ marginTop: 8 }} disabled={envoi}>
          {envoi ? "Enregistrement…" : "Enregistrer le relevé"}
        </button>
        {releve && <button type="button" className="bouton plein lien-danger" style={{ marginTop: 8 }} onClick={retirer}>Retirer le relevé</button>}
      </form>
    </div>
  );
}
