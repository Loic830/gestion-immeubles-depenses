"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { centsVersSaisie, formatCents, versCents } from "@/lib/argent";
import { ajouterMois } from "@/lib/dates";
import { LIBELLE_TAXE, type TaxeVersement, type TypeTaxe } from "@/lib/fraisFixes";

// Feuille « Taxes » :
//  - ajout d'un compte de taxes (foncières ou scolaires) : total et versements avec leurs échéances ;
//  - modification ou retrait d'un seul versement.

type Props = {
  immeubleId: string;
  immeubleNom: string;
  annee: number;
  versement?: TaxeVersement;
  onFermer: () => void;
  onEnregistre: (texte: string) => void;
};

type Ligne = { echeance: string; montant: string };

/** Parts égales ; les cents qui restent vont au premier versement (comme sur un compte de taxes). */
function repartirTotal(totalCents: number, nb: number): number[] {
  const base = Math.floor(totalCents / nb);
  return Array.from({ length: nb }, (_, i) => (i === 0 ? totalCents - base * (nb - 1) : base));
}

export default function FeuilleTaxes({ immeubleId, immeubleNom, annee, versement, onFermer, onEnregistre }: Props) {
  const [type, setType] = useState<TypeTaxe>(versement?.type ?? "fonciere");
  const [anneeTaxe, setAnneeTaxe] = useState(String(versement?.annee ?? annee));
  const [total, setTotal] = useState("");
  const [nb, setNb] = useState(1);
  const [premiere, setPremiere] = useState(`${annee}-03-01`);
  const [lignes, setLignes] = useState<Ligne[]>(
    versement ? [{ echeance: versement.echeance, montant: centsVersSaisie(versement.montant_cents) }] : [],
  );
  const [notes, setNotes] = useState(versement?.notes ?? "");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  // Prépare les versements à partir du total, du nombre et de la première échéance (modifiables ensuite).
  function preparer(nTotal = total, nNb = nb, nPremiere = premiere) {
    const cents = versCents(nTotal);
    if (!cents || !nPremiere) return setLignes([]);
    const parts = repartirTotal(cents, nNb);
    setLignes(parts.map((p, i) => ({ echeance: ajouterMois(nPremiere, i * 3), montant: centsVersSaisie(p) })));
  }

  function changerLigne(i: number, champ: keyof Ligne, valeur: string) {
    setLignes(lignes.map((l, k) => (k === i ? { ...l, [champ]: valeur } : l)));
  }

  const sommeLignes = lignes.reduce((s, l) => s + (versCents(l.montant) ?? 0), 0);
  const totalCents = versCents(total);

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    const a = parseInt(anneeTaxe, 10);
    if (!Number.isInteger(a) || a < 1990 || a > 2100) return setErreur("Année invalide.");
    if (lignes.length === 0) return setErreur("Entre le total du compte de taxes et la première échéance.");
    const rangs = lignes.map((l) => ({ echeance: l.echeance, montant_cents: versCents(l.montant) }));
    if (rangs.some((r) => !r.echeance || !r.montant_cents || r.montant_cents <= 0)) {
      return setErreur("Chaque versement doit avoir une date et un montant.");
    }
    setErreur(null);
    setEnvoi(true);
    const { error } = versement
      ? await supabase.from("taxes_versements").update({
          type, annee: a, echeance: rangs[0].echeance, montant_cents: rangs[0].montant_cents, notes: notes.trim() || null,
        }).eq("id", versement.id)
      : await supabase.from("taxes_versements").insert(rangs.map((r) => ({
          immeuble_id: immeubleId, type, annee: a, echeance: r.echeance, montant_cents: r.montant_cents,
          notes: notes.trim() || null,
        })));
    setEnvoi(false);
    if (error) return setErreur(`Enregistrement impossible : ${error.message}`);
    onEnregistre(versement ? "Versement modifié." : `${LIBELLE_TAXE[type]} ${a} : ${rangs.length} versement(s) ajouté(s).`);
  }

  async function retirer() {
    if (!versement || !window.confirm("Retirer ce versement ? (erreur de saisie)")) return;
    if (versement.depense_id) return setErreur("Ce versement a une dépense inscrite : annule d'abord le paiement.");
    const { error } = await supabase.from("taxes_versements").update({ deleted_at: new Date().toISOString() }).eq("id", versement.id);
    if (error) return setErreur(error.message);
    onEnregistre("Versement retiré.");
  }

  return (
    <div className="voile" onClick={onFermer}>
      <form className="feuille" onClick={(e) => e.stopPropagation()} onSubmit={enregistrer} role="dialog" aria-label="Taxes">
        <div className="entete" style={{ marginBottom: 4 }}>
          <strong>{versement ? "Modifier le versement" : "Compte de taxes"} · {immeubleNom}</strong>
          <button type="button" className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
        </div>
        {erreur && <div className="message erreur" style={{ marginTop: 8 }}>{erreur}</div>}

        <label>Type</label>
        <div className="choix-2">
          <button type="button" className={type === "fonciere" ? "actif" : ""} onClick={() => setType("fonciere")}>Foncières</button>
          <button type="button" className={type === "scolaire" ? "actif" : ""} onClick={() => setType("scolaire")}>Scolaires</button>
        </div>

        <label htmlFor="tx-annee">Année du compte</label>
        <input id="tx-annee" inputMode="numeric" value={anneeTaxe} onChange={(e) => setAnneeTaxe(e.target.value)} />

        {!versement && (
          <>
            <label htmlFor="tx-total">Total du compte</label>
            <input id="tx-total" inputMode="decimal" className="montant-total" value={total} placeholder="0,00"
                   onChange={(e) => { setTotal(e.target.value); preparer(e.target.value); }} />
            <label>Nombre de versements</label>
            <div className="puces">
              {[1, 2, 3, 4, 6].map((n) => (
                <span key={n} className={`puce${nb === n ? " actif" : ""}`}>
                  <button type="button" onClick={() => { setNb(n); preparer(total, n); }}>{n}</button>
                </span>
              ))}
            </div>
            <label htmlFor="tx-premiere">Première échéance</label>
            <input id="tx-premiere" type="date" value={premiere}
                   onChange={(e) => { setPremiere(e.target.value); preparer(total, nb, e.target.value); }} />
          </>
        )}

        {lignes.length > 0 && (
          <>
            <label>{versement ? "Échéance et montant" : "Versements (vérifie les dates sur le compte)"}</label>
            {lignes.map((l, i) => (
              <div key={i} className="rangee" style={{ marginBottom: 8 }}>
                <input type="date" aria-label={`Échéance ${i + 1}`} value={l.echeance} onChange={(e) => changerLigne(i, "echeance", e.target.value)} />
                <input inputMode="decimal" aria-label={`Montant ${i + 1}`} value={l.montant} onChange={(e) => changerLigne(i, "montant", e.target.value)} />
              </div>
            ))}
            {!versement && totalCents != null && sommeLignes !== totalCents && (
              <div className="message alerte">Les versements totalisent {formatCents(sommeLignes)} (compte : {formatCents(totalCents)}).</div>
            )}
          </>
        )}

        <label htmlFor="tx-notes">Notes (facultatif)</label>
        <input id="tx-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex. no de matricule" />

        <button className="bouton principal plein" style={{ marginTop: 16 }} disabled={envoi}>
          {envoi ? "Enregistrement…" : versement ? "Enregistrer" : "Ajouter les versements"}
        </button>
        {versement && (
          <button type="button" className="bouton plein lien-danger" style={{ marginTop: 8 }} onClick={retirer}>Retirer ce versement</button>
        )}
      </form>
    </div>
  );
}
