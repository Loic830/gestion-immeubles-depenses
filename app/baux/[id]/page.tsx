"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { DOCUMENTS_BAIL } from "@/lib/documents";
import DocumentsBail from "@/components/DocumentsBail";
import FeuilleLoyer from "@/components/FeuilleLoyer";
import { nouveauLocataire, type LocataireForm } from "@/components/FormulaireBail";
import { LIBELLE_ORIGINE, TITRE_COPIE, type OrigineBail } from "@/lib/baux";
import { formatCents, versCents, centsVersSaisie } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, moisLisible, lendemain, veille, finDuMois, finBail, moisEchus } from "@/lib/dates";

type Bail = {
  id: string;
  statut: "a_venir" | "actif" | "termine";
  logement: string;
  logement_id: string;
  immeuble: string;
  date_debut: string;
  date_fin: string | null;
  date_depart: string | null;
  loyer_cents: number;
  extras_cents: number;
  jour_echeance: number;
  mode_paiement: "interac" | "cheque" | "prelevement" | "comptant";
  inclusions: string | null;
  notes: string | null;
  avis_du: string | null;
  avis_au: string | null;
  date_avis_envoye: string | null;
  reponse: string | null;
  origine: OrigineBail;
  bail_precedent_id: string | null;
};
type Locataire = { principal: boolean; locataire: { prenom: string; nom: string; telephone: string | null; courriel: string | null } };
type Extra = { id: string; libelle: string; montant_cents: number };
type Solde = { echeance_id: string; mois: string; loyer_cents: number; montant_du_cents: number; recu_cents: number; en_main_cents: number; solde_cents: number; jours_retard: number };
type Changement = { id: string; date_effet: string; ancien_loyer_cents: number; nouveau_loyer_cents: number; raison: string | null; created_at: string };
type FinBail = { date_depart: string; forfait_cents: number; raison: string | null };
type AutreBail = { id: string; statut: "a_venir" | "actif" | "termine"; date_debut: string; date_fin: string | null; date_depart: string | null; locataires: string | null; origine: OrigineBail; bail_precedent_id: string | null };
type Credit = { id: string; echeance_id: string; montant_cents: number; notes: string | null };

const LIBELLE_MODE = { interac: "Virement Interac", cheque: "Chèques postdatés", prelevement: "Prélèvement automatique", comptant: "Comptant" };
const LIBELLE_STATUT = { a_venir: "À venir", actif: "Actif", termine: "Terminé" };

