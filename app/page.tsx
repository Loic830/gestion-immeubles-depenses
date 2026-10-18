"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { ajouterMois, aujourdhuiIso, finDuMois, moisLisible } from "@/lib/dates";
import { genererCsv, montantCsv, telechargerFichier } from "@/lib/csv";
import { exporterDossier } from "@/lib/exportDossier";
import BarreOnglets from "@/components/BarreOnglets";

type Ligne = {
  ligne_id: string;
  depense_id: string;
  date_facture: string;
  statut: "brouillon" | "complete";
  fournisseur: string | null;
  immeuble_id: string;
  immeuble: string;
  logement: string | null;
  categorie_id: string | null;
  categorie: string | null;
  categorie_parent: string | null;
  code_fiscal: string | null;
  nature: "courante" | "capital";
  montant_cents: number | null;
  sous_total_cents: number | null;
  tps_cents: number;
  tvq_cents: number;
  total_cents: number | null;
  mode_paiement: string | null;
  no_facture: string | null;
  description: string | null;
  notes: string | null;
  nb_pieces: number;
};


const LIMITE = 1000; // plafond par défaut de Supabase par requête

export default function Accueil() {
  // useSearchParams exige une frontière Suspense avec Next.js 15
  return (
    <Suspense fallback={null}>
      <ListeDepenses />
    </Suspense>
  );
}

