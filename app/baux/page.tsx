"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, triNumero } from "@/lib/dates";
import { anneesProposees, bailDansAnnees, libellePeriode, lireAnnees } from "@/lib/baux";
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
  date_depart: string | null;
  loyer_cents: number;
  extras_cents: number;
  locataires: string | null;
  avis_du: string | null;
  avis_au: string | null;
  date_avis_envoye: string | null;
};

/** Recherche sans accents ni majuscules */
const simplifier = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export default function PageBaux() {
  return (
    <Suspense fallback={null}>
      <Baux />
    </Suspense>
  );
}

function Baux() {
  const { session, pret } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [baux, setBaux] = useState<Bail[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [exportEnCours, setExportEnCours] = useState<{ id: string; etape: string } | null>(null);
  const [exportResultat, setExportResultat] = useState<{ id: string; texte: string } | null>(null);
  const [recherche, setRecherche] = useState("");

  // Filtres gardés dans l'adresse : ?a=2026,2025 (années) & i=<immeuble>
  const annees = lireAnnees(params.get("a"));
  const immeubleFiltre = params.get("i") ?? "";
  const anneeCourante = anneesProposees()[0];
  const periode = libellePeriode(annees);

  function majFiltres(nouvellesAnnees: number[], immeuble: string) {
    const q = new URLSearchParams();
    const t = [...nouvellesAnnees].sort((x, y) => y - x);
    if (!(t.length === 1 && t[0] === anneeCourante)) q.set("a", t.join(","));
    if (immeuble) q.set("i", immeuble);
    router.replace(`/baux${q.toString() ? `?${q}` : ""}`, { scroll: false });
  }

  function basculerAnnee(a: number) {
    const avec = annees.includes(a) ? annees.filter((x) => x !== a) : [...annees, a];
    if (avec.length === 0) return; // au moins une année
    majFiltres(avec, immeubleFiltre);
  }

  async function dossierPreteur(im: Immeuble) {
    setErreur(null);
    setExportResultat(null);
    try {
      const r = await exporterDossierPreteur(im, annees, (etape) => setExportEnCours({ id: im.id, etape }));
      setExportResultat({
        id: im.id,
        texte: `Dossier ${periode} créé : ${r.nbBaux} bail(s) pour ${r.total} logements`
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
          .select("id, logement_id, statut, date_debut, date_fin, date_depart, loyer_cents, extras_cents, locataires, avis_du, avis_au, date_avis_envoye")
          .order("date_debut", { ascending: false }),
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
  const avisAEnvoyer = baux.filter((b) => b.avis_du && !b.date_depart && !b.date_avis_envoye && b.avis_du <= auj && (b.avis_au ?? "") >= auj).length;

  const q = simplifier(recherche);
  const dansPeriode = baux.filter((b) => bailDansAnnees(b, annees));
  const correspond = (b: Bail, l: Logement) => !q || simplifier(b.locataires ?? "").includes(q) || simplifier(l.numero) === q;
  const nbDansPeriode = dansPeriode.filter((b) => logements.some((l) => l.id === b.logement_id
    && (!immeubleFiltre || l.immeuble_id === immeubleFiltre) && correspond(b, l))).length;
  const immeublesAffiches = immeubles.filter((im) => !immeubleFiltre || im.id === immeubleFiltre);

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

      {/* Filtres */}
      <section className="carte">
        <strong>Période</strong>
        <div className="puces">
          {anneesProposees().map((a) => (
            <span key={a} className={`puce${annees.includes(a) ? " actif" : ""}`}>
              <button type="button" aria-pressed={annees.includes(a)} onClick={() => basculerAnnee(a)}>{a}</button>
            </span>
          ))}
        </div>
        <p className="aide">Touche une ou plusieurs années. Le dossier prêteur suit la même période.</p>

        {immeubles.length > 1 && (
          <div className="puces" style={{ marginTop: 12 }}>
            <span className={`puce${!immeubleFiltre ? " actif" : ""}`}>
              <button type="button" onClick={() => majFiltres(annees, "")}>Tous</button>
            </span>
            {immeubles.map((im) => (
              <span key={im.id} className={`puce${immeubleFiltre === im.id ? " actif" : ""}`}>
                <button type="button" onClick={() => majFiltres(annees, im.id)}>{im.nom}</button>
              </span>
            ))}
          </div>
        )}

        <input type="search" placeholder="Chercher un locataire ou un numéro" autoComplete="off" value={recherche}
               onChange={(e) => setRecherche(e.target.value)} style={{ marginTop: 12, width: "100%" }} aria-label="Chercher" />
        {!chargement && <p className="aide">{nbDansPeriode} {nbDansPeriode > 1 ? "baux" : "bail"} en {periode}.</p>}
      </section>

      {chargement && <p className="aide">Chargement…</p>}

      {immeublesAffiches.map((im) => {
        const logementsIm = logements.filter((l) => l.immeuble_id === im.id);
        const lignes = logementsIm.map((l) => ({
          l,
          liste: dansPeriode.filter((b) => b.logement_id === l.id && correspond(b, l)),
        })).filter((x) => !q || x.liste.length > 0);
        return (
          <section key={im.id}>
            <div className="entete" style={{ margin: "20px 0 8px", alignItems: "flex-start" }}>
              <h2 className="immeuble-titre" style={{ margin: 0 }}>{im.nom}</h2>
              <button className="bouton" style={{ padding: "6px 12px", fontSize: 15, lineHeight: 1.25, textAlign: "center" }}
                      onClick={() => dossierPreteur(im)} disabled={exportEnCours !== null}>
                {exportEnCours?.id === im.id ? exportEnCours.etape : <>Dossier prêteur<br /><small>{periode}</small></>}
              </button>
            </div>
            {exportResultat?.id === im.id && <p className="aide" style={{ color: "var(--succes)" }}>{exportResultat.texte}</p>}
            <div className="carte" style={{ paddingTop: 4, paddingBottom: 4 }}>
              {lignes.length === 0 && <p className="aide">Aucun bail trouvé.</p>}
              {lignes.map(({ l, liste }) => {
                if (liste.length === 0) {
                  const enCours = baux.some((b) => b.logement_id === l.id && b.statut !== "termine");
                  // Aucun bail en cours ni à venir : on propose d'en créer un
                  if (!enCours) {
                    return (
                      <Link key={l.id} href={`/baux/nouveau?logement=${l.id}`} className="logement-ligne">
                        <span className="logement-numero">{l.numero}</span>
                        <div className="infos">
                          <div className="titre" style={{ color: "var(--discret)" }}>Aucun bail {annees.includes(anneeCourante) ? "saisi" : `en ${periode}`}</div>
                          <div className="sous">Toucher pour ajouter le bail</div>
                        </div>
                        <span className="pastille vacant">Vacant</span>
                      </Link>
                    );
                  }
                  return (
                    <Link key={l.id} href={`/baux/logement/${l.id}`} className="logement-ligne">
                      <span className="logement-numero">{l.numero}</span>
                      <div className="infos">
                        <div className="titre" style={{ color: "var(--discret)" }}>Aucun bail en {periode}</div>
                        <div className="sous">Toucher pour voir l&apos;historique du logement</div>
                      </div>
                    </Link>
                  );
                }
                return liste.map((bail) => {
                  const aVenirApres = bail.statut === "actif" && baux.some((b) => b.logement_id === l.id && b.statut === "a_venir");
                  const fenetreOuverte = bail.avis_du && !bail.date_depart && !bail.date_avis_envoye && bail.avis_du <= auj && (bail.avis_au ?? "") >= auj;
                  return (
                    <Link key={bail.id} href={`/baux/${bail.id}`} className="logement-ligne">
                      <span className="logement-numero">{l.numero}</span>
                      <div className="infos">
                        <div className="titre">{bail.locataires ?? "Locataire à préciser"}</div>
                        <div className="sous">
                          {formatCents(bail.loyer_cents + bail.extras_cents)} / mois
                          {" · "}{bail.statut === "termine"
                            ? `${dateLisible(bail.date_debut)} au ${dateLisible(bail.date_depart ?? bail.date_fin)}`
                            : bail.date_depart
                              ? `départ ${dateLisible(bail.date_depart)}`
                              : bail.date_fin ? `fin ${dateLisible(bail.date_fin)}` : "durée indéterminée"}
                        </div>
                      </div>
                      {bail.statut === "a_venir" && <span className="pastille">À venir</span>}
                      {bail.statut === "termine" && <span className="pastille gris">Terminé</span>}
                      {bail.statut === "actif" && bail.date_depart && (aVenirApres
                        ? <span className="pastille">Relocation faite</span>
                        : <span className="pastille vacant">Départ</span>)}
                      {fenetreOuverte && <span className="pastille">Avis TAL</span>}
                    </Link>
                  );
                });
              })}
            </div>
          </section>
        );
      })}

      <BarreOnglets />
    </main>
  );
}
