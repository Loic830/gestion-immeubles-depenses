"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { centsVersSaisie, formatCents, versCents } from "@/lib/argent";
import { ajouterMois } from "@/lib/dates";
import { versementTheorique, versementInsuffisant } from "@/lib/amortissement";
import { versTaux, type Hypotheque } from "@/lib/fraisFixes";

// Feuille « Prêt hypothécaire » : ajouter, modifier, renouveler (nouveau terme) ou retirer un prêt.
// Tous les prêts sont à taux fixe, versements mensuels.

export type ModelePret = Partial<Omit<Hypotheque, "id" | "immeuble_id">>;

type Props = {
  immeubleId: string;
  immeubleNom: string;
  pret?: Hypotheque;          // modification
  modele?: ModelePret;        // ajout prérempli (renouvellement du terme)
  onFermer: () => void;
  onEnregistre: (texte: string) => void;
};

export default function FeuillePret({ immeubleId, immeubleNom, pret, modele, onFermer, onEnregistre }: Props) {
  const depart = pret ?? modele ?? {};
  const [nomPret, setNomPret] = useState(depart.nom_pret ?? "Prêt hypothécaire");
  const [preteur, setPreteur] = useState(depart.preteur ?? "");
  const [noPret, setNoPret] = useState(depart.no_pret ?? "");
  const [solde, setSolde] = useState(depart.solde_debut_terme_cents ? centsVersSaisie(depart.solde_debut_terme_cents) : "");
  const [taux, setTaux] = useState(depart.taux != null ? String(depart.taux).replace(".", ",") : "");
  const [debut, setDebut] = useState(depart.debut_terme ?? "");
  const [fin, setFin] = useState(depart.fin_terme ?? (depart.debut_terme ? ajouterMois(depart.debut_terme, 60) : ""));
  const [premier, setPremier] = useState(depart.premier_versement ?? (depart.debut_terme ? ajouterMois(depart.debut_terme, 1) : ""));
  const amort = depart.amortissement_mois ?? null;
  const [amortAns, setAmortAns] = useState(amort != null ? String(Math.floor(amort / 12)) : "");
  const [amortMois, setAmortMois] = useState(amort != null && amort % 12 ? String(amort % 12) : "");
  const [versement, setVersement] = useState(depart.versement_cents ? centsVersSaisie(depart.versement_cents) : "");
  const [notes, setNotes] = useState(depart.notes ?? "");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  // Début du terme : la fin (5 ans) et le premier versement (1 mois plus tard) suivent tant qu'ils
  // n'ont pas été changés à la main.
  function changerDebut(v: string) {
    if (v && (!fin || (debut && fin === ajouterMois(debut, 60)))) setFin(ajouterMois(v, 60));
    if (v && (!premier || (debut && premier === ajouterMois(debut, 1)))) setPremier(ajouterMois(v, 1));
    setDebut(v);
  }

  const soldeCents = versCents(solde);
  const tauxNum = versTaux(taux);
  const moisAmort = (parseInt(amortAns || "0", 10) || 0) * 12 + (parseInt(amortMois || "0", 10) || 0);
  const versementCents = versCents(versement);
  const calcule = soldeCents && tauxNum != null && moisAmort > 0 ? versementTheorique(soldeCents, tauxNum, moisAmort) : null;
  const ecartCalcule = calcule != null && versementCents ? Math.abs(calcule - versementCents) : null;

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    if (!soldeCents || soldeCents <= 0) return setErreur("Entre le solde au début du terme (ex. 412 000).");
    if (tauxNum == null) return setErreur("Taux invalide (ex. 4,79).");
    if (!debut || !fin || fin <= debut) return setErreur("Vérifie les dates du terme : la fin doit suivre le début.");
    if (!premier || premier <= debut || premier > fin) return setErreur("Le premier versement doit tomber après le début du terme, au plus tard à la fin.");
    if (!versementCents || versementCents <= 0) return setErreur("Entre le versement mensuel indiqué par le prêteur.");
    if (versementInsuffisant({ solde_debut_terme_cents: soldeCents, taux: tauxNum, premier_versement: premier, fin_terme: fin, versement_cents: versementCents })) {
      return setErreur("Ce versement ne couvre même pas les intérêts du mois : vérifie le solde, le taux et le versement.");
    }
    if (moisAmort > 600) return setErreur("Amortissement de 50 ans au maximum.");
    setErreur(null);
    setEnvoi(true);
    const valeurs = {
      immeuble_id: immeubleId,
      nom_pret: nomPret.trim() || "Prêt hypothécaire",
      preteur: preteur.trim() || null,
      no_pret: noPret.trim() || null,
      solde_debut_terme_cents: soldeCents,
      taux: tauxNum,
      debut_terme: debut,
      fin_terme: fin,
      premier_versement: premier,
      amortissement_mois: moisAmort > 0 ? moisAmort : null,
      versement_cents: versementCents,
      notes: notes.trim() || null,
    };
    const { error } = pret
      ? await supabase.from("hypotheques").update(valeurs).eq("id", pret.id)
      : await supabase.from("hypotheques").insert(valeurs);
    setEnvoi(false);
    if (error) return setErreur(`Enregistrement impossible : ${error.message}`);
    onEnregistre(pret ? "Prêt modifié." : "Prêt ajouté.");
  }

  async function retirer() {
    if (!pret || !window.confirm("Retirer ce prêt ? (erreur de saisie : ses intérêts ne seront plus comptés)")) return;
    const { error } = await supabase.from("hypotheques").update({ deleted_at: new Date().toISOString() }).eq("id", pret.id);
    if (error) return setErreur(error.message);
    onEnregistre("Prêt retiré.");
  }

  return (
    <div className="voile" onClick={onFermer}>
      <form className="feuille" onClick={(e) => e.stopPropagation()} onSubmit={enregistrer} role="dialog" aria-label="Prêt hypothécaire">
        <div className="entete" style={{ marginBottom: 4 }}>
          <strong>{pret ? "Modifier le prêt" : modele ? "Nouveau terme" : "Nouveau prêt"} · {immeubleNom}</strong>
          <button type="button" className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
        </div>
        {erreur && <div className="message erreur" style={{ marginTop: 8 }}>{erreur}</div>}

        <label htmlFor="pret-nom">Nom du prêt</label>
        <input id="pret-nom" value={nomPret} onChange={(e) => setNomPret(e.target.value)} placeholder="ex. 1re hypothèque" />
        <div className="rangee">
          <div>
            <label htmlFor="pret-preteur">Prêteur</label>
            <input id="pret-preteur" value={preteur} onChange={(e) => setPreteur(e.target.value)} placeholder="ex. Desjardins" />
          </div>
          <div>
            <label htmlFor="pret-no">No du prêt</label>
            <input id="pret-no" value={noPret} onChange={(e) => setNoPret(e.target.value)} />
          </div>
        </div>

        <label htmlFor="pret-solde">Solde au début du terme</label>
        <input id="pret-solde" inputMode="decimal" value={solde} onChange={(e) => setSolde(e.target.value)} placeholder="412 000" />
        <label htmlFor="pret-taux">Taux fixe (%)</label>
        <input id="pret-taux" inputMode="decimal" value={taux} onChange={(e) => setTaux(e.target.value)} placeholder="4,79" />

        <div className="rangee">
          <div>
            <label htmlFor="pret-debut">Début du terme</label>
            <input id="pret-debut" type="date" value={debut} onChange={(e) => changerDebut(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pret-fin">Fin du terme</label>
            <input id="pret-fin" type="date" value={fin} onChange={(e) => setFin(e.target.value)} />
          </div>
        </div>

        <label htmlFor="pret-premier">Premier versement</label>
        <input id="pret-premier" type="date" value={premier} onChange={(e) => setPremier(e.target.value)} />

        <label>Amortissement restant (au début du terme)</label>
        <div className="rangee">
          <input aria-label="Années" inputMode="numeric" value={amortAns} onChange={(e) => setAmortAns(e.target.value)} placeholder="ans (ex. 20)" />
          <input aria-label="Mois" inputMode="numeric" value={amortMois} onChange={(e) => setAmortMois(e.target.value)} placeholder="mois (facultatif)" />
        </div>

        <label htmlFor="pret-versement">Versement mensuel (selon le prêteur)</label>
        <input id="pret-versement" inputMode="decimal" className="montant-total" value={versement} onChange={(e) => setVersement(e.target.value)} placeholder="0,00" />
        {calcule != null && (
          <p className="aide">
            Versement calculé pour {moisAmort} mois : <strong>{formatCents(calcule)}</strong>
            {ecartCalcule != null && ecartCalcule > 100 && <> (écart de {formatCents(ecartCalcule)} avec le chiffre du prêteur)</>}
            {!versementCents && (
              <> · <button type="button" className="lien-filtres" style={{ display: "inline", margin: 0, padding: 0 }}
                         onClick={() => setVersement(centsVersSaisie(calcule))}>Utiliser</button></>
            )}
          </p>
        )}

        <label htmlFor="pret-notes">Notes (facultatif)</label>
        <input id="pret-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

        <p className="aide">
          Intérêt composé deux fois par année (règle des prêts à taux fixe au Canada). Les intérêts de chaque
          versement sont recalculés à partir de ces chiffres ; le relevé annuel du prêteur, s&apos;il est entré, a priorité.
        </p>
        <button className="bouton principal plein" style={{ marginTop: 8 }} disabled={envoi}>
          {envoi ? "Enregistrement…" : "Enregistrer le prêt"}
        </button>
        {pret && (
          <button type="button" className="bouton plein lien-danger" style={{ marginTop: 8 }} onClick={retirer}>Retirer ce prêt</button>
        )}
      </form>
    </div>
  );
}
