"use client";

import { useRef, useState } from "react";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { centsVersSaisie, versCents } from "@/lib/argent";
import { ajouterMois } from "@/lib/dates";
import { preparerFichier, type FichierPrepare } from "@/lib/image";
import type { Assurance } from "@/lib/fraisFixes";

// Feuille « Assurance » : une police pour un terme (en général un an).
// Renouveler = nouvelle police préremplie ; l'ancienne reste pour l'historique.
// La police (PDF ou photo) va dans la table documents (type « assurance »), dossier assurances/.

export type ModeleAssurance = Partial<Omit<Assurance, "id" | "immeuble_id">>;

type Props = {
  immeubleId: string;
  immeubleNom: string;
  assurance?: Assurance;
  modele?: ModeleAssurance;
  onFermer: () => void;
  onEnregistre: (texte: string) => void;
};

export default function FeuilleAssurance({ immeubleId, immeubleNom, assurance, modele, onFermer, onEnregistre }: Props) {
  const depart = assurance ?? modele ?? {};
  const [assureur, setAssureur] = useState(depart.assureur ?? "");
  const [noPolice, setNoPolice] = useState(depart.no_police ?? "");
  const [prime, setPrime] = useState(depart.prime_annuelle_cents != null ? centsVersSaisie(depart.prime_annuelle_cents) : "");
  const [debut, setDebut] = useState(depart.date_debut ?? "");
  const [renouvellement, setRenouvellement] = useState(
    depart.date_renouvellement ?? (depart.date_debut ? ajouterMois(depart.date_debut, 12) : ""),
  );
  const [mode, setMode] = useState<"annuel" | "mensuel">(depart.mode_paiement ?? "annuel");
  const [notes, setNotes] = useState(depart.notes ?? "");
  const [police, setPolice] = useState<FichierPrepare | null>(null);
  const [traitement, setTraitement] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const champFichier = useRef<HTMLInputElement>(null);

  function changerDebut(v: string) {
    if (v && (!renouvellement || (debut && renouvellement === ajouterMois(debut, 12)))) setRenouvellement(ajouterMois(v, 12));
    setDebut(v);
  }

  async function choisirPolice(fichiers: FileList | null) {
    if (!fichiers?.length) return;
    setTraitement(true);
    try {
      if (police?.apercuUrl) URL.revokeObjectURL(police.apercuUrl);
      setPolice(await preparerFichier(fichiers[0]));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setTraitement(false);
      if (champFichier.current) champFichier.current.value = "";
    }
  }

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    if (!assureur.trim()) return setErreur("Entre le nom de l'assureur.");
    const primeCents = versCents(prime);
    if (primeCents === null) return setErreur("Entre la prime annuelle (ex. 4 800).");
    if (!debut || !renouvellement || renouvellement <= debut) return setErreur("La date de renouvellement doit suivre le début de la police.");
    setErreur(null);
    setEnvoi(true);
    try {
      let documentId = assurance?.document_id ?? null;
      if (police) {
        const d = new Date();
        const ext = police.mimeType === "application/pdf" ? "pdf" : "jpg";
        const cle = `assurances/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
        const up = await supabase.storage.from(BUCKET_RECUS).upload(cle, police.principal, { contentType: police.mimeType, upsert: false });
        if (up.error) throw new Error(`Envoi de la police impossible : ${up.error.message}`);
        const doc = await supabase.from("documents").insert({
          type: "assurance", storage_key: cle, mime_type: police.mimeType,
          date_document: debut, nom_original: police.nomOriginal,
        }).select("id").single();
        if (doc.error || !doc.data) throw new Error(`Police envoyée, mais non enregistrée : ${doc.error?.message}`);
        documentId = doc.data.id;
      }
      const valeurs = {
        immeuble_id: immeubleId,
        assureur: assureur.trim(),
        no_police: noPolice.trim() || null,
        prime_annuelle_cents: primeCents,
        date_debut: debut,
        date_renouvellement: renouvellement,
        mode_paiement: mode,
        document_id: documentId,
        notes: notes.trim() || null,
      };
      const { error } = assurance
        ? await supabase.from("assurances").update(valeurs).eq("id", assurance.id)
        : await supabase.from("assurances").insert(valeurs);
      if (error) throw new Error(error.message);
      if (police?.apercuUrl) URL.revokeObjectURL(police.apercuUrl);
      onEnregistre(assurance ? "Assurance modifiée." : "Assurance ajoutée.");
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvoi(false);
    }
  }

  async function retirer() {
    if (!assurance || !window.confirm("Retirer cette police ? (erreur de saisie)")) return;
    if (assurance.depense_id) {
      return setErreur("Cette prime a une dépense inscrite : annule d'abord le paiement.");
    }
    const { error } = await supabase.from("assurances").update({ deleted_at: new Date().toISOString() }).eq("id", assurance.id);
    if (error) return setErreur(error.message);
    onEnregistre("Assurance retirée.");
  }

  return (
    <div className="voile" onClick={onFermer}>
      <form className="feuille" onClick={(e) => e.stopPropagation()} onSubmit={enregistrer} role="dialog" aria-label="Assurance">
        <div className="entete" style={{ marginBottom: 4 }}>
          <strong>{assurance ? "Modifier l'assurance" : modele ? "Renouvellement" : "Nouvelle assurance"} · {immeubleNom}</strong>
          <button type="button" className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
        </div>
        {erreur && <div className="message erreur" style={{ marginTop: 8 }}>{erreur}</div>}

        <div className="rangee">
          <div>
            <label htmlFor="ass-assureur">Assureur</label>
            <input id="ass-assureur" value={assureur} onChange={(e) => setAssureur(e.target.value)} placeholder="ex. Intact" />
          </div>
          <div>
            <label htmlFor="ass-police">No de police</label>
            <input id="ass-police" value={noPolice} onChange={(e) => setNoPolice(e.target.value)} />
          </div>
        </div>

        <label htmlFor="ass-prime">Prime annuelle (taxes incluses)</label>
        <input id="ass-prime" inputMode="decimal" className="montant-total" value={prime} onChange={(e) => setPrime(e.target.value)} placeholder="0,00" />

        <div className="rangee">
          <div>
            <label htmlFor="ass-debut">Début</label>
            <input id="ass-debut" type="date" value={debut} onChange={(e) => changerDebut(e.target.value)} />
          </div>
          <div>
            <label htmlFor="ass-renouv">Renouvellement</label>
            <input id="ass-renouv" type="date" value={renouvellement} onChange={(e) => setRenouvellement(e.target.value)} />
          </div>
        </div>

        <label>Paiement</label>
        <div className="choix-2">
          <button type="button" className={mode === "annuel" ? "actif" : ""} onClick={() => setMode("annuel")}>Annuel</button>
          <button type="button" className={mode === "mensuel" ? "actif" : ""} onClick={() => setMode("mensuel")}>Mensuel</button>
        </div>

        <label>Police (PDF ou photo)</label>
        <button type="button" className="bouton plein" onClick={() => champFichier.current?.click()} disabled={traitement}>
          {traitement ? "Traitement…" : police ? "Changer le fichier" : assurance?.document_id ? "Remplacer la police" : "Joindre la police"}
        </button>
        <input ref={champFichier} type="file" accept="application/pdf,image/*" hidden onChange={(e) => choisirPolice(e.target.files)} />
        {police && <p className="aide">Fichier prêt : {police.nomOriginal}</p>}

        <label htmlFor="ass-notes">Notes (facultatif)</label>
        <input id="ass-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ex. franchise 1 000 $, courtier" />

        <button className="bouton principal plein" style={{ marginTop: 16 }} disabled={envoi || traitement}>
          {envoi ? "Enregistrement…" : "Enregistrer l'assurance"}
        </button>
        {assurance && (
          <button type="button" className="bouton plein lien-danger" style={{ marginTop: 8 }} onClick={retirer}>Retirer cette police</button>
        )}
      </form>
    </div>
  );
}