export default function DetailBail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session, pret } = useSession();

  const [bail, setBail] = useState<Bail | null>(null);
  const [locataires, setLocataires] = useState<Locataire[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [soldes, setSoldes] = useState<Solde[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [suppression, setSuppression] = useState(false);
  const [changements, setChangements] = useState<Changement[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  // Mois de loyer ouvert (v0.9.7) : détail et modification des paiements
  const [moisOuvert, setMoisOuvert] = useState<string | null>(null);
  // Formulaire « Modifier le prix du loyer »
  const [changementOuvert, setChangementOuvert] = useState(false);
  const [nouveauLoyer, setNouveauLoyer] = useState("");
  const [moisEffet, setMoisEffet] = useState("");
  const [raison, setRaison] = useState("");
  const [envoiChangement, setEnvoiChangement] = useState(false);
  // Fin de bail (départ du locataire)
  const [fin, setFin] = useState<FinBail | null>(null);
  const [autresBaux, setAutresBaux] = useState<AutreBail[]>([]);
  const [finOuverte, setFinOuverte] = useState(false);
  const [dateDepart, setDateDepart] = useState("");
  const [forfait, setForfait] = useState("");
  const [raisonFin, setRaisonFin] = useState("");
  const [envoiFin, setEnvoiFin] = useState(false);
  // Renouveler le bail (nouveau bail qui suit celui-ci)
  const [renouvOuvert, setRenouvOuvert] = useState(false);
  const [renouvLoyer, setRenouvLoyer] = useState("");
  const [renouvDebut, setRenouvDebut] = useState("");
  const [renouvMois, setRenouvMois] = useState("12");
  const [envoiRenouv, setEnvoiRenouv] = useState(false);
  // v0.9.6 : renouvellement dans le passé (historique) → mois déjà payés
  const [renouvPayes, setRenouvPayes] = useState(true);
  const [renouvExclus, setRenouvExclus] = useState<string[]>([]);
  const [envoiLien, setEnvoiLien] = useState(false);
  // Céder le bail (v0.9.5) : le bail continue au nom d'un nouveau locataire
  const [cessionOuverte, setCessionOuverte] = useState(false);
  const [cessionMois, setCessionMois] = useState("");
  const [cessionnaires, setCessionnaires] = useState<LocataireForm[]>([]);
  const [envoiCession, setEnvoiCession] = useState(false);
  // v0.9.9 : cession dans le passé (historique) → mois déjà payés par le nouveau locataire
  const [cessionPayes, setCessionPayes] = useState(true);
  const [cessionExclus, setCessionExclus] = useState<string[]>([]);

  const charger = useCallback(async () => {
    if (!id) return;
    {
      const [b, lo, ex, so, ch, fi] = await Promise.all([
        supabase.from("v_baux").select("*").eq("id", id).single(),
        supabase.from("bail_locataires").select("principal, locataire:locataires(prenom, nom, telephone, courriel)").eq("bail_id", id),
        supabase.from("bail_extras").select("id, libelle, montant_cents").eq("bail_id", id),
        supabase.from("v_soldes").select("echeance_id, mois, loyer_cents, montant_du_cents, recu_cents, en_main_cents, solde_cents, jours_retard").eq("bail_id", id).order("mois"),
        supabase.from("changements_loyer").select("id, date_effet, ancien_loyer_cents, nouveau_loyer_cents, raison, created_at").eq("bail_id", id).order("created_at"),
        supabase.from("fins_bail").select("date_depart, forfait_cents, raison").eq("bail_id", id).maybeSingle(),
      ]);
      if (b.error || !b.data) { setErreur("Bail introuvable ou supprimé."); return; }
      const leBail = b.data as Bail;
      setBail(leBail);
      setFin((fi.data ?? null) as FinBail | null);
      // Historique du logement : les autres baux (anciens et à venir)
      const { data: au } = await supabase.from("v_baux")
        .select("id, statut, date_debut, date_fin, date_depart, locataires, origine, bail_precedent_id")
        .eq("logement_id", leBail.logement_id).neq("id", leBail.id).order("date_debut", { ascending: false });
      setAutresBaux((au ?? []) as AutreBail[]);
      setLocataires(((lo.data ?? []) as unknown as Locataire[]).sort((x, y) => Number(y.principal) - Number(x.principal)));
      setExtras((ex.data ?? []) as Extra[]);
      const listeSoldes = (so.data ?? []) as Solde[];
      setSoldes(listeSoldes);
      setChangements((ch.data ?? []) as Changement[]);
      if (listeSoldes.length) {
        const { data: cr } = await supabase.from("paiements")
          .select("id, echeance_id, montant_cents, notes")
          .in("echeance_id", listeSoldes.map((x) => x.echeance_id))
          .eq("mode", "credit").is("deleted_at", null);
        setCredits((cr ?? []) as Credit[]);
      }
    }
  }, [id]);

  useEffect(() => {
    if (session && id) charger();
  }, [session, id, charger]);

  function ouvrirChangement() {
    const debutMois = aujourdhuiIso().slice(0, 7) + "-01";
    const futurs = soldes.filter((s) => s.mois >= debutMois);
    // Par défaut : le mois prochain (le mois courant est souvent déjà payé)
    setMoisEffet(futurs[1]?.mois ?? futurs[0]?.mois ?? "");
    setNouveauLoyer(bail ? centsVersSaisie(bail.loyer_cents) : "");
    setRaison("");
    setChangementOuvert(true);
  }

  function ouvrirRenouvellement() {
    if (!bail?.date_fin) return;
    // Prix par défaut : le loyer du dernier mois du bail (hausses comprises)
    setRenouvLoyer(centsVersSaisie(soldes[soldes.length - 1]?.loyer_cents ?? bail.loyer_cents));
    setRenouvDebut(lendemain(bail.date_fin));
    setRenouvMois("12");
    setRenouvPayes(true);
    setRenouvExclus([]);
    setRenouvOuvert(true);
  }

  // Bail qui suit celui-ci dans le logement (v0.9.6) : son renouvellement (ou sa cession),
  // sinon le prochain bail après sa fin, s'il y en a un.
  const suiteDuBail = bail ? autresBaux.find((a) => a.bail_precedent_id === bail.id) ?? null : null;
  const prochainBail = bail?.date_fin
    ? autresBaux.filter((a) => a.date_debut > (bail.date_fin ?? "")).sort((x, y) => x.date_debut.localeCompare(y.date_debut))[0] ?? null
    : null;
  // Fin du nouveau bail : la durée choisie, sans dépasser la veille du bail suivant
  const finRenouvellement = (() => {
    if (!renouvDebut || !(Number(renouvMois) >= 1)) return null;
    const fin = finBail(renouvDebut, Number(renouvMois));
    return prochainBail && fin >= prochainBail.date_debut ? veille(prochainBail.date_debut) : fin;
  })();
  const renouvPasses = renouvOuvert && bail ? moisEchus(renouvDebut, finRenouvellement, bail.jour_echeance) : [];
  const renouvAPayer = renouvPayes ? renouvPasses.filter((m) => !renouvExclus.includes(m)) : [];

  async function lierAuSuivant() {
    if (!bail || !prochainBail) return;
    if (!window.confirm(
      `Le bail du ${dateLisible(prochainBail.date_debut)} (${prochainBail.locataires ?? "locataire"}) devient le renouvellement de ce bail. ` +
      "Le dossier prêteur joindra les deux copies."
    )) return;
    setErreur(null);
    setEnvoiLien(true);
    const { error } = await supabase.rpc("lier_renouvellement", { p_bail: bail.id, p_suivant: prochainBail.id });
    setEnvoiLien(false);
    if (error) return setErreur(error.message);
    charger();
  }

  async function enregistrerRenouvellement() {
    if (!bail) return;
    const cents = versCents(renouvLoyer);
    if (cents === null || cents < 0) return setErreur("Entre le prix du nouveau loyer (ex. 975,00).");
    if (!renouvDebut) return setErreur("Entre la date de début du nouveau bail.");
    const mois = Number(renouvMois);
    if (!Number.isInteger(mois) || mois < 1 || mois > 120) return setErreur("Entre une durée en mois (ex. 12).");
    const finNouveau = finRenouvellement ?? finBail(renouvDebut, mois);
    if (prochainBail && renouvDebut >= prochainBail.date_debut) {
      return setErreur(`Le bail suivant commence le ${dateLisible(prochainBail.date_debut)} : le renouvellement doit commencer avant.`);
    }
    if (!window.confirm(
      `Nouveau bail du ${dateLisible(renouvDebut)} au ${dateLisible(finNouveau)} à ${formatCents(cents)} par mois` +
      (bail.extras_cents ? ` (plus ${formatCents(bail.extras_cents)} d'extras et crédits, gardés)` : "") +
      ". Mêmes locataires, même mode et même jour de paiement." +
      (renouvAPayer.length ? ` ${renouvAPayer.length} mois passé${renouvAPayer.length > 1 ? "s" : ""} marqué${renouvAPayer.length > 1 ? "s" : ""} payé${renouvAPayer.length > 1 ? "s" : ""}.` : "")
    )) return;
    setErreur(null);
    setEnvoiRenouv(true);
    const { data: nouveauId, error } = await supabase.rpc("renouveler_bail", {
      p_bail: bail.id, p_date_debut: renouvDebut, p_date_fin: finNouveau, p_loyer_cents: cents,
      p_mois_payes: renouvAPayer,
    });
    setEnvoiRenouv(false);
    if (error) return setErreur(error.message);
    setRenouvOuvert(false);
    router.push(`/baux/${nouveauId}`);
  }

  function ouvrirCession() {
    const debutMois = aujourdhuiIso().slice(0, 7) + "-01";
    const possibles = soldes.filter((s) => s.mois > (bail?.date_debut ?? ""));
    // Par défaut : le mois prochain
    setCessionMois(possibles.find((s) => s.mois > debutMois)?.mois ?? possibles[possibles.length - 1]?.mois ?? "");
    setCessionnaires([nouveauLocataire()]);
    setCessionPayes(true);
    setCessionExclus([]);
    setCessionOuverte(true);
  }

  // Mois du nouveau bail déjà échus (cession dans le passé)
  const cessionPasses = cessionOuverte && bail && cessionMois ? moisEchus(cessionMois, bail.date_fin, bail.jour_echeance) : [];
  const cessionAPayer = cessionPayes ? cessionPasses.filter((m) => !cessionExclus.includes(m)) : [];

  async function enregistrerCession() {
    if (!bail) return;
    if (!cessionMois) return setErreur("Choisis le mois où le nouveau locataire prend le bail.");
    const remplis = cessionnaires.filter((l) => l.prenom.trim() || l.nom.trim());
    if (remplis.length === 0 || remplis.some((l) => !l.prenom.trim() || !l.nom.trim())) {
      return setErreur("Entre le prénom et le nom du nouveau locataire.");
    }
    const noms = remplis.map((l) => `${l.prenom.trim()} ${l.nom.trim()}`).join(", ");
    const loyer = soldes.find((s) => s.mois === cessionMois);
    if (!window.confirm(
      `Le bail de ${bail.date_fin ? `jusqu'au ${dateLisible(bail.date_fin)}` : "durée indéterminée"} passe à ${noms} le ${dateLisible(cessionMois)}` +
      (loyer ? `, au même loyer (${formatCents(loyer.montant_du_cents)} par mois)` : "") +
      `. Le bail actuel se termine le ${dateLisible(veille(cessionMois))} ; ` +
      "les mois avant la cession et leurs paiements restent à son nom." +
      (cessionAPayer.length ? ` ${cessionAPayer.length} mois passé${cessionAPayer.length > 1 ? "s" : ""} du nouveau locataire marqué${cessionAPayer.length > 1 ? "s" : ""} payé${cessionAPayer.length > 1 ? "s" : ""}.` : "")
    )) return;
    setErreur(null);
    setEnvoiCession(true);
    const { data: nouveauId, error } = await supabase.rpc("ceder_bail", {
      p_bail: bail.id, p_date: cessionMois,
      p_locataires: remplis.map((l) => ({
        prenom: l.prenom.trim(), nom: l.nom.trim(), telephone: l.telephone.trim() || null, courriel: l.courriel.trim() || null,
      })),
      p_mois_payes: cessionAPayer,
    });
    setEnvoiCession(false);
    if (error) return setErreur(error.message);
    setCessionOuverte(false);
    router.push(`/baux/${nouveauId}`);
  }

  function ouvrirFin() {
    setDateDepart(finDuMois(aujourdhuiIso()));
    setForfait("");
    setRaisonFin("");
    setFinOuverte(true);
  }

  async function enregistrerFin() {
    if (!bail) return;
    if (!dateDepart) return setErreur("Entre la date de départ du locataire.");
    const forfaitCents = forfait.trim() ? versCents(forfait) : 0;
    if (forfaitCents === null || forfaitCents < 0) return setErreur("Entre un montant forfaitaire valide (ex. 1 900,00) ou laisse vide.");
    const dernierMois = dateDepart.slice(0, 7) + "-01";
    const retires = soldes.filter((s) => s.mois > dernierMois).length;
    if (!window.confirm(
      `Départ le ${dateLisible(dateDepart)}.` +
      (retires ? ` Les ${retires} loyer(s) prévus après ${moisLisible(dernierMois)} seront retirés.` : "") +
      (forfaitCents ? ` Le montant forfaitaire de ${formatCents(forfaitCents)} s'ajoute à ${moisLisible(dernierMois)}.` : "") +
      " Les mois passés et les paiements restent dans l'historique."
    )) return;
    setErreur(null);
    setEnvoiFin(true);
    const { error } = await supabase.rpc("terminer_bail", {
      p_bail: bail.id, p_date_depart: dateDepart, p_forfait_cents: forfaitCents, p_raison: raisonFin.trim() || null,
    });
    setEnvoiFin(false);
    if (error) return setErreur(error.message);
    setFinOuverte(false);
    await charger();
  }

  async function annulerFin() {
    if (!bail || !window.confirm("Annuler la fin de ce bail ? (erreur de saisie) Les loyers prévus jusqu'à la fin du bail seront remis.")) return;
    setErreur(null);
    const { error } = await supabase.rpc("annuler_fin_bail", { p_bail: bail.id });
    if (error) return setErreur(error.message);
    await charger();
  }

  async function enregistrerChangement() {
    if (!bail) return;
    const cents = versCents(nouveauLoyer);
    if (cents === null || cents < 0) return setErreur("Entre un loyer valide (ex. 950,00).");
    if (!moisEffet) return setErreur("Choisis le mois du nouveau loyer.");
    const ancien = soldes.find((s) => s.mois === moisEffet)?.loyer_cents ?? bail.loyer_cents;
    const nb = soldes.filter((s) => s.mois >= moisEffet).length;
    if (!window.confirm(
      `Le loyer passera de ${formatCents(ancien)} à ${formatCents(cents)} à partir de ${moisLisible(moisEffet)} (${nb} mois). ` +
      "Les mois précédents et les paiements déjà reçus ne changent pas."
    )) return;
    setErreur(null);
    setEnvoiChangement(true);
    const { error } = await supabase.rpc("changer_loyer", {
      p_bail: bail.id, p_date_effet: moisEffet, p_nouveau_cents: cents, p_raison: raison.trim() || null,
    });
    setEnvoiChangement(false);
    if (error) return setErreur(error.message);
    setChangementOuvert(false);
    await charger();
  }

  async function supprimer() {
    if (!bail) return;
    const recus = soldes.some((s) => s.recu_cents > 0 || s.en_main_cents > 0);
    const message = recus
      ? "Ce bail a déjà des paiements. Le supprimer les retire aussi des totaux. Continuer seulement s'il s'agit d'une erreur de saisie."
      : "Supprimer ce bail ? (À utiliser pour corriger une erreur de saisie.)";
    if (!window.confirm(message)) return;
    setSuppression(true);
    const { error } = await supabase.from("baux").update({ deleted_at: new Date().toISOString() }).eq("id", bail.id);
    setSuppression(false);
    if (error) return setErreur(error.message);
    router.replace("/baux");
  }

  if (!pret || !session) return null;

  const auj = aujourdhuiIso();
  const totalDu = soldes.reduce((s, x) => s + x.montant_du_cents, 0);
  const totalRecu = soldes.reduce((s, x) => s + x.recu_cents, 0);
  const enRetard = soldes.filter((s) => s.jours_retard > 0);
  const moisCourant = auj.slice(0, 7) + "-01";
  const soldeCourant = soldes.find((s) => s.mois === moisCourant);
  const moisFuturs = soldes.filter((s) => s.mois >= moisCourant);
  const prochainChangement = changements
    .filter((c) => c.date_effet > moisCourant)
    .sort((a, b) => a.date_effet.localeCompare(b.date_effet))[0];

  return (
    <main className="page">
      <div className="entete">
        <h1>Bail</h1>
        <Link href="/baux" className="bouton">Retour</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}
      {!bail && !erreur && <p className="aide">Chargement…</p>}

      {bail && (
        <>
          <section className="carte">
            <div className="detail-sous" style={{ marginTop: 0 }}>{bail.immeuble} · logement {bail.logement}</div>
            <div className="detail-total">
              {formatCents(soldeCourant ? soldeCourant.montant_du_cents : bail.loyer_cents + bail.extras_cents)} <span className="aide">/ mois</span>
            </div>
            {prochainChangement && (
              <div className="aide" style={{ marginTop: 0 }}>
                Loyer de {formatCents(prochainChangement.nouveau_loyer_cents)} à partir de {moisLisible(prochainChangement.date_effet)}
              </div>
            )}
            <span className={`pastille ${bail.statut === "actif" ? "ok" : bail.statut === "termine" ? "gris" : ""}`}>{LIBELLE_STATUT[bail.statut]}</span>
            {bail.origine !== "nouveau" && <span className="pastille" style={{ marginLeft: 6 }}>{LIBELLE_ORIGINE[bail.origine]}</span>}
            {(() => {
              const precedent = autresBaux.find((a) => a.id === bail.bail_precedent_id);
              if (bail.origine === "nouveau" || !precedent) return null;
              return (
                <p className="aide" style={{ marginBottom: 0 }}>
                  {bail.origine === "cession" ? "Cession du bail de " : "Suite du bail de "}
                  <Link href={`/baux/${precedent.id}`}>{precedent.locataires ?? "l'ancien locataire"} ({dateLisible(precedent.date_debut)})</Link>
                </p>
              );
            })()}
            <div className="rangee" style={{ marginTop: 12 }}>
              <Link className="bouton" style={{ textAlign: "center" }} href={`/baux/${bail.id}/modifier`}>Modifier le bail</Link>
              <Link className="bouton" style={{ textAlign: "center" }} href={`/baux/logement/${bail.logement_id}`}>
                Historique ({autresBaux.length + 1})
              </Link>
            </div>
          </section>

          {enRetard.length > 0 && (
            <div className="message erreur">
              En retard : {formatCents(enRetard.reduce((s, x) => s + x.solde_cents, 0))}
              {" "}({enRetard.map((s) => moisLisible(s.mois)).join(", ")})
            </div>
          )}

          <section className="carte">
            <strong>Locataires</strong>
            {locataires.map((l, i) => (
              <div key={i} className={i > 0 ? "bloc-locataire" : ""} style={i === 0 ? { marginTop: 8 } : undefined}>
                <div style={{ fontWeight: 600 }}>
                  {l.locataire.prenom} {l.locataire.nom}
                  {l.principal && locataires.length > 1 && <span className="aide"> · principal</span>}
                </div>
                {l.locataire.courriel && <div className="aide" style={{ marginTop: 2 }}>{l.locataire.courriel}</div>}
                {l.locataire.telephone && (
                  <div className="liens-contact">
                    <a className="bouton" href={`tel:${l.locataire.telephone.replace(/[^\d+]/g, "")}`}>Appeler</a>
                    <a className="bouton" href={`sms:${l.locataire.telephone.replace(/[^\d+]/g, "")}`}>Texto</a>
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="carte">
            <dl className="champs">
              <dt>Début</dt><dd>{dateLisible(bail.date_debut)}</dd>
              <dt>Fin</dt>
              <dd>
                {bail.date_depart ? (
                  <>
                    Départ le {dateLisible(bail.date_depart)}
                    <div className="aide" style={{ margin: "2px 0 0" }}>
                      Fin prévue au bail : {bail.date_fin ? dateLisible(bail.date_fin) : "durée indéterminée"}
                    </div>
                  </>
                ) : bail.date_fin ? dateLisible(bail.date_fin) : "Durée indéterminée"}
              </dd>
              <dt>Loyer</dt>
              <dd>
                {formatCents(soldeCourant?.loyer_cents ?? bail.loyer_cents)}
                {changements.map((c) => (
                  <div key={c.id} className="aide" style={{ margin: "2px 0 0" }}>
                    {c.date_effet > moisCourant ? "Dès" : "Depuis"} {moisLisible(c.date_effet)} : {formatCents(c.ancien_loyer_cents)} → {formatCents(c.nouveau_loyer_cents)}
                    {c.raison ? ` · ${c.raison}` : ""}
                  </div>
                ))}
              </dd>
              {extras.map((e) => (<Fragment key={e.id}><dt>{e.libelle}</dt><dd>{formatCents(e.montant_cents)}</dd></Fragment>))}
              <dt>Paiement</dt><dd>{LIBELLE_MODE[bail.mode_paiement]}, le {bail.jour_echeance}{bail.jour_echeance === 1 ? "er" : ""} du mois</dd>
              {bail.inclusions && (<><dt>Inclusions</dt><dd>{bail.inclusions}</dd></>)}
              {bail.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{bail.notes}</dd></>)}
            </dl>

            {bail.statut !== "termine" && !bail.date_depart && moisFuturs.length > 0 && !changementOuvert && (
              <button className="bouton plein" style={{ marginTop: 12 }} onClick={ouvrirChangement}>Modifier le prix du loyer</button>
            )}
            {changementOuvert && (
              <div className="bloc-locataire">
                <strong>Nouveau loyer</strong>
                <label htmlFor="nouveau-loyer">Loyer par mois (sans les extras)</label>
                <input id="nouveau-loyer" className="montant-total" inputMode="decimal" value={nouveauLoyer}
                       onChange={(e) => setNouveauLoyer(e.target.value)} />
                <label htmlFor="mois-effet">À partir de</label>
                <select id="mois-effet" value={moisEffet} onChange={(e) => setMoisEffet(e.target.value)}>
                  {moisFuturs.map((s) => (
                    <option key={s.mois} value={s.mois}>
                      {moisLisible(s.mois)}{s.recu_cents > 0 ? " (déjà payé en partie ou au complet)" : ""}
                    </option>
                  ))}
                </select>
                <label htmlFor="raison-changement">Raison</label>
                <input id="raison-changement" placeholder="ex. Installation d'une thermopompe" value={raison}
                       onChange={(e) => setRaison(e.target.value)} />
                <p className="aide">
                  Jusqu&apos;à la fin du bail{bail.date_fin ? ` (${dateLisible(bail.date_fin)})` : ""}. Les mois précédents et les paiements
                  déjà reçus restent comme ils sont. Garde l&apos;entente signée avec le locataire dans « Bail signé ».
                </p>
                <div className="rangee">
                  <button className="bouton" onClick={() => setChangementOuvert(false)} disabled={envoiChangement}>Annuler</button>
                  <button className="bouton principal" onClick={enregistrerChangement} disabled={envoiChangement}>
                    {envoiChangement ? "Enregistrement…" : "Appliquer"}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Renouvellement : le bail qui suit celui-ci, s'il existe. Aussi pour un bail terminé (v0.9.6 : historique) */}
          {(() => {
            if (bail.date_depart || !bail.date_fin) return null;
            if (suiteDuBail && suiteDuBail.origine !== "cession") {
              return (
                <section className="carte">
                  <strong>Bail renouvelé</strong>
                  <p className="aide">
                    Le bail suivant commence le {dateLisible(suiteDuBail.date_debut)}
                    {suiteDuBail.date_fin ? ` et se termine le ${dateLisible(suiteDuBail.date_fin)}` : ""}.
                  </p>
                  <Link className="bouton plein" style={{ textAlign: "center" }} href={`/baux/${suiteDuBail.id}`}>Voir le nouveau bail</Link>
                </section>
              );
            }
            // Un bail commence dès le lendemain de la fin : pas de place pour un renouvellement entre les deux
            if (prochainBail && prochainBail.date_debut <= lendemain(bail.date_fin)) {
              return (
                <section className="carte">
                  <strong>Bail suivant</strong>
                  <p className="aide">
                    {prochainBail.locataires ?? "Un bail"} à partir du {dateLisible(prochainBail.date_debut)}
                    {prochainBail.date_fin ? ` jusqu'au ${dateLisible(prochainBail.date_fin)}` : ""}.
                    {!prochainBail.bail_precedent_id && " Si c'est le renouvellement de ce bail (mêmes locataires), touche « C'est un renouvellement de ce bail »."}
                  </p>
                  <Link className="bouton plein" style={{ textAlign: "center" }} href={`/baux/${prochainBail.id}`}>Voir le bail suivant</Link>
                  {!prochainBail.bail_precedent_id && (
                    <button className="bouton principal plein" style={{ marginTop: 10 }} onClick={lierAuSuivant} disabled={envoiLien}>
                      {envoiLien ? "Enregistrement…" : "C'est un renouvellement de ce bail"}
                    </button>
                  )}
                </section>
              );
            }
            return (
              <section className="carte">
                {!renouvOuvert ? (
                  <>
                    {bail.statut === "termine" && (
                      <p className="aide" style={{ marginTop: 0 }}>
                        Bail terminé : pour entrer l&apos;historique, renouvelle-le avec les dates passées
                        (ou fais la cession plus bas si un autre locataire l&apos;a pris en cours de bail).
                      </p>
                    )}
                    <button className="bouton principal plein" onClick={ouvrirRenouvellement}>Renouveler le bail</button>
                  </>
                ) : (
                  <>
                    <strong>Renouveler le bail</strong>
                    <label htmlFor="renouv-loyer">Prix du nouveau loyer par mois (sans les extras)</label>
                    <input id="renouv-loyer" className="montant-total" inputMode="decimal" value={renouvLoyer}
                           onChange={(e) => setRenouvLoyer(e.target.value)} />
                    <label htmlFor="renouv-debut">Début</label>
                    <input id="renouv-debut" type="date" value={renouvDebut} min={lendemain(bail.date_fin)}
                           max={prochainBail ? veille(prochainBail.date_debut) : undefined}
                           onChange={(e) => setRenouvDebut(e.target.value)} />
                    <label htmlFor="renouv-mois">Durée (mois)</label>
                    <input id="renouv-mois" inputMode="numeric" value={renouvMois}
                           onChange={(e) => setRenouvMois(e.target.value.replace(/\D/g, ""))} />
                    <p className="aide">
                      {finRenouvellement ? `Fin du nouveau bail : ${dateLisible(finRenouvellement)}. ` : ""}
                      {prochainBail && `Le bail suivant commence le ${dateLisible(prochainBail.date_debut)} : la fin ne peut pas dépasser la veille. `}
                      Mêmes locataires, extras et crédits, mode et jour de paiement. Le bail actuel n&apos;est pas touché.
                      Pour changer autre chose, touche « Modifier le bail » sur le nouveau bail.
                    </p>
                    {renouvPasses.length > 0 && (
                      <>
                        <label className="case">
                          <input type="checkbox" checked={renouvPayes} onChange={(e) => setRenouvPayes(e.target.checked)} />
                          <span>Tous les mois passés sont payés</span>
                        </label>
                        {renouvPayes ? (
                          <>
                            <p className="aide">Sauf : touche un mois pour l&apos;exclure (il restera à payer dans Loyers).</p>
                            <div className="puces">
                              {renouvPasses.map((m) => {
                                const exclu = renouvExclus.includes(m);
                                return (
                                  <span key={m} className={`puce${exclu ? "" : " actif"}`}>
                                    <button type="button" aria-pressed={!exclu}
                                            style={exclu ? { textDecoration: "line-through", color: "var(--discret)" } : undefined}
                                            onClick={() => setRenouvExclus((a) => (exclu ? a.filter((x) => x !== m) : [...a, m]))}>
                                      {moisLisible(m)}
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                            <p className="aide"><strong>{renouvAPayer.length} mois sur {renouvPasses.length}</strong> seront marqués payés dans Loyers.</p>
                          </>
                        ) : (
                          <p className="aide">Les {renouvPasses.length} mois passés resteront à payer dans Loyers.</p>
                        )}
                      </>
                    )}
                    <div className="rangee">
                      <button className="bouton" onClick={() => setRenouvOuvert(false)} disabled={envoiRenouv}>Annuler</button>
                      <button className="bouton principal" onClick={enregistrerRenouvellement} disabled={envoiRenouv}>
                        {envoiRenouv ? "Enregistrement…" : "Renouveler"}
                      </button>
                    </div>
                  </>
                )}
              </section>
            );
          })()}

          {/* Départ du locataire */}
          {bail.date_depart && autresBaux.some((a) => a.bail_precedent_id === bail.id && a.origine === "cession") ? (() => {
            const cessionnaire = autresBaux.find((a) => a.bail_precedent_id === bail.id && a.origine === "cession")!;
            return (
              <section className="carte">
                <strong>Bail cédé</strong>
                <p className="aide">
                  Le bail est passé à {cessionnaire.locataires ?? "un nouveau locataire"} le {dateLisible(cessionnaire.date_debut)}.
                  Les mois jusqu&apos;au {dateLisible(bail.date_depart)} et leurs paiements restent ici.
                </p>
                <Link className="bouton plein" style={{ textAlign: "center" }} href={`/baux/${cessionnaire.id}`}>Voir le bail du nouveau locataire</Link>
              </section>
            );
          })() : bail.date_depart ? (
            <section className="carte">
              <strong>Fin du bail</strong>
              <p className="aide">
                Le locataire {bail.statut === "termine" ? "est parti" : "part"} le {dateLisible(bail.date_depart)}.
                {fin && fin.forfait_cents > 0 && ` Montant forfaitaire : ${formatCents(fin.forfait_cents)} (ajouté au loyer de ${moisLisible(bail.date_depart.slice(0, 7) + "-01")}).`}
                {fin?.raison && ` Raison : ${fin.raison}.`}
              </p>
              {!autresBaux.some((a) => a.date_debut > (bail.date_depart ?? "")) && (
                <Link className="bouton principal plein" href={`/baux/nouveau?logement=${bail.logement_id}&debut=${lendemain(bail.date_depart)}`}>
                  Entrer le nouveau bail
                </Link>
              )}
              {fin && (
                <button className="lien-filtres" style={{ margin: "10px auto 0" }} onClick={annulerFin}>
                  Annuler la fin du bail (erreur de saisie)
                </button>
              )}
            </section>
          ) : bail.statut !== "termine" && (
            <section className="carte">
              {!finOuverte ? (
                <button className="bouton plein" onClick={ouvrirFin}>Terminer le bail (départ du locataire)</button>
              ) : (
                <>
                  <strong>Terminer le bail</strong>
                  <label htmlFor="date-depart">Date de départ (dernier jour du locataire)</label>
                  <input id="date-depart" type="date" value={dateDepart} min={bail.date_debut} max={bail.date_fin ?? undefined}
                         onChange={(e) => setDateDepart(e.target.value)} />
                  <label htmlFor="forfait">Montant forfaitaire (facultatif)</label>
                  <input id="forfait" inputMode="decimal" placeholder="ex. 1 900,00" value={forfait}
                         onChange={(e) => setForfait(e.target.value)} />
                  <label htmlFor="raison-fin">Raison ou entente</label>
                  <input id="raison-fin" placeholder="ex. Entente : 2 mois payés pour libérer le bail" value={raisonFin}
                         onChange={(e) => setRaisonFin(e.target.value)} />
                  <p className="aide">
                    Le bail n&apos;est pas supprimé : les mois passés et les paiements restent. Les loyers prévus après le mois
                    du départ sont retirés. Le montant forfaitaire s&apos;ajoute au dernier mois et se marque « Reçu » dans l&apos;onglet Loyers.
                  </p>
                  <div className="rangee">
                    <button className="bouton" onClick={() => setFinOuverte(false)} disabled={envoiFin}>Annuler</button>
                    <button className="bouton principal" onClick={enregistrerFin} disabled={envoiFin}>
                      {envoiFin ? "Enregistrement…" : "Terminer le bail"}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {/* Cession de bail (v0.9.5) ; aussi pour un bail terminé (v0.9.9 : historique) */}
          {!bail.date_depart && !suiteDuBail && soldes.some((s) => s.mois > bail.date_debut) && (
            <section className="carte">
              {!cessionOuverte ? (
                <>
                  {bail.statut === "termine" && (
                    <p className="aide" style={{ marginTop: 0 }}>
                      Un autre locataire a pris ce bail en cours de route ? Entre la cession avec la date passée.
                    </p>
                  )}
                  <button className="bouton plein" onClick={ouvrirCession}>Cession de bail (nouveau locataire)</button>
                </>
              ) : (
                <>
                  <strong>Cession de bail</strong>
                  <label htmlFor="cession-mois">Le nouveau locataire prend le bail le</label>
                  <select id="cession-mois" value={cessionMois} onChange={(e) => setCessionMois(e.target.value)}>
                    {soldes.filter((s) => s.mois > bail.date_debut).map((s) => (
                      <option key={s.mois} value={s.mois}>
                        1er {moisLisible(s.mois)}{bail.statut !== "termine" && (s.recu_cents > 0 || s.en_main_cents > 0) ? " (déjà payé en partie ou au complet)" : ""}
                      </option>
                    ))}
                  </select>
                  {cessionnaires.map((l, i) => (
                    <div key={l.cle} className="bloc-locataire">
                      <div className="entete" style={{ margin: "0 0 6px" }}>
                        <span className="aide" style={{ margin: 0 }}>{i === 0 ? "Nouveau locataire" : `Colocataire ${i}`}</span>
                        {cessionnaires.length > 1 && (
                          <button type="button" className="lien-retirer" onClick={() => setCessionnaires((a) => a.filter((x) => x.cle !== l.cle))}>Retirer</button>
                        )}
                      </div>
                      <div className="rangee">
                        <input placeholder="Prénom" autoComplete="off" value={l.prenom} aria-label="Prénom"
                               onChange={(e) => setCessionnaires((a) => a.map((x) => x.cle === l.cle ? { ...x, prenom: e.target.value } : x))} />
                        <input placeholder="Nom" autoComplete="off" value={l.nom} aria-label="Nom"
                               onChange={(e) => setCessionnaires((a) => a.map((x) => x.cle === l.cle ? { ...x, nom: e.target.value } : x))} />
                      </div>
                      <div className="rangee" style={{ marginTop: 8 }}>
                        <input placeholder="Téléphone" type="tel" inputMode="tel" autoComplete="off" value={l.telephone} aria-label="Téléphone"
                               onChange={(e) => setCessionnaires((a) => a.map((x) => x.cle === l.cle ? { ...x, telephone: e.target.value } : x))} />
                        <input placeholder="Courriel" type="email" autoComplete="off" value={l.courriel} aria-label="Courriel"
                               onChange={(e) => setCessionnaires((a) => a.map((x) => x.cle === l.cle ? { ...x, courriel: e.target.value } : x))} />
                      </div>
                    </div>
                  ))}
                  <button type="button" className="lien-filtres" onClick={() => setCessionnaires((a) => [...a, nouveauLocataire()])}>+ Ajouter un colocataire</button>
                  <p className="aide">
                    Le bail continue au nom du nouveau locataire : même loyer, même fin, mêmes extras, même mode de paiement.
                    Le bail actuel se termine la veille ; ses mois et paiements restent à son nom.
                    Ajoute ensuite la photo de l&apos;entente de cession sur le nouveau bail.
                    {bail.statut === "termine" && " Les mois après la cession qui avaient été marqués payés automatiquement sur ce bail passent au nouveau locataire (selon la case ci-dessous)."}
                  </p>
                  {cessionPasses.length > 0 && (
                    <>
                      <label className="case">
                        <input type="checkbox" checked={cessionPayes} onChange={(e) => setCessionPayes(e.target.checked)} />
                        <span>Tous les mois passés sont payés</span>
                      </label>
                      {cessionPayes ? (
                        <>
                          <p className="aide">Sauf : touche un mois pour l&apos;exclure (il restera à payer dans Loyers).</p>
                          <div className="puces">
                            {cessionPasses.map((m) => {
                              const exclu = cessionExclus.includes(m);
                              return (
                                <span key={m} className={`puce${exclu ? "" : " actif"}`}>
                                  <button type="button" aria-pressed={!exclu}
                                          style={exclu ? { textDecoration: "line-through", color: "var(--discret)" } : undefined}
                                          onClick={() => setCessionExclus((a) => (exclu ? a.filter((x) => x !== m) : [...a, m]))}>
                                    {moisLisible(m)}
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                          <p className="aide"><strong>{cessionAPayer.length} mois sur {cessionPasses.length}</strong> seront marqués payés au nom du nouveau locataire.</p>
                        </>
                      ) : (
                        <p className="aide">Les {cessionPasses.length} mois passés du nouveau locataire resteront à payer dans Loyers.</p>
                      )}
                    </>
                  )}
                  <div className="rangee">
                    <button className="bouton" onClick={() => setCessionOuverte(false)} disabled={envoiCession}>Annuler</button>
                    <button className="bouton principal" onClick={enregistrerCession} disabled={envoiCession}>
                      {envoiCession ? "Enregistrement…" : "Céder le bail"}
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {/* Bail signé, enquête de crédit, règlements d'immeuble (v0.9.4) ; titre selon le type (v0.9.5) */}
          {DOCUMENTS_BAIL.map((d) => (
            <DocumentsBail key={d.type} bailId={id} type={d.type} setErreur={setErreur}
                           {...(d.type === "bail" && bail.origine !== "nouveau" ? TITRE_COPIE[bail.origine] : {})} />
          ))}

          {bail.avis_du && !bail.date_depart && (
            <section className="carte">
              <strong>Renouvellement</strong>
              <p className="aide">
                Avis de modification à envoyer entre le {dateLisible(bail.avis_du)} et le {dateLisible(bail.avis_au)}.
                {bail.date_avis_envoye
                  ? ` Envoyé le ${dateLisible(bail.date_avis_envoye)}.`
                  : bail.avis_du <= auj && (bail.avis_au ?? "") >= auj
                    ? " La fenêtre est ouverte maintenant."
                    : (bail.avis_au ?? "") < auj ? " La fenêtre est passée : le bail se reconduit aux mêmes conditions." : ""}
              </p>
              <p className="aide">Le suivi complet des avis (envoi, réponse, preuve) arrive dans la version 0.9.</p>
            </section>
          )}

          <section className="carte">
            <div className="entete" style={{ marginBottom: 8 }}>
              <strong>Loyers dus</strong>
              <span className="aide" style={{ margin: 0 }}>{formatCents(totalRecu)} reçus sur {formatCents(totalDu)}</span>
            </div>
            {soldes.map((s) => (
              <button className="liste-depense lien-ligne" key={s.echeance_id} onClick={() => setMoisOuvert(s.echeance_id)}>
                <div className="infos">
                  <div className="titre" style={{ textTransform: "capitalize" }}>{moisLisible(s.mois)}</div>
                  {s.en_main_cents > 0 && <div className="sous">Chèque en main : {formatCents(s.en_main_cents)}</div>}
                  {credits.filter((c) => c.echeance_id === s.echeance_id).map((c) => (
                    <div key={c.id} className="sous">Crédit {formatCents(c.montant_cents)} · {c.notes}</div>
                  ))}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="montant">{formatCents(s.montant_du_cents)}</div>
                  {s.solde_cents <= 0
                    ? <span className="pastille ok">Payé</span>
                    : s.jours_retard > 0
                      ? <span className="pastille vacant">Retard {s.jours_retard} j</span>
                      : s.recu_cents > 0 ? <span className="pastille">Partiel</span> : null}
                </div>
              </button>
            ))}
            <p className="aide">Touche un mois pour voir ses paiements, les modifier ou en ajouter un.</p>
          </section>
          {moisOuvert && <FeuilleLoyer echeanceId={moisOuvert} depuisBail onFermer={() => setMoisOuvert(null)} onChange={charger} />}

          <button className="bouton plein lien-danger" onClick={supprimer} disabled={suppression}>
            {suppression ? "Suppression…" : "Supprimer ce bail (erreur de saisie)"}
          </button>
        </>
      )}
    </main>
  );
}
