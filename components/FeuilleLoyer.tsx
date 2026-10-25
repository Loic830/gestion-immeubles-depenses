"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { formatCents, versCents, centsVersSaisie } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, moisLisible } from "@/lib/dates";

// Feuille d'un mois de loyer (v0.9.7) : détail du mois, paiements et crédits.
// Toucher un paiement l'ouvre en détail pour le modifier ou l'annuler.
// Utilisée par l'onglet Loyers et par la section « Loyers dus » de la fiche bail.

export type Mode = "interac" | "cheque" | "prelevement" | "comptant" | "credit";
type Statut = "recu" | "en_main" | "sans_provision";
export type Solde = {
  echeance_id: string;
  mois: string;
  loyer_cents: number;
  extras_cents: number;
  montant_du_cents: number;
  recu_cents: number;
  en_main_cents: number;
  solde_cents: number;
  jours_retard: number;
  date_echeance: string;
  bail_id: string;
  mode_paiement: Mode;
  logement_id: string;
  logement: string;
  immeuble_id: string;
  immeuble: string;
  locataires: string | null;
  telephone: string | null;
};
type Paiement = {
  id: string; montant_cents: number; mode: Mode; statut: Statut;
  date_recue: string | null; date_prevue: string | null; reference: string | null; notes: string | null;
  created_at: string; updated_at: string;
};

const MODES: { code: Mode; libelle: string }[] = [
  { code: "interac", libelle: "Interac" },
  { code: "cheque", libelle: "Chèque" },
  { code: "prelevement", libelle: "Prélèvement" },
  { code: "comptant", libelle: "Comptant" },
];
const STATUTS: { code: Statut; libelle: string }[] = [
  { code: "recu", libelle: "Reçu" },
  { code: "en_main", libelle: "Chèque en main" },
  { code: "sans_provision", libelle: "Sans provision" },
];
export const libelleMode = (m: Mode) => (m === "credit" ? "Crédit" : MODES.find((x) => x.code === m)?.libelle ?? m);
const libelleStatut = (s: Statut) => STATUTS.find((x) => x.code === s)?.libelle ?? s;

/** Numéro pour tel: et sms: (chiffres et +) */
export const numero = (t: string) => t.replace(/[^\d+]/g, "");
/** Texto de rappel prérempli ; l'app Messages s'ouvre, rien n'est envoyé sans toucher Envoyer */
export function lienTexto(s: Solde): string {
  const prenom = (s.locataires ?? "").split(",")[0].trim().split(" ")[0];
  const texte = `Bonjour${prenom ? ` ${prenom}` : ""}, petit rappel : le loyer de ${moisLisible(s.mois)} pour le logement ${s.logement}`
    + ` (${formatCents(s.solde_cents)}) n'est pas encore reçu. Merci de me faire signe.`;
  // iPhone : sms:numéro&body=…
  return `sms:${numero(s.telephone ?? "")}&body=${encodeURIComponent(texte)}`;
}

type Props = {
  echeanceId: string;
  /** Cache le lien « Voir le bail » (on y est déjà) */
  depuisBail?: boolean;
  onFermer: () => void;
  /** Appelé après chaque ajout, modification ou annulation, pour recharger la page */
  onChange: () => void | Promise<void>;
};

