"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { DOCUMENTS_BAIL, televerserDocument, type PagesParType } from "@/lib/documents";
import { useSession } from "@/lib/useSession";
import { prochainPremierJuillet, dateLisible, lendemain } from "@/lib/dates";
import FormulaireBail, { nouveauLocataire, type BailSaisi } from "@/components/FormulaireBail";
import { migrationOmhFaite, MESSAGE_MIGRATION_OMH } from "@/lib/omh";

type BailExistant = {
  id: string;
  statut: "a_venir" | "actif" | "termine";
  date_debut: string;
  date_fin: string | null;
  date_depart: string | null;
  locataires: string | null;
};
/** Pop-up « Il y a déjà un bail en cours… » */
type Remplacement = { ancien: BailExistant; finAncien: string; p: BailSaisi; pages: PagesParType };

/** Dernier jour du mois avant la date : « 2027-07-01 » ou « 2027-07-15 » → « 2027-06-30 » */
function finMoisPrecedent(iso: string): string {
  const [a, m] = iso.split("-").map(Number);
  const d = new Date(a, m - 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PageNouveauBail() {
  return (
    <Suspense fallback={null}>
      <NouveauBail />
    </Suspense>
  );
}

function NouveauBail() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, pret } = useSession();

  const [envoi, setEnvoi] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [remplacement, setRemplacement] = useState<Remplacement | null>(null);

  // ?debut=AAAA-MM-JJ : arrivée depuis « Entrer le nouveau bail » (lendemain du départ)
  const debutParam = params.get("debut") ?? "";
  const [initial] = useState(() => ({
    logementId: params.get("logement") ?? "",
    locataires: [nouveauLocataire()],
    dateDebut: /^\d{4}-\d{2}-\d{2}$/.test(debutParam) ? debutParam : prochainPremierJuillet(),
    duree: "12" as const,
    dateFinAutre: "",
    loyerSaisi: "",
    omh: false,
    partOmhSaisi: "",
    jourEcheance: "1",
    mode: "interac" as const,
    extras: [],
    inclusions: "",
    notes: "",
  }));

  /** Envoie les photos (bail, enquête de crédit, règlements) une fois le bail créé ; retourne le nombre d'échecs. */
  async function televerserPages(bailId: string, pages: PagesParType): Promise<number> {
    const liste = DOCUMENTS_BAIL.flatMap((d) => pages[d.type].map((f) => ({ type: d.type, f })));
    let echecs = 0;
    for (let i = 0; i < liste.length; i++) {
      setEnvoi(`Envoi des photos ${i + 1} / ${liste.length}…`);
      try { await televerserDocument(bailId, liste[i].type, liste[i].f); } catch { echecs++; }
    }
    return echecs;
  }

  async function terminer(bailId: string, pages: PagesParType) {
    const echecs = await televerserPages(bailId, pages);
    if (echecs) window.alert(`Le bail est enregistré, mais ${echecs} page(s) n'ont pas pu être envoyées. Ajoute-les depuis la fiche du bail.`);
    router.replace(`/baux/${bailId}`);
  }

  function messageErreur(message: string): string {
    return message.includes("baux_sans_chevauchement")
      ? "Ce logement a déjà un bail sur ces dates. Vérifie les dates ou termine l'ancien bail."
      : message;
  }

  async function enregistrer(p: BailSaisi, pages: PagesParType) {
    setEnvoi("Vérification…");
    // Subvention de l'OMH (v0.9.12) : sans la migration 022, la part de l'OMH serait perdue
    if (p.part_omh_cents && !(await migrationOmhFaite())) { setEnvoi(null); return setErreur(MESSAGE_MIGRATION_OMH); }
    // Un bail couvre-t-il déjà une partie de la période du nouveau bail ?
    const { data, error: errLecture } = await supabase.from("v_baux")
      .select("id, statut, date_debut, date_fin, date_depart, locataires")
      .eq("logement_id", p.logement_id);
    if (errLecture) { setEnvoi(null); return setErreur(errLecture.message); }
    const finNouveau = p.date_fin ?? "9999-12-31";
    const enConflit = ((data ?? []) as BailExistant[]).filter((b) =>
      b.date_debut <= finNouveau && (b.date_depart ?? b.date_fin ?? "9999-12-31") >= p.date_debut);

    if (enConflit.length > 0) {
      setEnvoi(null);
      const finAncien = finMoisPrecedent(p.date_debut);
      const ancien = enConflit[0];
      if (enConflit.length === 1 && ancien.date_debut <= finAncien && !ancien.date_depart) {
        setRemplacement({ ancien, finAncien, p, pages });
        return;
      }
      // Cas que le pop-up ne peut pas régler : on explique quoi faire
      const qui = ancien.locataires ?? "un locataire";
      if (enConflit.length === 1 && ancien.date_depart) {
        return setErreur(`Le bail de ${qui} se termine déjà le ${dateLisible(ancien.date_depart)} (départ inscrit). `
          + `Le nouveau bail peut commencer le ${dateLisible(lendemain(ancien.date_depart))}, ou annule la fin de ce bail sur sa fiche.`);
      }
      return setErreur(`Ce logement a déjà un bail qui commence le ${dateLisible(ancien.date_debut)} (${qui}). `
        + "Vérifie les dates, ou modifie ce bail depuis sa fiche.");
    }

    setEnvoi("Enregistrement…");
    const { data: bailId, error } = await supabase.rpc("creer_bail", { p });
    if (error) {
      setEnvoi(null);
      return setErreur(messageErreur(error.message));
    }
    await terminer(bailId as string, pages);
  }

  async function confirmerRemplacement() {
    if (!remplacement) return;
    const { ancien, p, pages } = remplacement;
    setRemplacement(null);
    setErreur(null);
    setEnvoi("Enregistrement…");
    const { data: bailId, error } = await supabase.rpc("creer_bail_en_remplacement", { p, p_ancien: ancien.id });
    if (error) {
      setEnvoi(null);
      return setErreur(messageErreur(error.message));
    }
    await terminer(bailId as string, pages);
  }

  if (!pret || !session) return null;

  return (
    <main className="page">
      <div className="entete">
        <h1>Nouveau bail</h1>
        <Link href="/baux" className="bouton">Annuler</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

      <FormulaireBail
        initial={initial}
        avecPhotos
        nouveau
        texteBouton="Enregistrer le bail"
        envoi={envoi}
        setErreur={setErreur}
        onEnregistrer={enregistrer}
      />

      {remplacement && (
        <div className="voile" role="dialog" aria-modal="true" aria-labelledby="titre-remplacement">
          <div className="feuille">
            <strong id="titre-remplacement" style={{ fontSize: 19 }}>Il y a déjà un bail sur ce logement</strong>
            <p>
              Il y a déjà un bail {remplacement.ancien.statut === "a_venir" ? "à venir" : "en cours"} au nom
              de <strong>{remplacement.ancien.locataires ?? "locataire à préciser"}</strong>
              {remplacement.ancien.date_fin
                ? <> qui se termine le <strong>{dateLisible(remplacement.ancien.date_fin)}</strong>.</>
                : <>, à durée indéterminée.</>}
            </p>
            <p>
              Est-ce que vous voulez mettre fin à ce bail le <strong>{dateLisible(remplacement.finAncien)}</strong>,
              {" "}dernier jour du mois avant le début du nouveau bail ({dateLisible(remplacement.p.date_debut)}) ?
            </p>
            <p className="aide">
              Les loyers prévus après {dateLisible(remplacement.finAncien)} seront retirés de l&apos;ancien bail.
              Les mois passés et les paiements restent dans son historique. Le nouveau bail est enregistré tel que saisi.
            </p>
            <div className="rangee" style={{ marginTop: 12 }}>
              <button className="bouton" onClick={() => {
                setRemplacement(null);
                setErreur("Le nouveau bail n'est pas enregistré. Change les dates ou le logement, ou réponds Oui pour mettre fin à l'ancien bail.");
              }}>Non</button>
              <button className="bouton principal" onClick={confirmerRemplacement}>Oui, mettre fin</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
