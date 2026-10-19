"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { ajouterMois, aujourdhuiIso, finDuMois, moisLisible } from "@/lib/dates";
import BarreOnglets from "@/components/BarreOnglets";
import { Anneau, Barres, Legende, MOIS_COURTS, couleur } from "@/components/Graphiques";

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


type Immeuble = { id: string; nom: string };

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
  // Immeubles choisis, lus dans l'URL : ?i=id1,id2 (aucun = tous les immeubles)
  const immeublesParam = params.get("i") ?? "";
  const choisis = useMemo(() => immeublesParam.split(",").filter(Boolean), [immeublesParam]);

  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);

  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  function allerA(periode: string, ids: string[] = choisis) {
    const requete = [periode, ids.length ? `i=${ids.join(",")}` : ""].filter(Boolean).join("&");
    router.replace(requete ? `/?${requete}` : "/", { scroll: false });
  }
  const periodeActuelle = mode === "annee" ? `a=${annee}` : mois === moisActuel ? "" : `m=${mois}`;
  function basculerImmeuble(id: string) {
    const ids = choisis.includes(id) ? choisis.filter((x) => x !== id) : [...choisis, id];
    // Tous cochés = aucun filtre
    allerA(periodeActuelle, ids.length === immeubles.length ? [] : ids);
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
    supabase.from("immeubles").select("id, nom").is("deleted_at", null).order("nom")
      .then(({ data }) => setImmeubles((data ?? []) as Immeuble[]));
  }, [session]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      setChargement(true);
      setErreur(null);
      let requete = supabase
        .from("v_depenses_detail")
        .select("*")
        .gte("date_facture", debut)
        .lte("date_facture", fin);
      if (choisis.length) requete = requete.in("immeuble_id", choisis);
      const { data, error } = await requete
        .order("date_facture", { ascending: false })
        .limit(LIMITE);
      if (error) setErreur(error.message);
      else setLignes((data ?? []) as Ligne[]);
      setChargement(false);
    })();
  }, [session, debut, fin, choisis]);

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
  // Anneau : les 5 plus grosses catégories, le reste dans « Autres »
  const partsAnneau = useMemo(() => {
    const tete = parCategorie.slice(0, 5);
    const reste = parCategorie.slice(5).reduce((s, [, c]) => s + c, 0);
    return reste > 0 ? [...tete, ["Autres", reste] as [string, number]] : tete;
  }, [parCategorie]);
  // Barres : par mois en mode Année, par semaine (1-7, 8-14, …) en mode Mois
  const colonnes = useMemo(() => {
    if (mode === "annee") {
      const v = Array(12).fill(0);
      for (const l of lignes) v[Number(l.date_facture.slice(5, 7)) - 1] += l.montant_cents ?? 0;
      return v.map((c, i) => ({ etiquette: MOIS_COURTS[i], valeurs: [c] }));
    }
    const dernier = Number(fin.slice(8, 10));
    const v = [0, 0, 0, 0, 0];
    for (const l of lignes) v[Math.min(4, Math.floor((Number(l.date_facture.slice(8, 10)) - 1) / 7))] += l.montant_cents ?? 0;
    return v.map((c, i) => ({
      etiquette: i === 4 ? `29-${dernier}` : `${i * 7 + 1}-${i * 7 + 7}`,
      valeurs: [c],
    }));
  }, [lignes, mode, fin]);
  const colonneActive = estPeriodeCourante
    ? mode === "annee" ? Number(moisActuel.slice(5, 7)) - 1 : Math.min(4, Math.floor((Number(aujourdhuiIso().slice(8, 10)) - 1) / 7))
    : undefined;

  const nomsChoisis = immeubles.filter((im) => choisis.includes(im.id)).map((im) => im.nom).join(", ");

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
          <span style={{ textTransform: "capitalize" }}>{libellePeriode}</span>
          {nomsChoisis && <> · {nomsChoisis}</>} : <strong>{formatCents(total)}</strong>
          {nbBrouillons > 0 && <> · <span className="pastille">{nbBrouillons} à compléter</span></>}
        </div>
        {totalCapital > 0 && (
          <p className="aide">Dont {formatCents(totalCapital)} en dépenses en capital (amortissables).</p>
        )}
        {parCategorie.length > 0 && (
          <>
            <div className="graphique-haut">
              <Anneau total={total} parts={partsAnneau.map(([, c], i) => ({ valeur: c, couleur: couleur(i) }))}
                      centre={String(parCategorie.length)} sousCentre={parCategorie.length > 1 ? "catégories" : "catégorie"} taille={96} />
              <Legende lignes={partsAnneau.map(([nom, cents], i) => ({
                nom, cents, couleur: couleur(i),
                detail: total ? `${Math.round((cents / total) * 100)} %` : undefined,
              }))} />
            </div>
            <Barres colonnes={colonnes} actif={colonneActive} />
            <p className="aide" style={{ textAlign: "center", marginTop: 4 }}>
              {mode === "annee" ? "Dépenses par mois" : "Dépenses par semaine du mois (jours)"}
            </p>
          </>
        )}
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

      {/* Immeubles */}
      {immeubles.length > 1 && (
        <section className="carte">
          <strong>Immeubles</strong>
          <div className="puces">
            <span className={`puce${choisis.length === 0 ? " actif" : ""}`}>
              <button type="button" aria-pressed={choisis.length === 0} onClick={() => allerA(periodeActuelle, [])}>Tous</button>
            </span>
            {immeubles.map((im) => (
              <span key={im.id} className={`puce${choisis.includes(im.id) ? " actif" : ""}`}>
                <button type="button" aria-pressed={choisis.includes(im.id)} onClick={() => basculerImmeuble(im.id)}>{im.nom}</button>
              </span>
            ))}
          </div>
          <p className="aide">Touche un ou plusieurs immeubles pour voir seulement leurs dépenses.</p>
        </section>
      )}

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
