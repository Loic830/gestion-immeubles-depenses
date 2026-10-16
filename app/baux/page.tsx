"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, triNumero } from "@/lib/dates";
import BarreOnglets from "@/components/BarreOnglets";
import { exporterDossierPreteur } from "@/lib/exportBaux";

type Immeuble = { id: string; nom: string; adresse: string | null };
type Logement = { id: string; immeuble_id: string; numero: string };
type Bail = {
  id: string;
  logement_id: string;
  statut: "a_venir" | "actif" | "termine";
  date_debut: string;
  date_fin: string | null;
  loyer_cents: number;
  extras_cents: number;
  locataires: string | null;
  avis_du: string | null;
  avis_au: string | null;
  date_avis_envoye: string | null;
};

export default function PageBaux() {
  const { session, pret } = useSession();
  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [baux, setBaux] = useState<Bail[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [exportEnCours, setExportEnCours] = useState<{ id: string; etape: string } | null>(null);
  const [exportResultat, setExportResultat] = useState<{ id: string; texte: string } | null>(null);

  async function dossierPreteur(im: Immeuble) {
    setErreur(null);
    setExportResultat(null);
    try {
      const r = await exporterDossierPreteur(im, (etape) => setExportEnCours({ id: im.id, etape }));
      setExportResultat({
        id: im.id,
        texte: `Dossier créé : ${r.occupes} / ${r.total} logements occupés`
          + (r.sansCopie ? ` · ${r.sansCopie} bail(s) sans copie` : " · toutes les copies incluses")
          + (r.manquants ? ` · ${r.manquants} fichier(s) introuvable(s)` : "") + ".",
      });
    } catch (e) {
      setErreur(`Dossier prêteur impossible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportEnCours(null);
    }
  }

  useEffect(() => {
    if (!session) return;
    (async () => {
      // Les baux à durée indéterminée reçoivent leurs prochains loyers dus (sans effet si déjà fait)
      await supabase.rpc("prolonger_echeances");
      const [im, lo, ba] = await Promise.all([
        supabase.from("immeubles").select("id, nom, adresse").is("deleted_at", null).order("nom"),
        supabase.from("logements").select("id, immeuble_id, numero").is("deleted_at", null).eq("actif", true),
        supabase.from("v_baux")
          .select("id, logement_id, statut, date_debut, date_fin, loyer_cents, extras_cents, locataires, avis_du, avis_au, date_avis_envoye")
          .in("statut", ["actif", "a_venir"])
          .order("date_debut"),
      ]);
      const err = [im, lo, ba].find((r) => r.error)?.error;
      if (err) setErreur(err.message);
      setImmeubles((im.data ?? []) as Immeuble[]);
      setLogements(((lo.data ?? []) as Logement[]).sort((a, b) => triNumero(a.numero, b.numero)));
      setBaux((ba.data ?? []) as Bail[]);
      setChargement(false);
    })();
  }, [session]);

  if (!pret || !session) return null;

  const auj = aujourdhuiIso();
  const nbOccupes = logements.filter((l) => baux.some((b) => b.logement_id === l.id && b.statut === "actif")).length;
  const loyersMensuels = baux.filter((b) => b.statut === "actif").reduce((s, b) => s + b.loyer_cents + b.extras_cents, 0);
  const avisAEnvoyer = baux.filter((b) => b.avis_du && !b.date_avis_envoye && b.avis_du <= auj && (b.avis_au ?? "") >= auj).length;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Baux</h1>
        <Link href="/baux/nouveau" className="bouton principal">+ Bail</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

      <section className="carte total-periode">
        Occupés : <strong>{nbOccupes} / {logements.length}</strong>
        {" · "}Loyers : <strong>{formatCents(loyersMensuels)}</strong> / mois
        {avisAEnvoyer > 0 && <p className="aide" style={{ color: "var(--alerte)" }}>{avisAEnvoyer} avis de renouvellement à envoyer maintenant.</p>}
      </section>

      {chargement && <p className="aide">Chargement…</p>}

      {immeubles.map((im) => (
        <section key={im.id}>
          <div className="entete" style={{ margin: "20px 0 8px" }}>
            <h2 className="immeuble-titre" style={{ margin: 0 }}>{im.nom}</h2>
            <button className="bouton" style={{ padding: "6px 12px", fontSize: 15 }}
                    onClick={() => dossierPreteur(im)} disabled={exportEnCours !== null}>
              {exportEnCours?.id === im.id ? exportEnCours.etape : "Dossier prêteur"}
            </button>
          </div>
          {exportResultat?.id === im.id && <p className="aide" style={{ color: "var(--succes)" }}>{exportResultat.texte}</p>}
          <div className="carte" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {logements.filter((l) => l.immeuble_id === im.id).map((l) => {
              const actif = baux.find((b) => b.logement_id === l.id && b.statut === "actif");
              const aVenir = baux.find((b) => b.logement_id === l.id && b.statut === "a_venir");
              const bail = actif ?? aVenir;
              if (!bail) {
                return (
                  <Link key={l.id} href={`/baux/nouveau?logement=${l.id}`} className="logement-ligne">
                    <span className="logement-numero">{l.numero}</span>
                    <div className="infos">
                      <div className="titre" style={{ color: "var(--discret)" }}>Aucun bail saisi</div>
                      <div className="sous">Toucher pour ajouter le bail</div>
                    </div>
                    <span className="pastille vacant">Vacant</span>
                  </Link>
                );
              }
              const fenetreOuverte = bail.avis_du && !bail.date_avis_envoye && bail.avis_du <= auj && (bail.avis_au ?? "") >= auj;
              return (
                <Link key={l.id} href={`/baux/${bail.id}`} className="logement-ligne">
                  <span className="logement-numero">{l.numero}</span>
                  <div className="infos">
                    <div className="titre">{bail.locataires ?? "Locataire à préciser"}</div>
                    <div className="sous">
                      {formatCents(bail.loyer_cents + bail.extras_cents)} / mois
                      {" · "}{bail.date_fin ? `fin ${dateLisible(bail.date_fin)}` : "durée indéterminée"}
                    </div>
                  </div>
                  {!actif && aVenir && <span className="pastille">À venir</span>}
                  {fenetreOuverte && <span className="pastille">Avis TAL</span>}
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      <BarreOnglets />
    </main>
  );
}
