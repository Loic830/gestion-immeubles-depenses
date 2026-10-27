"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { ajouterMois, aujourdhuiIso, dateLisible } from "@/lib/dates";
import { ecartReleve, SEUIL_ECART_RELEVE, tableauVersements } from "@/lib/amortissement";
import {
  assuranceDansAnnee, avecTableauPreteur, FOURNISSEUR_TAXE, formatTaux, interetsAnnee, LIBELLE_TAXE, pretDansAnnee,
  statutVersement, totauxImmeuble,
  type Assurance, type Hypotheque, type ImmeubleFF, type LigneTableauPreteur, type Releve, type TaxeVersement, type TypeTaxe,
} from "@/lib/fraisFixes";
import BarreOnglets from "@/components/BarreOnglets";
import FeuillePret, { type ModelePret } from "@/components/FeuillePret";
import FeuilleReleve from "@/components/FeuilleReleve";
import FeuilleAssurance, { type ModeleAssurance } from "@/components/FeuilleAssurance";
import FeuilleTaxes from "@/components/FeuilleTaxes";
import FeuillePaiement from "@/components/FeuillePaiement";
import DocumentsPret from "@/components/DocumentsPret";

// Frais fixes (v0.8.6) : une carte par immeuble avec Hypothèque, Assurances et Taxes ; sélecteur d'année.
// Intérêts recalculés à partir de chaque prêt (lib/amortissement.ts) ; le relevé du prêteur a priorité.
// v0.9.18 : tableau d'amortissement du prêteur (s'il est entré) au lieu du calcul ; documents du prêt.
// Année gardée dans l'adresse (?a=2026) ; ?i=<immeuble> n'affiche qu'un immeuble (lien du Profil).

type Feuille =
  | { k: "pret"; immeuble: ImmeubleFF; pret?: Hypotheque; modele?: ModelePret }
  | { k: "releve"; pret: Hypotheque; calcul: number; releve: Releve | null }
  | { k: "assurance"; immeuble: ImmeubleFF; assurance?: Assurance; modele?: ModeleAssurance }
  | { k: "taxes"; immeuble: ImmeubleFF; versement?: TaxeVersement }
  | { k: "paiement"; source: "taxe" | "assurance"; id: string; titre: string; montant: number; fournisseur: string; avis?: string };

/** Nombre de jours de a à b (dates AAAA-MM-JJ). */
function joursEntre(a: string, b: string): number {
  const [a1, m1, j1] = a.split("-").map(Number);
  const [a2, m2, j2] = b.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, j2) - Date.UTC(a1, m1 - 1, j1)) / 86400000);
}

function PastilleStatut({ datePaiement, echeance }: { datePaiement: string | null; echeance: string }) {
  const s = statutVersement(datePaiement, echeance);
  if (s === "paye") return <span className="pastille ok">Payé le {dateLisible(datePaiement)}</span>;
  if (s === "retard") return <span className="pastille vacant">En retard</span>;
  return <span className="pastille">À payer</span>;
}

export default function PageFraisFixes() {
  return (
    <Suspense fallback={null}>
      <Contenu />
    </Suspense>
  );
}

