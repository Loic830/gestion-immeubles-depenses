"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatCents } from "@/lib/argent";
import { aujourdhuiIso } from "@/lib/dates";

// Feuille « Marquer payé » d'un versement de taxes ou d'une prime d'assurance.
// Propose d'inscrire la dépense correspondante dans Dépenses, déjà catégorisée
// (RPC payer_frais_fixe : paiement + dépense dans une seule transaction).

type Props = {
  source: "taxe" | "assurance";
  id: string;
  titre: string;
  montantCents: number;
  fournisseurDefaut: string;
  avis?: string;
  onFermer: () => void;
  onEnregistre: (texte: string) => void;
};

type ModePaiement = { id: string; nom: string; type: string };

const CATEGORIE = {
  taxe: "Taxes foncières et scolaires (T776 ligne 9180)",
  assurance: "Assurances (T776 ligne 8690)",
};

export default function FeuillePaiement({ source, id, titre, montantCents, fournisseurDefaut, avis, onFermer, onEnregistre }: Props) {
  const [date, setDate] = useState(aujourdhuiIso());
  const [creerDepense, setCreerDepense] = useState(true);
  const [fournisseur, setFournisseur] = useState(fournisseurDefaut);
  const [modes, setModes] = useState<ModePaiement[]>([]);
  const [modeId, setModeId] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  useEffect(() => {
    supabase.from("modes_paiement").select("id, nom, type").eq("actif", true).order("nom").then(({ data }) => {
      const liste = (data ?? []) as ModePaiement[];
      setModes(liste);
      setModeId(liste.find((m) => m.type === "prelevement")?.id ?? "");
    });
  }, []);

  async function payer(e: React.FormEvent) {
    e.preventDefault();
    if (!date) return setErreur("Entre la date du paiement.");
    if (creerDepense && !fournisseur.trim()) return setErreur("Entre le fournisseur de la dépense.");
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.rpc("payer_frais_fixe", {
      p: {
        source, id, date_paiement: date, creer_depense: creerDepense,
        fournisseur_nom: fournisseur.trim(), mode_paiement_id: modeId || null,
      },
    });
    setEnvoi(false);
    if (error) return setErreur(error.message);
    onEnregistre(creerDepense ? `Payé. Dépense de ${formatCents(montantCents)} inscrite dans Dépenses.` : "Marqué payé.");
  }

  return (
    <div className="voile" onClick={onFermer}>
      <form className="feuille" onClick={(e) => e.stopPropagation()} onSubmit={payer} role="dialog" aria-label="Marquer payé">
        <div className="entete" style={{ marginBottom: 4 }}>
          <strong>Marquer payé</strong>
          <button type="button" className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
        </div>
        <p className="aide" style={{ marginTop: 0 }}>{titre} · {formatCents(montantCents)}</p>
        {avis && <div className="message alerte">{avis}</div>}
        {erreur && <div className="message erreur">{erreur}</div>}

        <label htmlFor="pay-date">Date du paiement</label>
        <input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        <label className="case">
          <input type="checkbox" checked={creerDepense} onChange={(e) => setCreerDepense(e.target.checked)} />
          Inscrire aussi la dépense dans Dépenses
        </label>
        {creerDepense && (
          <>
            <p className="aide">Catégorie : {CATEGORIE[source]}. Décoche si la dépense est déjà entrée.</p>
            <label htmlFor="pay-fournisseur">Fournisseur</label>
            <input id="pay-fournisseur" value={fournisseur} onChange={(e) => setFournisseur(e.target.value)} />
            <label htmlFor="pay-mode">Mode de paiement</label>
            <select id="pay-mode" value={modeId} onChange={(e) => setModeId(e.target.value)}>
              <option value="">—</option>
              {modes.map((m) => <option key={m.id} value={m.id}>{m.nom}</option>)}
            </select>
          </>
        )}

        <button className="bouton principal plein" style={{ marginTop: 16 }} disabled={envoi}>
          {envoi ? "Enregistrement…" : "Payé"}
        </button>
      </form>
    </div>
  );
}