function ListeDepenses() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, pret } = useSession();

  // Période, lue dans l'URL : ?m=2026-10 (mois, par défaut le mois courant) ou ?a=2026 (année)
  const moisActuel = aujourdhuiIso().slice(0, 7);
  const anneeParam = params.get("a") ?? "";
  const moisParam = params.get("m") ?? "";
  const mode: "mois" | "annee" = /^\d{4}$/.test(anneeParam) ? "annee" : "mois";
  const annee = mode === "annee" ? Number(anneeParam) : Number(moisActuel.slice(0, 4));
  const mois = /^\d{4}-\d{2}$/.test(moisParam) ? moisParam : moisActuel;
  const { debut, fin } = mode === "annee"
    ? { debut: `${annee}-01-01`, fin: `${annee}-12-31` }
    : { debut: `${mois}-01`, fin: finDuMois(`${mois}-01`) };
  const estPeriodeCourante = mode === "annee" ? annee === Number(moisActuel.slice(0, 4)) : mois === moisActuel;
  const libellePeriode = mode === "annee" ? `Année ${annee}` : moisLisible(`${mois}-01`);

  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [exportEnCours, setExportEnCours] = useState<string | null>(null);
  const [exportResultat, setExportResultat] = useState<string | null>(null);

  function allerA(requete: string) {
    setExportResultat(null);
    router.replace(requete ? `/?${requete}` : "/", { scroll: false });
  }
  // Le mois courant et l'année courante sont les défauts : l'adresse reste « / »
  const allerMois = (m: string) => allerA(m === moisActuel ? "" : `m=${m}`);
  const allerAnnee = (a: number) => allerA(`a=${a}`);
  function decaler(n: number) {
    if (mode === "annee") allerAnnee(annee + n);
    else allerMois(ajouterMois(`${mois}-01`, n).slice(0, 7));
  }
  function choisirMode(m: "mois" | "annee") {
    if (m === mode) return;
    if (m === "annee") allerAnnee(Number(mois.slice(0, 4)));
    // Retour au mois : le mois courant si c'est l'année courante, sinon janvier de l'année affichée
    else allerMois(annee === Number(moisActuel.slice(0, 4)) ? moisActuel : `${annee}-01`);
  }

  useEffect(() => {
    if (!session) return;
    (async () => {
      setChargement(true);
      setErreur(null);
      const { data, error } = await supabase
        .from("v_depenses_detail")
        .select("*")
        .gte("date_facture", debut)
        .lte("date_facture", fin)
        .order("date_facture", { ascending: false })
        .limit(LIMITE);
      if (error) setErreur(error.message);
      else setLignes((data ?? []) as Ligne[]);
      setChargement(false);
    })();
  }, [session, debut, fin]);

  // Totaux
  const total = lignes.reduce((s, l) => s + (l.montant_cents ?? 0), 0);
  const totalCapital = lignes.filter((l) => l.nature === "capital").reduce((s, l) => s + (l.montant_cents ?? 0), 0);
  const nbBrouillons = new Set(lignes.filter((l) => l.statut === "brouillon").map((l) => l.depense_id)).size;
  const parCategorie = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lignes) {
      const cle = l.categorie_parent ?? l.categorie ?? "À préciser";
      m.set(cle, (m.get(cle) ?? 0) + (l.montant_cents ?? 0));
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [lignes]);

  function exporter() {
    const entetes = [
      "Date", "Fournisseur", "Immeuble", "Logement", "Catégorie", "Catégorie principale", "Ligne T776",
      "Nature", "Montant", "Avant taxes", "TPS", "TVQ", "Total facture", "Paiement", "No facture",
      "Statut", "Description", "Notes", "Nb reçus",
    ];
    const rangs = lignes.map((l) => [
      l.date_facture, l.fournisseur, l.immeuble, l.logement, l.categorie, l.categorie_parent ?? l.categorie,
      l.code_fiscal, l.nature, montantCsv(l.montant_cents), montantCsv(l.sous_total_cents),
      montantCsv(l.tps_cents), montantCsv(l.tvq_cents), montantCsv(l.total_cents), l.mode_paiement,
      l.no_facture, l.statut, l.description, l.notes, l.nb_pieces,
    ]);
    const nom = `depenses_${debut}_${fin}.csv`;
    telechargerFichier(genererCsv(entetes, rangs), nom);
  }

  async function exporterAvecRecus() {
    setExportResultat(null);
    setErreur(null);
    try {
      // Année complète : frais de véhicule inclus
      const r = await exporterDossier(
        lignes, `dossier_depenses_${debut}_${fin}.zip`, setExportEnCours,
        mode === "annee" ? { annee, immeubleIds: [] } : null,
      );
      const vehicule = r.vehiculeCents ? ` Frais de véhicule inclus : ${formatCents(r.vehiculeCents)}.` : "";
      setExportResultat(
        r.manquants
          ? `Dossier créé : ${r.nbRecus} reçus, ${r.manquants} introuvable(s) (voir RECUS_MANQUANTS.txt).${vehicule}`
          : `Dossier créé avec ${r.nbRecus} reçu(s).${vehicule} Décompresse le ZIP avant d'ouvrir le fichier Excel.`
      );
    } catch (e) {
      setErreur(`Export impossible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportEnCours(null);
    }
  }

  if (!pret || !session) return null;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Dépenses</h1>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

      {/* Totaux */}
      <section className="carte">
        <div className="total-periode">
          <span style={{ textTransform: "capitalize" }}>{libellePeriode}</span> : <strong>{formatCents(total)}</strong>
          {nbBrouillons > 0 && <> · <span className="pastille">{nbBrouillons} à compléter</span></>}
        </div>
        {totalCapital > 0 && (
          <p className="aide">Dont {formatCents(totalCapital)} en dépenses en capital (amortissables).</p>
        )}
        {parCategorie.length > 1 && (
          <div className="repartition">
            {parCategorie.map(([nom, cents]) => (
              <div className="repartition-ligne" key={nom}>
                <span>{nom}</span>
                <span className="repartition-barre">
                  <span style={{ width: `${total ? Math.max(2, (cents / total) * 100) : 0}%` }} />
                </span>
                <strong>{formatCents(cents)}</strong>
              </div>
            ))}
          </div>
        )}
        {lignes.length > 0 && (
          <>
            <button className="bouton principal plein" style={{ marginTop: 12 }}
                    onClick={exporterAvecRecus} disabled={exportEnCours !== null}>
              {exportEnCours ?? "Exporter Excel + reçus (ZIP)"}
            </button>
            <button className="bouton plein" style={{ marginTop: 8 }} onClick={exporter} disabled={exportEnCours !== null}>
              Exporter en CSV seulement
            </button>
          </>
        )}
        {exportResultat && <p className="aide" style={{ color: "var(--succes)" }}>{exportResultat}</p>}
        {lignes.length >= LIMITE && (
          <p className="aide">Affichage limité aux {LIMITE} lignes les plus récentes : passe en mode Mois.</p>
        )}
      </section>

      {/* Période */}
      <section className="carte">
        <div className="choix-2">
          <button type="button" className={mode === "mois" ? "actif" : ""} aria-pressed={mode === "mois"}
                  onClick={() => choisirMode("mois")}>Mois</button>
          <button type="button" className={mode === "annee" ? "actif" : ""} aria-pressed={mode === "annee"}
                  onClick={() => choisirMode("annee")}>Année</button>
        </div>
        <div className="selecteur-mois" style={{ marginTop: 12 }}>
          <button className="bouton" onClick={() => decaler(-1)}
                  aria-label={mode === "annee" ? "Année précédente" : "Mois précédent"}>‹</button>
          <strong style={{ textTransform: "capitalize" }}>{mode === "annee" ? annee : moisLisible(`${mois}-01`)}</strong>
          <button className="bouton" onClick={() => decaler(1)}
                  aria-label={mode === "annee" ? "Année suivante" : "Mois suivant"}>›</button>
        </div>
        {!estPeriodeCourante && (
          <button className="lien-filtres" style={{ margin: "8px auto 0" }}
                  onClick={() => (mode === "annee" ? allerAnnee(Number(moisActuel.slice(0, 4))) : allerMois(moisActuel))}>
            {mode === "annee" ? "Revenir à l'année courante" : "Revenir au mois courant"}
          </button>
        )}
      </section>

      {/* Liste */}
      <div className="carte">
        {chargement && <p className="aide">Chargement…</p>}
        {!chargement && lignes.length === 0 && (
          <p className="aide">Aucune dépense pour cette période. Touche « + » pour photographier un reçu.</p>
        )}
        {!chargement && lignes.map((l) => (
          <Link href={`/depense/${l.depense_id}`} className="liste-depense" key={l.ligne_id}>
            <div className="infos">
              <div className="titre">{l.fournisseur ?? "Fournisseur à préciser"}</div>
              <div className="sous">
                {l.date_facture} · {l.immeuble}{l.logement ? ` #${l.logement}` : ""}
                {l.categorie ? ` · ${l.categorie}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="montant">{formatCents(l.montant_cents ?? l.total_cents)}</div>
              {l.statut === "brouillon" && <span className="pastille">Brouillon</span>}
            </div>
          </Link>
        ))}
      </div>

      <Link href="/nouvelle" className="fab" aria-label="Nouvelle dépense">+</Link>
      <BarreOnglets />
    </main>
  );
}
