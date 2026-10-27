"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { formatCents, versCents, centsVersSaisie } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, moisLisible } from "@/lib/dates";
import { messageOmh, type Payeur } from "@/lib/omh";

// Feuille d'un mois de loyer (v0.9.7) : détail du mois, paiements et crédits.
// Toucher un paiement l'ouvre en détail pour le modifier ou l'annuler.
// Utilisée par l'onglet Loyers et par la section « Loyers dus » de la fiche bail.
// v0.9.10 : un dépôt peut payer plusieurs mois (RPC repartir_depot, paiements.depot_id).
// v0.9.12 : loyer avec subvention de l'OMH : deux parts par mois, payées par le locataire et par l'OMH
//           (paiements.payeur). Sans part de l'OMH (ou sans la migration 022), rien ne change.

export type Mode = "interac" | "cheque" | "prelevement" | "comptant" | "credit" | "depot_direct";
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
  // v0.9.12 (migration 022) : absents avant la migration
  omh_cents?: number;
  recu_omh_cents?: number;
  solde_locataire_cents?: number;
  solde_omh_cents?: number;
};

/** Part de l'OMH du mois (0 = pas de subvention) */
export const partOmh = (s: Pick<Solde, "omh_cents">) => s.omh_cents ?? 0;
/** Ce qui reste à payer par le locataire (sans la part de l'OMH) */
export const soldeLocataire = (s: Pick<Solde, "solde_cents" | "solde_locataire_cents">) => s.solde_locataire_cents ?? s.solde_cents;
/** Ce qui reste à recevoir de l'OMH */
export const soldeOmh = (s: Pick<Solde, "solde_omh_cents">) => s.solde_omh_cents ?? 0;
/** Ce qui reste à recevoir en tout (un trop-payé d'une part ne couvre pas l'autre) */
export const resteARecevoir = (s: Pick<Solde, "solde_cents" | "solde_locataire_cents" | "solde_omh_cents">) =>
  Math.max(0, soldeLocataire(s)) + Math.max(0, soldeOmh(s));
type Paiement = {
  id: string; montant_cents: number; mode: Mode; statut: Statut;
  date_recue: string | null; date_prevue: string | null; reference: string | null; notes: string | null;
  created_at: string; updated_at: string; depot_id: string | null;
  payeur?: Payeur;   // v0.9.12
};
/** Un mois du bail, pour répartir un dépôt */
type MoisBail = { echeance_id: string; mois: string; montant_du_cents: number; omh_cents?: number };
/** Paiement d'un mois du bail (crédits, paiements remplacés, total d'un dépôt) */
type PaiementBail = { id: string; echeance_id: string; montant_cents: number; mode: Mode; statut: Statut; date_recue: string | null; depot_id: string | null; payeur?: Payeur };
const payeurDe = (p: { payeur?: Payeur }): Payeur => p.payeur ?? "locataire";

/** Ce que doit un payeur pour un mois : la part de l'OMH, ou le reste moins les crédits au locataire */
function duPar(payeur: Payeur, m: MoisBail, credits: Map<string, number>): number {
  return payeur === "omh"
    ? (m.omh_cents ?? 0)
    : Math.max(0, m.montant_du_cents - (m.omh_cents ?? 0) - (credits.get(m.echeance_id) ?? 0));
}

/** Part de chaque mois choisi, comme repartir_depot : le plus ancien d'abord, le dernier prend le reste */
function repartition(total: number, mois: MoisBail[], credits: Map<string, number>, payeur: Payeur): { m: MoisBail; part: number; du: number }[] {
  let reste = total;
  return mois.map((m, i) => {
    const du = duPar(payeur, m, credits);
    const part = i === mois.length - 1 ? Math.max(0, reste) : Math.min(reste, du);
    reste -= part;
    return { m, part, du };
  });
}

