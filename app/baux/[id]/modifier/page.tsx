"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { centsVersSaisie } from "@/lib/argent";
import { dateLisible, moisLisible } from "@/lib/dates";
import { LIBELLE_ORIGINE, type OrigineBail } from "@/lib/baux";
import FormulaireBail, { dureeDe, extrasVersForm, type BailSaisi, type Mode, type ValeursBail } from "@/components/FormulaireBail";
import { partOmhDuBail, messageOmh } from "@/lib/omh";

type BailBase = {
  id: string; logement_id: string; date_debut: string; date_fin: string | null; date_depart: string | null;
  loyer_cents: number; jour_echeance: number; mode_paiement: string; inclusions: string | null; notes: string | null;
  bail_precedent_id: string | null; origine: OrigineBail;
};
type LienLocataire = { principal: boolean; locataire: { id: string; prenom: string; nom: string; telephone: string | null; courriel: string | null } };

export default function ModifierBail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session, pret } = useSession();

  const [initial, setInitial] = useState<ValeursBail | null>(null);
  const [bail, setBail] = useState<BailBase | null>(null);
  const [premierChangement, setPremierChangement] = useState<string | null>(null);
  const [avecPaiements, setAvecPaiements] = useState(false);
  // Part de l'OMH actuelle (v0.9.12) ; null = pas de subvention
  const [partOmh, setPartOmh] = useState<number | null>(null);
  const [envoi, setEnvoi] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // Type du bail (v0.9.5), modifiable seulement s'il suit un autre bail
  const [origine, setOrigine] = useState<OrigineBail>("nouveau");

  useEffect(() => {
    if (!session || !id) return;
    (async () => {
      const [b, lo, ex, ch, so, omh] = await Promise.all([
        supabase.from("baux").select("id, logement_id, date_debut, date_fin, date_depart, loyer_cents, jour_echeance, mode_paiement, inclusions, notes, bail_precedent_id, origine")
          .eq("id", id).is("deleted_at", null).single(),
        supabase.from("bail_locataires").select("principal, locataire:locataires(id, prenom, nom, telephone, courriel)").eq("bail_id", id),
        supabase.from("bail_extras").select("libelle, montant_cents").eq("bail_id", id).order("created_at"),
        supabase.from("changements_loyer").select("date_effet, ancien_loyer_cents").eq("bail_id", id).order("date_effet").limit(1),
        supabase.from("v_soldes").select("recu_cents, en_main_cents").eq("bail_id", id),
        partOmhDuBail(id),
      ]);
      if (b.error || !b.data) { setErreur("Bail introuvable ou supprimé."); return; }
      const leBail = b.data as BailBase;
      const premier = ((ch.data ?? []) as { date_effet: string; ancien_loyer_cents: number }[])[0];
      const liens = ((lo.data ?? []) as unknown as LienLocataire[]).sort((x, y) => Number(y.principal) - Number(x.principal));
      setBail(leBail);
      setOrigine(leBail.origine ?? "nouveau");
      setPremierChangement(premier?.date_effet ?? null);
      setPartOmh(omh);
      setAvecPaiements(((so.data ?? []) as { recu_cents: number; en_main_cents: number }[]).some((s) => s.recu_cents > 0 || s.en_main_cents > 0));
      const duree = dureeDe(leBail.date_debut, leBail.date_fin);
      setInitial({
        logementId: leBail.logement_id,
        locataires: liens.map((l) => ({
          cle: crypto.randomUUID(), existantId: l.locataire.id, modifiable: true,
          prenom: l.locataire.prenom, nom: l.locataire.nom,
          telephone: l.locataire.telephone ?? "", courriel: l.locataire.courriel ?? "",
        })),
        dateDebut: leBail.date_debut,
        duree,
        dateFinAutre: duree === "autre" ? (leBail.date_fin ?? "") : "",
        // Loyer au début du bail : avant le premier « Modifier le prix du loyer », s'il y en a eu
        loyerSaisi: centsVersSaisie(premier ? premier.ancien_loyer_cents : leBail.loyer_cents),
        omh: omh !== null,
        partOmhSaisi: omh !== null ? centsVersSaisie(omh) : "",
        jourEcheance: String(leBail.jour_echeance),
        mode: leBail.mode_paiement as Mode,
        extras: extrasVersForm((ex.data ?? []) as { libelle: string; montant_cents: number }[]),
        inclusions: leBail.inclusions ?? "",
        notes: leBail.notes ?? "",
      });
    })();
  }, [session, id]);

  async function enregistrer(p: BailSaisi) {
    if (avecPaiements && !window.confirm(
      "Ce bail a déjà des paiements. Les montants dus de chaque mois seront recalculés selon tes corrections ; "
      + "les paiements reçus ne changent pas (un mois peut devenir partiel ou payé en trop). Continuer ?"
    )) return;
    setErreur(null);
    setEnvoi("Enregistrement…");
    // v0.9.12 : avec la part de l'OMH (modifier_bail_omh, migration 022) seulement s'il y en a une
    const avecOmh = p.part_omh_cents !== null || partOmh !== null;
    const { error } = await supabase.rpc(avecOmh ? "modifier_bail_omh" : "modifier_bail", { p: { ...p, id } });
    if (error) {
      setEnvoi(null);
      return setErreur(error.message.includes("baux_sans_chevauchement")
        ? "Ces dates chevauchent un autre bail de ce logement. Vérifie les dates (voir l'historique du logement)."
        : messageOmh(error.message, "modifier_bail_omh"));
    }
    if (bail && origine !== bail.origine) {
      const { error: e2 } = await supabase.from("baux").update({ origine }).eq("id", id);
      if (e2) { setEnvoi(null); return setErreur(e2.message); }
    }
    router.replace(`/baux/${id}`);
  }

  if (!pret || !session) return null;

  return (
    <main className="page">
      <div className="entete">
        <h1>Modifier le bail</h1>
        <Link href={`/baux/${id}`} className="bouton">Annuler</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}
      {!initial && !erreur && <p className="aide">Chargement…</p>}

      {initial && bail && (
        <>
          <p className="aide" style={{ marginTop: 0 }}>
            Corrige ici n&apos;importe quel détail du bail. Pour une hausse de loyer en cours de bail, utilise plutôt
            « Modifier le prix du loyer » sur la fiche.
            {bail.date_depart && ` Le départ du locataire (${dateLisible(bail.date_depart)}) reste inscrit.`}
          </p>
          {bail.bail_precedent_id && (
            <section className="carte">
              <label htmlFor="origine" style={{ marginTop: 0 }}>Type de bail (dossier du prêteur)</label>
              <select id="origine" value={origine} onChange={(e) => setOrigine(e.target.value as OrigineBail)}>
                {(Object.keys(LIBELLE_ORIGINE) as OrigineBail[]).map((o) => <option key={o} value={o}>{LIBELLE_ORIGINE[o]}</option>)}
              </select>
              <p className="aide">
                Renouvellement ou cession : le dossier du prêteur joint aussi les photos du bail précédent (bail d&apos;origine).
                Nouveau bail : un autre locataire, sans lien avec le bail précédent.
              </p>
            </section>
          )}
          <FormulaireBail
            initial={initial}
            titreLoyer={premierChangement ? "Loyer au début du bail" : "Loyer mensuel"}
            aideLoyer={premierChangement
              ? `Le changement de loyer de ${moisLisible(premierChangement)} reste appliqué ; ce montant vaut pour les mois avant.`
                + (partOmh !== null ? " La part de l'OMH change pour les mois qui ont la part actuelle." : "")
              : undefined}
            avecPhotos={false}
            texteBouton="Enregistrer les corrections"
            envoi={envoi}
            setErreur={setErreur}
            onEnregistrer={(p) => enregistrer(p)}
          />
        </>
      )}
    </main>
  );
}