function Contenu() {
  const { session, pret } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const anneeCourante = Number(aujourdhuiIso().slice(0, 4));
  const annee = Number(params.get("a")) || anneeCourante;
  const filtreImmeuble = params.get("i");

  const [immeubles, setImmeubles] = useState<ImmeubleFF[]>([]);
  const [hypotheques, setHypotheques] = useState<Hypotheque[]>([]);
  const [releves, setReleves] = useState<Releve[]>([]);
  const [assurances, setAssurances] = useState<Assurance[]>([]);
  const [taxes, setTaxes] = useState<TaxeVersement[]>([]);
  const [charge, setCharge] = useState(false);
  const [migration011, setMigration011] = useState(true);
  const [feuille, setFeuille] = useState<Feuille | null>(null);
  const [message, setMessage] = useState<{ type: "succes" | "erreur"; texte: string } | null>(null);

  const charger = useCallback(async () => {
    const [im, hy, re, as, tx, tp] = await Promise.all([
      supabase.from("immeubles").select("id, nom, actif").is("deleted_at", null).order("nom"),
      supabase.from("hypotheques").select("*").is("deleted_at", null).order("debut_terme"),
      supabase.from("hypotheque_releves").select("id, hypotheque_id, annee, interets_releve_cents, solde_fin_cents").is("deleted_at", null),
      supabase.from("assurances").select("*").is("deleted_at", null).order("date_debut"),
      supabase.from("taxes_versements").select("*").is("deleted_at", null).order("echeance"),
      // Migration 025 pas encore exécutée : erreur ignorée, l'app garde son calcul.
      supabase.from("hypotheque_versements").select("hypotheque_id, no, date_versement, interets_cents, capital_cents, solde_cents").order("date_versement").limit(5000),
    ]);
    setImmeubles((im.data ?? []) as ImmeubleFF[]);
    if (hy.error || as.error || tx.error) {
      setMigration011(false);
    } else {
      setMigration011(true);
      setHypotheques(avecTableauPreteur(
        ((hy.data ?? []) as Hypotheque[]).map((h) => ({ ...h, taux: Number(h.taux) })),
        tp.error ? [] : (tp.data ?? []) as LigneTableauPreteur[],
      ));
      setReleves((re.data ?? []) as Releve[]);
      setAssurances((as.data ?? []) as Assurance[]);
      setTaxes((tx.data ?? []) as TaxeVersement[]);
    }
    setCharge(true);
  }, []);

  useEffect(() => {
    if (session) charger();
  }, [session, charger]);

  const allerAnnee = (n: number) => {
    const q = new URLSearchParams();
    if (annee + n !== anneeCourante) q.set("a", String(annee + n));
    if (filtreImmeuble) q.set("i", filtreImmeuble);
    router.replace(`/frais-fixes${q.toString() ? `?${q}` : ""}`, { scroll: false });
  };

  // Immeubles affichés : actifs, ou vendus qui ont encore des frais dans l'année.
  const affiches = useMemo(() => immeubles.filter((i) => {
    if (filtreImmeuble && i.id !== filtreImmeuble) return false;
    if (i.actif) return true;
    return hypotheques.some((h) => h.immeuble_id === i.id && pretDansAnnee(h, annee))
      || assurances.some((a) => a.immeuble_id === i.id && assuranceDansAnnee(a, annee))
      || taxes.some((t) => t.immeuble_id === i.id && t.annee === annee);
  }), [immeubles, filtreImmeuble, hypotheques, assurances, taxes, annee]);

  const totaux = useMemo(
    () => Object.fromEntries(affiches.map((i) => [i.id, totauxImmeuble(i.id, annee, hypotheques, releves, assurances, taxes)])),
    [affiches, annee, hypotheques, releves, assurances, taxes],
  );
  const grandTotal = Object.values(totaux).reduce(
    (s, t) => ({ interets: s.interets + t.interets, assurances: s.assurances + t.assurances, taxes: s.taxes + t.taxes, total: s.total + t.total }),
    { interets: 0, assurances: 0, taxes: 0, total: 0 },
  );

  function apresEnregistrement(texte: string) {
    setFeuille(null);
    setMessage({ type: "succes", texte });
    charger();
  }

  async function annulerPaiement(source: "taxe" | "assurance", id: string, avecDepense: boolean) {
    const texte = avecDepense
      ? "Annuler ce paiement ? La dépense inscrite sera retirée de Dépenses."
      : "Annuler ce paiement ? Le versement redeviendra « à payer ».";
    if (!window.confirm(texte)) return;
    const { error } = await supabase.rpc("annuler_paiement_frais_fixe", { p_source: source, p_id: id });
    if (error) return setMessage({ type: "erreur", texte: error.message });
    setMessage({ type: "succes", texte: "Paiement annulé." });
    charger();
  }

  async function ouvrirPolice(documentId: string) {
    const { data: doc } = await supabase.from("documents").select("storage_key").eq("id", documentId).single();
    if (!doc) return setMessage({ type: "erreur", texte: "Police introuvable." });
    const { data } = await supabase.storage.from(BUCKET_RECUS).createSignedUrl(doc.storage_key, 600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  if (!pret || !session) return null;
  const aujourdhui = aujourdhuiIso();

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Frais fixes</h1>
        {filtreImmeuble && (
          <button className="bouton" onClick={() => router.replace(annee !== anneeCourante ? `/frais-fixes?a=${annee}` : "/frais-fixes")}>
            Tous les immeubles
          </button>
        )}
      </div>

      <div className="carte selecteur-mois">
        <button className="bouton" aria-label="Année précédente" onClick={() => allerAnnee(-1)}>‹</button>
        <strong>{annee}</strong>
        <button className="bouton" aria-label="Année suivante" onClick={() => allerAnnee(1)}>›</button>
      </div>

      {!migration011 && (
        <div className="message alerte">Exécuter supabase/011_frais_fixes.sql dans Supabase pour activer cette page.</div>
      )}
      {message && <div className={`message ${message.type}`} onClick={() => setMessage(null)}>{message.texte}</div>}

      {migration011 && charge && affiches.length > 0 && (
        <div className="carte">
          <strong>Frais fixes {annee}</strong>
          <div style={{ marginTop: 8 }}>
            {affiches.map((i) => (
              <div key={i.id} className="paiement-ligne">
                <span>{i.nom}</span>
                <strong>{formatCents(totaux[i.id]?.total ?? 0)}</strong>
              </div>
            ))}
            {affiches.length > 1 && (
              <div className="paiement-ligne" style={{ borderBottom: "none" }}>
                <span>Total</span>
                <strong>{formatCents(grandTotal.total)}</strong>
              </div>
            )}
          </div>
          <p className="aide">
            Intérêts {formatCents(grandTotal.interets)} (T776 ligne 8710) · Assurances {formatCents(grandTotal.assurances)} ·
            Taxes {formatCents(grandTotal.taxes)}. Intérêts : relevé du prêteur s&apos;il est entré, sinon le calcul de l&apos;app.
          </p>
        </div>
      )}

      {migration011 && affiches.map((im) => {
        const prets = hypotheques.filter((h) => h.immeuble_id === im.id && pretDansAnnee(h, annee));
        const polices = assurances.filter((a) => a.immeuble_id === im.id && assuranceDansAnnee(a, annee));
        const versements = taxes.filter((t) => t.immeuble_id === im.id && t.annee === annee);
        const t = totaux[im.id];
        return (
          <section key={im.id}>
            <div className="entete" style={{ margin: "24px 0 8px" }}>
              <h2 className="immeuble-titre" style={{ margin: 0 }}>{im.nom}{!im.actif ? " (vendu)" : ""}</h2>
              <span className="aide" style={{ margin: 0 }}>{formatCents(t?.total ?? 0)}</span>
            </div>

            {/* ---------------- Hypothèque ---------------- */}
            <div className="carte">
              <strong>Hypothèque</strong>
              {prets.length === 0 && <p className="aide">Aucun prêt pour {annee}.</p>}
              {prets.map((h) => {
                const r = interetsAnnee(h, annee, releves);
                const ecart = r.releve ? ecartReleve(r.interets, r.releve.interets_releve_cents) : 0;
                const joursFin = joursEntre(aujourdhui, h.fin_terme);
                const tableau = tableauVersements(h).filter((v) => v.date.startsWith(String(annee)));
                const renouvele = hypotheques.some((x) => x.id !== h.id && x.immeuble_id === h.immeuble_id
                  && x.nom_pret === h.nom_pret && x.debut_terme >= h.fin_terme);
                const tous = tableauVersements(h);
                const finTerme = tous[tous.length - 1];
                const selonBanque = tableau.length > 0 && tableau.every((v) => v.preteur);
                return (
                  <div key={h.id} className="bloc-locataire">
                    <div className="entete" style={{ marginBottom: 4 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{h.nom_pret}{h.preteur ? ` · ${h.preteur}` : ""}</div>
                        <div className="aide" style={{ marginTop: 2 }}>
                          {formatTaux(h.taux)} · {formatCents(h.versement_cents)}/mois · terme jusqu&apos;au {dateLisible(h.fin_terme)}
                        </div>
                      </div>
                      {!renouvele && joursFin < 0 && <span className="pastille vacant">Terme échu</span>}
                      {!renouvele && joursFin >= 0 && joursFin <= 120 && <span className="pastille">Renouvellement dans {joursFin} j</span>}
                    </div>
                    <dl className="champs" style={{ marginTop: 8 }}>
                      <div className="champ-groupe"><dt>Intérêts {annee} ({selonBanque ? "tableau du prêteur" : "calcul"})</dt><dd>{formatCents(r.interets)}</dd></div>
                      <div className="champ-groupe">
                        <dt>Relevé du prêteur</dt>
                        <dd>{r.releve ? formatCents(r.releve.interets_releve_cents) : <span className="aide">à entrer</span>}</dd>
                      </div>
                      <div className="champ-groupe"><dt>Capital remboursé</dt><dd>{formatCents(r.capital)}</dd></div>
                      <div className="champ-groupe">
                        <dt>Solde au {r.nbVersements && h.fin_terme <= `${annee}-12-31` ? dateLisible(h.fin_terme) : "31 déc."}</dt>
                        <dd>{formatCents(r.releve?.solde_fin_cents ?? r.soldeFin)}</dd>
                      </div>
                    </dl>
                    {r.releve && ecart > SEUIL_ECART_RELEVE && (
                      <div className="message alerte" style={{ marginTop: 8 }}>
                        Écart de {(ecart * 100).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} % entre le calcul et le relevé.
                        Le relevé a priorité ; vérifie le taux, le solde ou la date du premier versement.
                      </div>
                    )}
                    <div className="rangee" style={{ marginTop: 10 }}>
                      <button className="bouton" onClick={() => setFeuille({ k: "releve", pret: h, calcul: r.interets, releve: r.releve })}>
                        Relevé {annee}
                      </button>
                      <button className="bouton" onClick={() => setFeuille({ k: "pret", immeuble: im, pret: h })}>Modifier</button>
                    </div>
                    {!renouvele && joursFin <= 180 && (
                      <button className="bouton plein" style={{ marginTop: 8 }} onClick={() => setFeuille({
                        k: "pret", immeuble: im, modele: {
                          nom_pret: h.nom_pret, preteur: h.preteur, no_pret: h.no_pret,
                          solde_debut_terme_cents: finTerme?.solde ?? h.solde_debut_terme_cents,
                          debut_terme: h.fin_terme, fin_terme: ajouterMois(h.fin_terme, 60),
                          premier_versement: ajouterMois(h.fin_terme, 1),
                          amortissement_mois: h.amortissement_mois ? Math.max(h.amortissement_mois - tous.length, 1) : null,
                        },
                      })}>Renouveler le terme</button>
                    )}
                    {tableau.length > 0 && (
                      <details style={{ marginTop: 8 }}>
                        <summary>Versements {annee} ({tableau.length})</summary>
                        <p className="aide">
                          {selonBanque
                            ? "Chiffres du tableau d'amortissement du prêteur (l'intérêt est compté au nombre de jours, donc chaque mois est un peu différent)."
                            : tableau.some((v) => v.preteur)
                              ? "Chiffres du prêteur jusqu'à la fin de son tableau, puis calculés par l'app."
                              : "Chiffres calculés par l'app (mois égaux). La banque compte au nombre de jours : un mois peut différer de quelques dollars, le total de l'année reste presque le même."}
                        </p>
                        {tableau.map((v) => (
                          <div key={v.no} className="paiement-ligne">
                            <span>{dateLisible(v.date)}</span>
                            <span className="aide" style={{ margin: 0 }}>int. {formatCents(v.interets)} · cap. {formatCents(v.capital)}</span>
                          </div>
                        ))}
                      </details>
                    )}
                    <DocumentsPret hypothequeId={h.id} setErreur={(m) => setMessage(m ? { type: "erreur", texte: m } : null)} />
                  </div>
                );
              })}
              {prets.length > 1 && (
                <p className="aide">Intérêts {annee}, tous les prêts : <strong>{formatCents(t?.interets ?? 0)}</strong></p>
              )}
              <button className="lien-filtres" onClick={() => setFeuille({ k: "pret", immeuble: im })}>+ Ajouter un prêt</button>
            </div>

            {/* ---------------- Assurances ---------------- */}
            <div className="carte">
              <strong>Assurances</strong>
              {polices.length === 0 && <p className="aide">Aucune police pour {annee}.</p>}
              {polices.map((a) => {
                const renouvelee = assurances.some((x) => x.id !== a.id && x.immeuble_id === a.immeuble_id && x.date_debut >= a.date_renouvellement);
                const joursRenouv = joursEntre(aujourdhui, a.date_renouvellement);
                return (
                  <div key={a.id} className="bloc-locataire">
                    <div className="entete" style={{ marginBottom: 4 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{a.assureur}{a.no_police ? ` · ${a.no_police}` : ""}</div>
                        <div className="aide" style={{ marginTop: 2 }}>
                          {formatCents(a.prime_annuelle_cents)}/an ({a.mode_paiement === "mensuel" ? "mensuel" : "annuel"}) ·
                          du {dateLisible(a.date_debut)} au {dateLisible(a.date_renouvellement)}
                        </div>
                      </div>
                      <PastilleStatut datePaiement={a.date_paiement} echeance={a.date_debut} />
                    </div>
                    {!renouvelee && joursRenouv >= 0 && joursRenouv <= 30 && (
                      <div className="message alerte" style={{ marginTop: 8 }}>Renouvellement dans {joursRenouv} jour(s).</div>
                    )}
                    <div className="rangee" style={{ marginTop: 10 }}>
                      {a.date_paiement ? (
                        <button className="bouton" onClick={() => annulerPaiement("assurance", a.id, !!a.depense_id)}>Annuler le paiement</button>
                      ) : (
                        <button className="bouton principal" onClick={() => setFeuille({
                          k: "paiement", source: "assurance", id: a.id, montant: a.prime_annuelle_cents, fournisseur: a.assureur,
                          titre: `Assurance ${a.assureur} · ${im.nom}`,
                          avis: a.mode_paiement === "mensuel"
                            ? "Paiement mensuel : la dépense inscrite sera la prime de l'année au complet."
                            : undefined,
                        })}>Payé</button>
                      )}
                      <button className="bouton" onClick={() => setFeuille({ k: "assurance", immeuble: im, assurance: a })}>Modifier</button>
                    </div>
                    <div className="rangee" style={{ marginTop: 8 }}>
                      {a.document_id && <button className="bouton" onClick={() => ouvrirPolice(a.document_id!)}>Voir la police</button>}
                      {!renouvelee && joursRenouv <= 60 && (
                        <button className="bouton" onClick={() => setFeuille({
                          k: "assurance", immeuble: im, modele: {
                            assureur: a.assureur, no_police: a.no_police, prime_annuelle_cents: a.prime_annuelle_cents,
                            date_debut: a.date_renouvellement, mode_paiement: a.mode_paiement, notes: a.notes,
                          },
                        })}>Renouveler</button>
                      )}
                    </div>
                  </div>
                );
              })}
              <button className="lien-filtres" onClick={() => setFeuille({ k: "assurance", immeuble: im })}>+ Ajouter une assurance</button>
            </div>

            {/* ---------------- Taxes ---------------- */}
            <div className="carte">
              <strong>Taxes {annee}</strong>
              {versements.length === 0 && <p className="aide">Aucun compte de taxes pour {annee}.</p>}
              {(["fonciere", "scolaire"] as TypeTaxe[]).map((type) => {
                const liste = versements.filter((v) => v.type === type);
                if (liste.length === 0) return null;
                const total = liste.reduce((s, v) => s + v.montant_cents, 0);
                return (
                  <div key={type} style={{ marginTop: 10 }}>
                    <div className="paiement-ligne" style={{ fontWeight: 600 }}>
                      <span>{LIBELLE_TAXE[type]}</span><span>{formatCents(total)}</span>
                    </div>
                    {liste.map((v, n) => (
                      <div key={v.id} className="paiement-ligne">
                        <button className="lien-ligne" style={{ flex: 1 }} onClick={() => setFeuille({ k: "taxes", immeuble: im, versement: v })}>
                          <div>{liste.length > 1 ? `${n + 1}. ` : ""}{dateLisible(v.echeance)} · <strong>{formatCents(v.montant_cents)}</strong></div>
                          <PastilleStatut datePaiement={v.date_paiement} echeance={v.echeance} />
                        </button>
                        {v.date_paiement ? (
                          <button className="lien-retirer" onClick={() => annulerPaiement("taxe", v.id, !!v.depense_id)}>Annuler</button>
                        ) : (
                          <button className="bouton principal" style={{ padding: "8px 14px" }} onClick={() => setFeuille({
                            k: "paiement", source: "taxe", id: v.id, montant: v.montant_cents, fournisseur: FOURNISSEUR_TAXE[type],
                            titre: `${LIBELLE_TAXE[type]} ${v.annee} · ${im.nom} · échéance ${dateLisible(v.echeance)}`,
                          })}>Payé</button>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
              <button className="lien-filtres" onClick={() => setFeuille({ k: "taxes", immeuble: im })}>+ Ajouter un compte de taxes</button>
            </div>
          </section>
        );
      })}

      {migration011 && charge && affiches.length === 0 && <p className="aide">Aucun immeuble actif.</p>}

      {feuille?.k === "pret" && (
        <FeuillePret immeubleId={feuille.immeuble.id} immeubleNom={feuille.immeuble.nom} pret={feuille.pret} modele={feuille.modele}
                     onFermer={() => setFeuille(null)} onEnregistre={apresEnregistrement} />
      )}
      {feuille?.k === "releve" && (
        <FeuilleReleve pret={feuille.pret} annee={annee} calculCents={feuille.calcul} releve={feuille.releve}
                       onFermer={() => setFeuille(null)} onEnregistre={apresEnregistrement} />
      )}
      {feuille?.k === "assurance" && (
        <FeuilleAssurance immeubleId={feuille.immeuble.id} immeubleNom={feuille.immeuble.nom} assurance={feuille.assurance}
                          modele={feuille.modele} onFermer={() => setFeuille(null)} onEnregistre={apresEnregistrement} />
      )}
      {feuille?.k === "taxes" && (
        <FeuilleTaxes immeubleId={feuille.immeuble.id} immeubleNom={feuille.immeuble.nom} annee={annee} versement={feuille.versement}
                      onFermer={() => setFeuille(null)} onEnregistre={apresEnregistrement} />
      )}
      {feuille?.k === "paiement" && (
        <FeuillePaiement source={feuille.source} id={feuille.id} titre={feuille.titre} montantCents={feuille.montant}
                         fournisseurDefaut={feuille.fournisseur} avis={feuille.avis}
                         onFermer={() => setFeuille(null)} onEnregistre={apresEnregistrement} />
      )}

      <BarreOnglets />
    </main>
  );
}