const MODES: { code: Mode; libelle: string }[] = [
  { code: "interac", libelle: "Interac" },
  { code: "cheque", libelle: "Chèque" },
  { code: "prelevement", libelle: "Prélèvement" },
  { code: "comptant", libelle: "Comptant" },
];
/** Modes d'un paiement de l'OMH (v0.9.12) */
const MODES_OMH: { code: Mode; libelle: string }[] = [
  { code: "depot_direct", libelle: "Dépôt direct" },
  { code: "cheque", libelle: "Chèque" },
];
const modesDe = (payeur: Payeur) => (payeur === "omh" ? MODES_OMH : MODES);
const STATUTS: { code: Statut; libelle: string }[] = [
  { code: "recu", libelle: "Reçu" },
  { code: "en_main", libelle: "Chèque en main" },
  { code: "sans_provision", libelle: "Sans provision" },
];
export const libelleMode = (m: Mode) => (m === "credit" ? "Crédit" : [...MODES, ...MODES_OMH].find((x) => x.code === m)?.libelle ?? m);
const libelleStatut = (s: Statut) => STATUTS.find((x) => x.code === s)?.libelle ?? s;

/** Numéro pour tel: et sms: (chiffres et +) */
export const numero = (t: string) => t.replace(/[^\d+]/g, "");
/** Texto de rappel prérempli ; l'app Messages s'ouvre, rien n'est envoyé sans toucher Envoyer */
export function lienTexto(s: Solde): string {
  const prenom = (s.locataires ?? "").split(",")[0].trim().split(" ")[0];
  const texte = `Bonjour${prenom ? ` ${prenom}` : ""}, petit rappel : le loyer de ${moisLisible(s.mois)} pour le logement ${s.logement}`
    + ` (${formatCents(soldeLocataire(s))}) n'est pas encore reçu. Merci de me faire signe.`;
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
  // Qui paie (v0.9.12) : le locataire ou l'OMH (seulement si le mois a une part de l'OMH)
  const [payeur, setPayeur] = useState<Payeur>("locataire");
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
  const [edPayeur, setEdPayeur] = useState<Payeur>("locataire");

  // Dépôt pour plusieurs mois (v0.9.10)
  const [moisBail, setMoisBail] = useState<MoisBail[]>([]);
  const [paiementsBail, setPaiementsBail] = useState<PaiementBail[]>([]);
  const [depotOuvert, setDepotOuvert] = useState(false);
  const [depotDe, setDepotDe] = useState<Paiement | null>(null); // paiement corrigé, s'il y a lieu
  const [dpMontant, setDpMontant] = useState("");
  const [dpMode, setDpMode] = useState<Mode>("interac");
  const [dpDate, setDpDate] = useState(aujourdhuiIso());
  const [dpReference, setDpReference] = useState("");
  const [dpMois, setDpMois] = useState<string[]>([]); // echeance_id choisis
  const [dpPayeur, setDpPayeur] = useState<Payeur>("locataire");

  const charger = useCallback(async () => {
    const [so, ec, pa] = await Promise.all([
      supabase.from("v_soldes").select("*").eq("echeance_id", echeanceId).single(),
      supabase.from("echeances").select("note").eq("id", echeanceId).single(),
      supabase.from("paiements")
        .select("*")   // avec payeur après la migration 022
        .eq("echeance_id", echeanceId).is("deleted_at", null).order("created_at"),
    ]);
    if (so.error || !so.data) { setErreur(so.error?.message ?? "Mois introuvable."); return null; }
    const s = so.data as Solde;
    setChoisie(s);
    setNoteMois((ec.data as { note: string | null } | null)?.note ?? null);
    setPaiements((pa.data ?? []) as Paiement[]);
    // Les mois du bail et leurs paiements : crédits, total des dépôts, mois à répartir
    const { data: mb } = await supabase.from("v_soldes").select("*")
      .eq("bail_id", s.bail_id).order("mois");
    const liste = (mb ?? []) as MoisBail[];
    setMoisBail(liste);
    if (liste.length) {
      const { data: pb } = await supabase.from("paiements")
        .select("*")
        .in("echeance_id", liste.map((m) => m.echeance_id)).is("deleted_at", null);
      setPaiementsBail((pb ?? []) as PaiementBail[]);
    }
    return s;
  }, [echeanceId]);

  // À l'ouverture : préremplir le nouveau paiement avec le solde
  useEffect(() => {
    (async () => {
      const s = await charger();
      if (!s) return;
      // Le locataire d'abord ; l'OMH si la part du locataire est payée
      choisirPayeur(partOmh(s) > 0 && soldeLocataire(s) <= 0 && soldeOmh(s) > 0 ? "omh" : "locataire", s);
    })();
  }, [charger]);

  /** Préremplit le nouveau paiement avec ce qui reste à payer par ce payeur */
  function choisirPayeur(qui: Payeur, s: Solde) {
    setPayeur(qui);
    setMontantSaisi(centsVersSaisie(Math.max(qui === "omh" ? soldeOmh(s) : soldeLocataire(s), 0)));
    setMode(qui === "omh" ? "depot_direct" : s.mode_paiement === "credit" || s.mode_paiement === "depot_direct" ? "interac" : s.mode_paiement);
  }

  async function apresChangement() {
    const s = await charger();
    if (s) {
      const qui: Payeur = payeur === "locataire" && soldeLocataire(s) <= 0 && soldeOmh(s) > 0 ? "omh"
        : payeur === "omh" && soldeOmh(s) <= 0 && soldeLocataire(s) > 0 ? "locataire" : payeur;
      choisirPayeur(partOmh(s) > 0 ? qui : "locataire", s);
    }
    await onChange();
  }

  const credits = new Map<string, number>();
  for (const p of paiementsBail) {
    if (p.mode === "credit" && p.statut === "recu") credits.set(p.echeance_id, (credits.get(p.echeance_id) ?? 0) + p.montant_cents);
  }
  /** Total et nombre de mois d'un dépôt */
  function infoDepot(depotId: string) {
    const parts = paiementsBail.filter((p) => p.depot_id === depotId);
    return { total: parts.reduce((t, p) => t + p.montant_cents, 0), nbMois: new Set(parts.map((p) => p.echeance_id)).size };
  }
  /** Ce qui reste dû ce mois-ci par ce payeur, sans compter un paiement donné */
  function resteDuSans(paiementId: string | null, qui: Payeur): number {
    if (!choisie) return 0;
    const autres = paiements.filter((p) => p.id !== paiementId && p.mode !== "credit" && p.statut === "recu" && payeurDe(p) === qui)
      .reduce((t, p) => t + p.montant_cents, 0);
    return Math.max(0, duPar(qui, { ...choisie, omh_cents: partOmh(choisie) }, credits) - autres);
  }
  const avecOmh = !!choisie && partOmh(choisie) > 0;

  /** Ouvre le formulaire de dépôt ; on part de ce mois et on ajoute les mois d'avant (puis d'après) jusqu'à couvrir le montant */
  function ouvrirDepot(depuis: Paiement | null, montantCents: number | null, mode: Mode, date: string, ref: string, qui: Payeur) {
    if (!choisie) return;
    setErreur(null);
    setDepotDe(depuis);
    setDpPayeur(qui);
    setDpMontant(montantCents ? centsVersSaisie(montantCents) : "");
    setDpMode(modesDe(qui).some((m) => m.code === mode) ? mode : modesDe(qui)[0].code);
    setDpDate(date || aujourdhuiIso());
    setDpReference(ref);
    const i = moisBail.findIndex((m) => m.echeance_id === choisie.echeance_id);
    if (i < 0) return setErreur("Les mois du bail ne sont pas encore chargés. Réessaie.");
    const dus = (m: MoisBail) => duPar(qui, m, credits);
    const choisis = [moisBail[i]];
    let couvert = dus(moisBail[i]);
    // Si on part d'un dépôt existant, on reprend ses mois
    const ancien = depuis?.depot_id ? paiementsBail.filter((p) => p.depot_id === depuis.depot_id).map((p) => p.echeance_id) : [];
    if (ancien.length) {
      setDpMois(moisBail.filter((m) => ancien.includes(m.echeance_id) || m.echeance_id === choisie.echeance_id).map((m) => m.echeance_id));
    } else {
      // v0.9.12 : seulement les mois qui ne sont pas déjà payés par ce payeur
      const paye = (m: MoisBail) => paiementsBail.filter((p) => p.echeance_id === m.echeance_id && p.mode !== "credit"
        && p.statut === "recu" && payeurDe(p) === qui).reduce((t, p) => t + p.montant_cents, 0);
      const aPayer = (m: MoisBail) => dus(m) > paye(m);
      for (let k = i - 1; montantCents && couvert < montantCents && k >= 0; k--) {
        if (aPayer(moisBail[k])) { choisis.unshift(moisBail[k]); couvert += dus(moisBail[k]); }
      }
      for (let k = i + 1; montantCents && couvert < montantCents && k < moisBail.length; k++) {
        if (aPayer(moisBail[k])) { choisis.push(moisBail[k]); couvert += dus(moisBail[k]); }
      }
      setDpMois(choisis.filter(Boolean).map((m) => m.echeance_id));
    }
    setOuvert(null);
    setDepotOuvert(true);
  }

  async function enregistrerDepot() {
    if (!choisie) return;
    const cents = versCents(dpMontant);
    if (cents === null || cents <= 0) return setErreur("Entre le montant du dépôt (ex. 2 589,00).");
    if (dpMois.length === 0) return setErreur("Choisis au moins un mois.");
    if (!dpDate) return setErreur("Entre la date du dépôt.");
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.rpc("repartir_depot", {
      p: {
        bail_id: choisie.bail_id, echeance_ids: dpMois, montant_cents: cents, mode: dpMode,
        date_recue: dpDate, reference: dpReference.trim(), paiement_id: depotDe?.id ?? null,
        ...(avecOmh ? { payeur: dpPayeur } : {}),
      },
    });
    setEnvoi(false);
    if (error) return setErreur(error.message.includes("repartir_depot")
      ? "La mise à jour de la base (021) n'est pas encore faite. Demande à Loïc." : messageOmh(error.message, "payeur"));
    setDepotOuvert(false);
    setDepotDe(null);
    await apresChangement();
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
      ...(avecOmh ? { payeur } : {}),
    });
    setEnvoi(false);
    if (error) return setErreur(messageOmh(error.message, "payeur"));
    // Mois avec l'OMH : on garde la feuille ouverte s'il reste l'autre part à inscrire
    if (avecOmh) {
      const s = await charger();
      await onChange();
      if (s && resteARecevoir(s) > 0) {
        choisirPayeur(soldeLocataire(s) > 0 ? "locataire" : "omh", s);
        setReference("");
        return;
      }
      return onFermer();
    }
    await onChange();
    onFermer();
  }

  async function enregistrerCredit() {
    if (!choisie) return;
    const cents = versCents(montantCredit);
    if (cents === null || cents <= 0) return setErreur("Entre le montant du crédit (ex. 150,00).");
    if (!raisonCredit.trim()) return setErreur("Indique la raison du crédit (ex. porte achetée par le locataire).");
    if (cents > soldeLocataire(choisie) && !window.confirm(
      `Le crédit (${formatCents(cents)}) dépasse ce que le locataire doit ce mois-ci (${formatCents(soldeLocataire(choisie))}). Continuer ?`
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
    setEdPayeur(payeurDe(p));
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
      ...(avecOmh && !credit ? { payeur: edPayeur } : {}),
    }).eq("id", ouvert.id);
    setEnvoi(false);
    if (error) return setErreur(messageOmh(error.message, "payeur"));
    setOuvert(null);
    await apresChangement();
  }

  async function annulerPaiement(p: Paiement) {
    if (p.depot_id) {
      const { total, nbMois } = infoDepot(p.depot_id);
      if (!window.confirm(`Annuler tout le dépôt de ${formatCents(total)} (${nbMois} mois) ? (erreur de saisie)`)) return;
      setEnvoi(true);
      const { error } = await supabase.rpc("annuler_depot", { p_depot: p.depot_id });
      setEnvoi(false);
      if (error) return setErreur(error.message);
      setOuvert(null);
      return apresChangement();
    }
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
        ) : depotOuvert ? (
          /* Un dépôt qui paie plusieurs mois (v0.9.10) */
          (() => {
            const cents = versCents(dpMontant) ?? 0;
            const choisis = moisBail.filter((m) => dpMois.includes(m.echeance_id));
            const parts = repartition(cents, choisis, credits, dpPayeur);
            const couvert = parts.reduce((t, x) => t + x.du, 0);
            const remplaces = paiementsBail.filter((p) => dpMois.includes(p.echeance_id) && p.mode !== "credit" && payeurDe(p) === dpPayeur
              && !(depotDe && (p.id === depotDe.id || (depotDe.depot_id && p.depot_id === depotDe.depot_id))));
            return (
              <>
                <div className="entete" style={{ marginBottom: 4 }}>
                  <strong>{avecOmh && dpPayeur === "omh" ? "Dépôt de l'OMH pour plusieurs mois" : "Dépôt pour plusieurs mois"}</strong>
                  <button className="lien-retirer" style={{ color: "var(--discret)" }} onClick={() => { setErreur(null); setDepotOuvert(false); }}>Retour</button>
                </div>
                <div className="aide" style={{ marginTop: 0 }}>{choisie.immeuble} · {choisie.logement} · {choisie.locataires}</div>
                {erreur && <div className="message erreur">{erreur}</div>}

                <label htmlFor="dp-montant">Montant du dépôt</label>
                <input id="dp-montant" className="montant-total" inputMode="decimal" placeholder="ex. 2 589,00" value={dpMontant} onChange={(e) => setDpMontant(e.target.value)} />
                {avecOmh && (
                  <ChoixPayeur payeur={dpPayeur} onChoisir={(q) => { setDpPayeur(q); setDpMode(modesDe(q)[0].code); }} />
                )}
                <div className="choix-2" style={{ marginTop: 8 }}>
                  {modesDe(dpPayeur).map((m) => (
                    <button key={m.code} type="button" className={dpMode === m.code ? "actif" : ""} onClick={() => setDpMode(m.code)}>{m.libelle}</button>
                  ))}
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input type="date" value={dpDate} onChange={(e) => setDpDate(e.target.value)} aria-label="Date du dépôt" />
                  <input placeholder="No chèque / virement" value={dpReference} onChange={(e) => setDpReference(e.target.value)} />
                </div>

                <label>Mois payés par ce dépôt</label>
                <div className="puces" style={{ marginTop: 0 }}>
                  {moisBail.map((m) => {
                    const actif = dpMois.includes(m.echeance_id);
                    return (
                      <span key={m.echeance_id} className={`puce${actif ? " actif" : ""}`}>
                        <button type="button" aria-pressed={actif} style={{ textTransform: "capitalize" }}
                                onClick={() => setDpMois((a) => (actif ? a.filter((x) => x !== m.echeance_id) : [...a, m.echeance_id]))}>
                          {moisLisible(m.mois)}
                        </button>
                      </span>
                    );
                  })}
                </div>

                {parts.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    {parts.map(({ m, part, du }) => (
                      <div className="paiement-ligne" key={m.echeance_id}>
                        <span style={{ textTransform: "capitalize" }}>{moisLisible(m.mois)}</span>
                        <span>
                          {formatCents(part)}
                          {part < du && <span className="pastille" style={{ marginLeft: 6 }}>Partiel</span>}
                          {part > du && <span className="pastille" style={{ marginLeft: 6 }}>Trop-payé {formatCents(part - du)}</span>}
                        </span>
                      </div>
                    ))}
                    <p className="aide" style={{ marginTop: 4 }}>
                      {cents === couvert ? "Le dépôt couvre exactement ces mois."
                        : cents < couvert ? `Il manque ${formatCents(couvert - cents)} pour couvrir ces mois.`
                        : `C'est ${formatCents(cents - couvert)} de plus que ces mois : ajoute un mois ou garde le trop-payé.`}
                    </p>
                  </div>
                )}
                {remplaces.length > 0 && (
                  <p className="aide">
                    Remplace {remplaces.length === 1 ? "le paiement déjà inscrit" : `les ${remplaces.length} paiements déjà inscrits`} sur ces mois
                    ({remplaces.map((p) => formatCents(p.montant_cents)).join(", ")}). Les crédits restent.
                  </p>
                )}

                <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={enregistrerDepot} disabled={envoi}>
                  {envoi ? "Enregistrement…" : "Enregistrer le dépôt"}
                </button>
              </>
            );
          })()
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
            {ouvert.depot_id && (() => {
              const { total, nbMois } = infoDepot(ouvert.depot_id);
              return (
                <div className="message alerte">
                  Part d&apos;un dépôt de {formatCents(total)} réparti sur {nbMois} mois.{" "}
                  <button className="lien-retirer" style={{ color: "var(--accent)" }}
                          onClick={() => ouvrirDepot(ouvert, total, ouvert.mode, ouvert.date_recue ?? "", ouvert.reference ?? "", payeurDe(ouvert))}>
                    Modifier le dépôt
                  </button>
                </div>
              );
            })()}
            {erreur && <div className="message erreur">{erreur}</div>}

            <label htmlFor="ed-montant">{ouvert.mode === "credit" ? "Montant du crédit" : "Montant"}</label>
            <input id="ed-montant" className="montant-total" inputMode="decimal" value={edMontant} onChange={(e) => setEdMontant(e.target.value)} />
            {ouvert.mode !== "credit" && (versCents(edMontant) ?? 0) > resteDuSans(ouvert.id, edPayeur) && (
              <AvisPlusieursMois du={resteDuSans(ouvert.id, edPayeur)}
                onRepartir={() => ouvrirDepot(ouvert, versCents(edMontant), edMode, edDateRecue, edReference, edPayeur)} />
            )}

            {ouvert.mode === "credit" ? (
              <>
                <label htmlFor="ed-raison">Raison</label>
                <input id="ed-raison" value={edNotes} onChange={(e) => setEdNotes(e.target.value)} />
                <label htmlFor="ed-date">Date</label>
                <input id="ed-date" type="date" value={edDateRecue} onChange={(e) => setEdDateRecue(e.target.value)} />
              </>
            ) : (
              <>
                {avecOmh && (
                  <>
                    <label>Payé par</label>
                    <ChoixPayeur payeur={edPayeur} onChoisir={(q) => { setEdPayeur(q); if (!modesDe(q).some((m) => m.code === edMode)) setEdMode(modesDe(q)[0].code); }} />
                  </>
                )}
                <label>Mode</label>
                <div className="choix-2">
                  {modesDe(edPayeur).map((m) => (
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
              {ouvert.mode === "credit" ? "Annuler ce crédit (erreur de saisie)"
                : ouvert.depot_id ? "Annuler tout le dépôt (erreur de saisie)" : "Annuler ce paiement (erreur de saisie)"}
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
            {avecOmh && (
              <div className="parts-omh">
                <div>
                  <span>Part du locataire</span>
                  <strong>{formatCents(choisie.montant_du_cents - partOmh(choisie))}</strong>
                  <EtatPart reste={soldeLocataire(choisie)} />
                </div>
                <div>
                  <span>Part de l&apos;OMH</span>
                  <strong>{formatCents(partOmh(choisie))}</strong>
                  <EtatPart reste={soldeOmh(choisie)} />
                </div>
              </div>
            )}
            {choisie.extras_cents !== 0 && (
              <div className="aide" style={{ marginTop: 2 }}>
                Loyer {formatCents(choisie.loyer_cents)} · extras {formatCents(choisie.extras_cents)}
              </div>
            )}
            {noteMois && <div className="aide" style={{ marginTop: 2 }}>{noteMois}</div>}
            {erreur && <div className="message erreur">{erreur}</div>}

            {choisie.jours_retard > 0 && choisie.telephone && soldeLocataire(choisie) > 0 && (
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
                      {avecOmh && payeurDe(p) === "omh" && <span className="pastille omh" style={{ marginRight: 6 }}>OMH</span>}
                      {formatCents(p.montant_cents)} · {libelleMode(p.mode)}
                      {p.date_recue ? ` · ${dateLisible(p.date_recue)}` : p.date_prevue ? ` · ${dateLisible(p.date_prevue)}` : ""}
                      {p.reference ? ` · ${p.reference}` : ""}
                      {p.statut !== "recu" && <span className={`pastille${p.statut === "sans_provision" ? " vacant" : ""}`} style={{ marginLeft: 6 }}>{libelleStatut(p.statut)}</span>}
                      {p.depot_id ? <span className="aide" style={{ display: "block", margin: 0 }}>
                        Part d&apos;un dépôt de {formatCents(infoDepot(p.depot_id).total)} ({infoDepot(p.depot_id).nbMois} mois)
                      </span> : null}
                      {p.notes ? <span className="aide" style={{ display: "block", margin: 0 }}>{p.notes}</span> : null}
                    </span>
                    <span className="lien-modifier">Détail ›</span>
                  </button>
                ))}
                <p className="aide" style={{ marginTop: 4 }}>Touche un paiement pour le voir ou le modifier.</p>
              </div>
            )}

            {resteARecevoir(choisie) > 0 ? (
              <>
                {avecOmh && (
                  <>
                    <label>Paiement reçu de</label>
                    <ChoixPayeur payeur={payeur} onChoisir={(q) => choisirPayeur(q, choisie)}
                                 restes={{ locataire: soldeLocataire(choisie), omh: soldeOmh(choisie) }} />
                  </>
                )}
                <label htmlFor="montant">Montant reçu</label>
                <input id="montant" className="montant-total" inputMode="decimal" value={montantSaisi} onChange={(e) => setMontantSaisi(e.target.value)} />
                {(versCents(montantSaisi) ?? 0) > resteDuSans(null, payeur) && (
                  <AvisPlusieursMois du={resteDuSans(null, payeur)}
                    onRepartir={() => ouvrirDepot(null, versCents(montantSaisi), mode, dateRecue, reference, payeur)} />
                )}
                <div className="choix-2" style={{ marginTop: 8 }}>
                  {modesDe(payeur).map((m) => (
                    <button key={m.code} type="button" className={mode === m.code ? "actif" : ""} onClick={() => setMode(m.code)}>{m.libelle}</button>
                  ))}
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input type="date" value={dateRecue} onChange={(e) => setDateRecue(e.target.value)} aria-label="Date reçue" />
                  <input placeholder="No chèque / virement" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={enregistrerPaiement} disabled={envoi}>
                  {envoi ? "Enregistrement…"
                    : versCents(montantSaisi) === resteDuSans(null, payeur) ? (avecOmh ? (payeur === "omh" ? "Reçu de l'OMH" : "Reçu du locataire") : "Reçu")
                    : "Enregistrer ce montant"}
                </button>

                <button className="lien-filtres" style={{ margin: "10px auto 0" }}
                        onClick={() => ouvrirDepot(null, versCents(montantSaisi), mode, dateRecue, reference, payeur)}>
                  + Un dépôt pour plusieurs mois
                </button>
                {!creditOuvert ? (
                  <button className="lien-filtres" style={{ margin: "4px auto 0" }} onClick={() => setCreditOuvert(true)}>
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
              <>
                <p className="aide" style={{ color: "var(--succes)", fontWeight: 600 }}>Ce loyer est payé.</p>
                {choisie.solde_cents < 0 && (
                  // v0.9.13 : un trop-payé ne doit pas passer inaperçu (ex. extra ajouté après coup)
                  <div className="message alerte" style={{ marginTop: 4 }}>
                    Trop-payé de {formatCents(-choisie.solde_cents)} ce mois-ci : il a été reçu{" "}
                    {formatCents(choisie.recu_cents)} pour {formatCents(choisie.montant_du_cents)} dû.
                    Si c&apos;est une erreur, touche le paiement pour corriger son montant.
                  </div>
                )}
                <button className="lien-filtres" style={{ margin: "4px auto 0" }}
                        onClick={() => ouvrirDepot(null, null, choisie.mode_paiement, aujourdhuiIso(), "", "locataire")}>
                  + Un dépôt pour plusieurs mois
                </button>
              </>
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

/** Locataire ou OMH (v0.9.12), avec ce qui reste à payer par chacun */
function ChoixPayeur({ payeur, onChoisir, restes }: { payeur: Payeur; onChoisir: (p: Payeur) => void; restes?: Record<Payeur, number> }) {
  const reste = (q: Payeur) => (restes ? (restes[q] > 0 ? ` · ${formatCents(restes[q])}` : " · payé") : "");
  return (
    <div className="choix-2" style={{ marginTop: 0 }}>
      <button type="button" className={payeur === "locataire" ? "actif" : ""} onClick={() => onChoisir("locataire")}>Locataire{reste("locataire")}</button>
      <button type="button" className={payeur === "omh" ? "actif" : ""} onClick={() => onChoisir("omh")}>OMH{reste("omh")}</button>
    </div>
  );
}

/** État d'une part du mois : payée, ou ce qui reste */
function EtatPart({ reste }: { reste: number }) {
  return reste <= 0
    ? <span className="pastille ok">{reste < 0 ? `Payé (+${formatCents(-reste)})` : "Payé"}</span>
    : <span className="pastille gris">Reste {formatCents(reste)}</span>;
}

/** Montant plus grand que ce qui reste dû ce mois-ci : proposer de répartir (v0.9.10) */
function AvisPlusieursMois({ du, onRepartir }: { du: number; onRepartir: () => void }) {
  return (
    <div className="message alerte" style={{ marginTop: 8 }}>
      C&apos;est plus que ce qui reste à payer ce mois-ci ({formatCents(du)}). Si ce dépôt paie plusieurs mois,{" "}
      <button className="lien-retirer" style={{ color: "var(--accent)", fontWeight: 600 }} onClick={onRepartir}>
        répartis-le sur plusieurs mois
      </button>.
    </div>
  );
}