export default function FeuilleLoyer({ echeanceId, depuisBail, onFermer, onChange }: Props) {
  const [choisie, setChoisie] = useState<Solde | null>(null);
  const [noteMois, setNoteMois] = useState<string | null>(null);
  const [paiements, setPaiements] = useState<Paiement[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  // Nouveau paiement
  const [montantSaisi, setMontantSaisi] = useState("");
  const [mode, setMode] = useState<Mode>("interac");
  const [dateRecue, setDateRecue] = useState(aujourdhuiIso());
  const [reference, setReference] = useState("");
  // Crédit au locataire (ex. achat remboursé sur le loyer)
  const [creditOuvert, setCreditOuvert] = useState(false);
  const [montantCredit, setMontantCredit] = useState("");
  const [raisonCredit, setRaisonCredit] = useState("");

  // Détail d'un paiement (v0.9.7)
  const [ouvert, setOuvert] = useState<Paiement | null>(null);
  const [edMontant, setEdMontant] = useState("");
  const [edMode, setEdMode] = useState<Mode>("interac");
  const [edStatut, setEdStatut] = useState<Statut>("recu");
  const [edDateRecue, setEdDateRecue] = useState("");
  const [edDatePrevue, setEdDatePrevue] = useState("");
  const [edReference, setEdReference] = useState("");
  const [edNotes, setEdNotes] = useState("");

  const charger = useCallback(async () => {
    const [so, ec, pa] = await Promise.all([
      supabase.from("v_soldes").select("*").eq("echeance_id", echeanceId).single(),
      supabase.from("echeances").select("note").eq("id", echeanceId).single(),
      supabase.from("paiements")
        .select("id, montant_cents, mode, statut, date_recue, date_prevue, reference, notes, created_at, updated_at")
        .eq("echeance_id", echeanceId).is("deleted_at", null).order("created_at"),
    ]);
    if (so.error || !so.data) { setErreur(so.error?.message ?? "Mois introuvable."); return null; }
    const s = so.data as Solde;
    setChoisie(s);
    setNoteMois((ec.data as { note: string | null } | null)?.note ?? null);
    setPaiements((pa.data ?? []) as Paiement[]);
    return s;
  }, [echeanceId]);

  // À l'ouverture : préremplir le nouveau paiement avec le solde
  useEffect(() => {
    (async () => {
      const s = await charger();
      if (!s) return;
      setMontantSaisi(centsVersSaisie(Math.max(s.solde_cents, 0)));
      setMode(s.mode_paiement === "credit" ? "interac" : s.mode_paiement);
    })();
  }, [charger]);

  async function apresChangement() {
    const s = await charger();
    if (s) setMontantSaisi(centsVersSaisie(Math.max(s.solde_cents, 0)));
    await onChange();
  }

  async function enregistrerPaiement() {
    if (!choisie) return;
    const cents = versCents(montantSaisi);
    if (cents === null || cents <= 0) return setErreur("Entre un montant valide (ex. 950,00).");
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.from("paiements").insert({
      echeance_id: choisie.echeance_id,
      montant_cents: cents,
      mode,
      statut: "recu",
      date_recue: dateRecue,
      reference: reference.trim() || null,
    });
    setEnvoi(false);
    if (error) return setErreur(error.message);
    await onChange();
    onFermer();
  }

  async function enregistrerCredit() {
    if (!choisie) return;
    const cents = versCents(montantCredit);
    if (cents === null || cents <= 0) return setErreur("Entre le montant du crédit (ex. 150,00).");
    if (!raisonCredit.trim()) return setErreur("Indique la raison du crédit (ex. porte achetée par le locataire).");
    if (cents > choisie.solde_cents && !window.confirm(
      `Le crédit (${formatCents(cents)}) dépasse le solde du mois (${formatCents(choisie.solde_cents)}). Continuer ?`
    )) return;
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.from("paiements").insert({
      echeance_id: choisie.echeance_id,
      montant_cents: cents,
      mode: "credit",
      statut: "recu",
      date_recue: dateRecue,
      notes: raisonCredit.trim(),
    });
    setEnvoi(false);
    if (error) return setErreur(error.message);
    setCreditOuvert(false);
    setMontantCredit("");
    setRaisonCredit("");
    // On garde la feuille ouverte : on enregistre souvent le reste tout de suite
    await apresChangement();
  }

  function ouvrirPaiement(p: Paiement) {
    setErreur(null);
    setOuvert(p);
    setEdMontant(centsVersSaisie(p.montant_cents));
    setEdMode(p.mode);
    setEdStatut(p.statut);
    setEdDateRecue(p.date_recue ?? aujourdhuiIso());
    setEdDatePrevue(p.date_prevue ?? "");
    setEdReference(p.reference ?? "");
    setEdNotes(p.notes ?? "");
  }

  async function modifierPaiement() {
    if (!ouvert) return;
    const cents = versCents(edMontant);
    if (cents === null || cents <= 0) return setErreur("Entre un montant valide (ex. 950,00).");
    const credit = ouvert.mode === "credit";
    if (credit && !edNotes.trim()) return setErreur("Indique la raison du crédit.");
    const statut: Statut = credit ? "recu" : edStatut;
    if (statut === "recu" && !edDateRecue) return setErreur("Entre la date à laquelle le paiement a été reçu.");
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.from("paiements").update({
      montant_cents: cents,
      mode: credit ? "credit" : edMode,
      statut,
      // Chèque en main : pas encore encaissé, la date reçue est vide
      date_recue: statut === "en_main" ? null : edDateRecue || null,
      date_prevue: edDatePrevue || null,
      reference: credit ? ouvert.reference : edReference.trim() || null,
      notes: edNotes.trim() || null,
    }).eq("id", ouvert.id);
    setEnvoi(false);
    if (error) return setErreur(error.message);
    setOuvert(null);
    await apresChangement();
  }

  async function annulerPaiement(p: Paiement) {
    const quoi = p.mode === "credit" ? "ce crédit" : "ce paiement";
    if (!window.confirm(`Annuler ${quoi} de ${formatCents(p.montant_cents)} ? (erreur de saisie)`)) return;
    setEnvoi(true);
    const { error } = await supabase.from("paiements").update({ deleted_at: new Date().toISOString() }).eq("id", p.id);
    setEnvoi(false);
    if (error) return setErreur(error.message);
    setOuvert(null);
    await apresChangement();
  }

  return (
    <div className="voile" onClick={onFermer}>
      <div className="feuille" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Loyer du mois">
        {!choisie ? (
          <>
            <div className="entete" style={{ marginBottom: 4 }}>
              <strong>Loyer</strong>
              <button className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
            </div>
            {erreur ? <div className="message erreur">{erreur}</div> : <p className="aide">Chargement…</p>}
          </>
        ) : ouvert ? (
          /* Détail d'un paiement : modifier ou annuler */
          <>
            <div className="entete" style={{ marginBottom: 4 }}>
              <strong>{ouvert.mode === "credit" ? "Crédit au locataire" : "Paiement"}</strong>
              <button className="lien-retirer" style={{ color: "var(--discret)" }} onClick={() => { setErreur(null); setOuvert(null); }}>Retour</button>
            </div>
            <div className="aide" style={{ marginTop: 0 }}>
              {choisie.immeuble} · {choisie.logement} · <span style={{ textTransform: "capitalize" }}>{moisLisible(choisie.mois)}</span>
            </div>
            <div className="aide" style={{ marginTop: 2 }}>
              Entré le {dateLisible(ouvert.created_at.slice(0, 10))}
              {ouvert.updated_at.slice(0, 16) !== ouvert.created_at.slice(0, 16) && ` · modifié le ${dateLisible(ouvert.updated_at.slice(0, 10))}`}
            </div>
            {erreur && <div className="message erreur">{erreur}</div>}

            <label htmlFor="ed-montant">{ouvert.mode === "credit" ? "Montant du crédit" : "Montant"}</label>
            <input id="ed-montant" className="montant-total" inputMode="decimal" value={edMontant} onChange={(e) => setEdMontant(e.target.value)} />

            {ouvert.mode === "credit" ? (
              <>
                <label htmlFor="ed-raison">Raison</label>
                <input id="ed-raison" value={edNotes} onChange={(e) => setEdNotes(e.target.value)} />
                <label htmlFor="ed-date">Date</label>
                <input id="ed-date" type="date" value={edDateRecue} onChange={(e) => setEdDateRecue(e.target.value)} />
              </>
            ) : (
              <>
                <label>Mode</label>
                <div className="choix-2">
                  {MODES.map((m) => (
                    <button key={m.code} type="button" className={edMode === m.code ? "actif" : ""} onClick={() => setEdMode(m.code)}>{m.libelle}</button>
                  ))}
                </div>
                <label>Statut</label>
                <div className="choix-2">
                  {STATUTS.map((s) => (
                    <button key={s.code} type="button" className={edStatut === s.code ? "actif" : ""} onClick={() => setEdStatut(s.code)}>{s.libelle}</button>
                  ))}
                </div>
                {edStatut === "en_main" && <p className="aide">Chèque reçu mais pas encore déposé : il ne compte pas encore comme payé.</p>}
                {edStatut === "sans_provision" && <p className="aide">Chèque refusé par la banque : il ne compte pas comme payé.</p>}
                {edStatut === "en_main" ? (
                  <>
                    <label htmlFor="ed-prevue">Date du chèque</label>
                    <input id="ed-prevue" type="date" value={edDatePrevue} onChange={(e) => setEdDatePrevue(e.target.value)} />
                  </>
                ) : (
                  <>
                    <label htmlFor="ed-date">Date reçue</label>
                    <input id="ed-date" type="date" value={edDateRecue} onChange={(e) => setEdDateRecue(e.target.value)} />
                  </>
                )}
                <label htmlFor="ed-ref">No chèque / virement</label>
                <input id="ed-ref" value={edReference} onChange={(e) => setEdReference(e.target.value)} />
                <label htmlFor="ed-note">Note</label>
                <input id="ed-note" placeholder="Facultatif" value={edNotes} onChange={(e) => setEdNotes(e.target.value)} />
              </>
            )}

            <button className="bouton principal plein" style={{ marginTop: 16 }} onClick={modifierPaiement} disabled={envoi}>
              {envoi ? "Enregistrement…" : "Enregistrer les changements"}
            </button>
            <button className="bouton plein lien-danger" style={{ marginTop: 10 }} onClick={() => annulerPaiement(ouvert)} disabled={envoi}>
              {ouvert.mode === "credit" ? "Annuler ce crédit (erreur de saisie)" : "Annuler ce paiement (erreur de saisie)"}
            </button>
          </>
        ) : (
          /* Le mois : détail, paiements, ajout */
          <>
            <div className="entete" style={{ marginBottom: 4 }}>
              <strong>{choisie.immeuble} · {choisie.logement}</strong>
              <button className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
            </div>
            <div className="aide" style={{ marginTop: 0 }}>
              {choisie.locataires} · <span style={{ textTransform: "capitalize" }}>{moisLisible(choisie.mois)}</span> · dû {formatCents(choisie.montant_du_cents)}
            </div>
            {choisie.extras_cents !== 0 && (
              <div className="aide" style={{ marginTop: 2 }}>
                Loyer {formatCents(choisie.loyer_cents)} · extras {formatCents(choisie.extras_cents)}
              </div>
            )}
            {noteMois && <div className="aide" style={{ marginTop: 2 }}>{noteMois}</div>}
            {erreur && <div className="message erreur">{erreur}</div>}

            {choisie.jours_retard > 0 && choisie.telephone && (
              <div className="boutons-contact">
                <a className="bouton" href={`tel:${numero(choisie.telephone)}`}>Appeler</a>
                <a className="bouton" href={lienTexto(choisie)}>Texter</a>
              </div>
            )}

            {paiements.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {paiements.map((p) => (
                  <button className="paiement-ligne lien-ligne" key={p.id} onClick={() => ouvrirPaiement(p)}>
                    <span style={{ minWidth: 0 }}>
                      {formatCents(p.montant_cents)} · {libelleMode(p.mode)}
                      {p.date_recue ? ` · ${dateLisible(p.date_recue)}` : p.date_prevue ? ` · ${dateLisible(p.date_prevue)}` : ""}
                      {p.reference ? ` · ${p.reference}` : ""}
                      {p.statut !== "recu" && <span className={`pastille${p.statut === "sans_provision" ? " vacant" : ""}`} style={{ marginLeft: 6 }}>{libelleStatut(p.statut)}</span>}
                      {p.notes ? <span className="aide" style={{ display: "block", margin: 0 }}>{p.notes}</span> : null}
                    </span>
                    <span className="lien-modifier">Détail ›</span>
                  </button>
                ))}
                <p className="aide" style={{ marginTop: 4 }}>Touche un paiement pour le voir ou le modifier.</p>
              </div>
            )}

            {choisie.solde_cents > 0 ? (
              <>
                <label htmlFor="montant">Montant reçu</label>
                <input id="montant" className="montant-total" inputMode="decimal" value={montantSaisi} onChange={(e) => setMontantSaisi(e.target.value)} />
                <div className="choix-2" style={{ marginTop: 8 }}>
                  {MODES.map((m) => (
                    <button key={m.code} type="button" className={mode === m.code ? "actif" : ""} onClick={() => setMode(m.code)}>{m.libelle}</button>
                  ))}
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input type="date" value={dateRecue} onChange={(e) => setDateRecue(e.target.value)} aria-label="Date reçue" />
                  <input placeholder="No chèque / virement" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={enregistrerPaiement} disabled={envoi}>
                  {envoi ? "Enregistrement…" : versCents(montantSaisi) === choisie.solde_cents ? "Reçu" : "Enregistrer ce montant"}
                </button>

                {!creditOuvert ? (
                  <button className="lien-filtres" style={{ margin: "10px auto 0" }} onClick={() => setCreditOuvert(true)}>
                    + Crédit au locataire (achat, réparation…)
                  </button>
                ) : (
                  <div className="bloc-locataire">
                    <strong>Crédit au locataire</strong>
                    <p className="aide" style={{ marginTop: 2 }}>
                      Le montant est déduit de ce que le locataire doit payer ce mois-ci. Le loyer reste inscrit au complet.
                    </p>
                    <label htmlFor="montant-credit">Montant du crédit</label>
                    <input id="montant-credit" inputMode="decimal" placeholder="ex. 150,00" value={montantCredit}
                           onChange={(e) => setMontantCredit(e.target.value)} />
                    <label htmlFor="raison-credit">Raison</label>
                    <input id="raison-credit" placeholder="ex. Porte achetée par le locataire" value={raisonCredit}
                           onChange={(e) => setRaisonCredit(e.target.value)} />
                    <div className="rangee" style={{ marginTop: 8 }}>
                      <button className="bouton" onClick={() => setCreditOuvert(false)} disabled={envoi}>Annuler</button>
                      <button className="bouton principal" onClick={enregistrerCredit} disabled={envoi}>
                        {envoi ? "Enregistrement…" : "Enregistrer le crédit"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="aide" style={{ color: "var(--succes)", fontWeight: 600 }}>Ce loyer est payé.</p>
            )}
            {!depuisBail && (
              <Link href={`/baux/${choisie.bail_id}`} className="lien-filtres" style={{ textAlign: "center" }}>Voir le bail</Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}
