"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { aujourdhuiIso, moisLisible, triNumero } from "@/lib/dates";
import BarreOnglets from "@/components/BarreOnglets";
import { Anneau, couleur } from "@/components/Graphiques";
import FeuilleLoyer, { lienTexto, numero, partOmh, resteARecevoir, soldeLocataire, soldeOmh, type Solde } from "@/components/FeuilleLoyer";

type Logement = { id: string; immeuble_id: string; numero: string };
type Immeuble = { id: string; nom: string };

function moisCourant(): string {
  return aujourdhuiIso().slice(0, 7) + "-01";
}
function decalerMois(mois: string, n: number): string {
  const [a, m] = mois.split("-").map(Number);
  const d = new Date(a, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function PageLoyers() {
  return (
    <Suspense fallback={null}>
      <Loyers />
    </Suspense>
  );
}

function Loyers() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, pret } = useSession();
  const mois = /^\d{4}-\d{2}$/.test(params.get("m") ?? "") ? `${params.get("m")}-01` : moisCourant();

  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [soldesMois, setSoldesMois] = useState<Solde[]>([]);
  const [retards, setRetards] = useState<Solde[]>([]);
  // Dépôts faits (paiements reçus, sans les crédits ni les chèques en main) par échéance du mois affiché
  const [depots, setDepots] = useState<Map<string, number>>(new Map());
  // Dont les dépôts de l'OMH (v0.9.12)
  const [depotsOmh, setDepotsOmh] = useState(0);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  // Feuille du mois (paiements, crédit, détail d'un paiement : components/FeuilleLoyer)
  const [choisie, setChoisie] = useState<string | null>(null);
  // Encadré du haut : total, ou ventilé par immeuble quand on le touche
  const [parImmeuble, setParImmeuble] = useState(false);

  const charger = useCallback(async () => {
    setErreur(null);
    const [im, lo, so, re] = await Promise.all([
      supabase.from("immeubles").select("id, nom").is("deleted_at", null).order("nom"),
      supabase.from("logements").select("id, immeuble_id, numero").is("deleted_at", null).eq("actif", true),
      supabase.from("v_soldes").select("*").eq("mois", mois),
      supabase.from("v_soldes").select("*").gt("jours_retard", 0).order("date_echeance"),
    ]);
    const err = [im, lo, so, re].find((r) => r.error)?.error;
    if (err) setErreur(err.message);
    setImmeubles((im.data ?? []) as Immeuble[]);
    setLogements(((lo.data ?? []) as Logement[]).sort((a, b) => triNumero(a.numero, b.numero)));
    const soldes = (so.data ?? []) as Solde[];
    setSoldesMois(soldes);
    const parEcheance = new Map<string, number>();
    let omh = 0;
    if (soldes.length) {
      const { data, error } = await supabase.from("paiements")
        .select("*")   // avec payeur après la migration 022
        .in("echeance_id", soldes.map((x) => x.echeance_id))
        .eq("statut", "recu").neq("mode", "credit").is("deleted_at", null);
      if (error) setErreur(error.message);
      for (const p of (data ?? []) as { echeance_id: string; montant_cents: number; payeur?: string }[]) {
        parEcheance.set(p.echeance_id, (parEcheance.get(p.echeance_id) ?? 0) + p.montant_cents);
        if (p.payeur === "omh") omh += p.montant_cents;
      }
    }
    setDepots(parEcheance);
    setDepotsOmh(omh);
    setRetards((re.data ?? []) as Solde[]);
    setChargement(false);
  }, [mois]);

  useEffect(() => {
    if (!session) return;
    (async () => {
      await supabase.rpc("prolonger_echeances");
      await charger();
    })();
  }, [session, charger]);

  const ouvrir = (s: Solde) => setChoisie(s.echeance_id);

  const totaux = useMemo(() => ({
    depots: soldesMois.reduce((s, x) => s + (depots.get(x.echeance_id) ?? 0), 0),
    du: soldesMois.reduce((s, x) => s + x.montant_du_cents, 0),
    recu: soldesMois.reduce((s, x) => s + x.recu_cents, 0),
    retard: retards.reduce((s, x) => s + resteARecevoir(x), 0),
    reste: soldesMois.reduce((s, x) => s + resteARecevoir(x), 0),
  }), [soldesMois, retards, depots]);
  const totauxImmeubles = useMemo(() => immeubles.map((im) => {
    const liste = soldesMois.filter((x) => x.immeuble_id === im.id);
    return {
      im,
      depots: liste.reduce((s, x) => s + (depots.get(x.echeance_id) ?? 0), 0),
      du: liste.reduce((s, x) => s + x.montant_du_cents, 0),
      recu: liste.reduce((s, x) => s + x.recu_cents, 0),
      reste: liste.reduce((s, x) => s + resteARecevoir(x), 0),
    };
  }), [immeubles, soldesMois, depots]);

  if (!pret || !session) return null;

  const estMoisCourant = mois === moisCourant();
  const aller = (n: number) => router.replace(`/loyers?m=${decalerMois(mois, n).slice(0, 7)}`, { scroll: false });
  const pctDepose = totaux.du ? Math.min(100, Math.round((totaux.depots / totaux.du) * 100)) : 0;
  const credits = totaux.recu - totaux.depots;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Loyers</h1>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

      {/* Dépôts faits ce mois-ci ; toucher = par immeuble (v0.9.4) */}
      <div role="button" tabIndex={0} className="carte encadre-touchable" aria-expanded={parImmeuble}
           onClick={() => setParImmeuble(!parImmeuble)}
           onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setParImmeuble(!parImmeuble); } }}>
        <div className="chiffre-libelle">
          Dépôts faits en <span>{moisLisible(mois)}</span>
        </div>
        <div className="graphique-haut" style={{ marginTop: 6 }}>
          <Anneau total={totaux.du} parts={[{ valeur: totaux.depots, couleur: "var(--accent)" }]}
                  centre={`${pctDepose} %`} sousCentre="déposé" taille={96} />
          <div>
            <div className="chiffre">{formatCents(totaux.depots)}</div>
            <div className="chiffre-libelle">Déposé sur {formatCents(totaux.du)} dus</div>
            {depotsOmh > 0 && <div className="chiffre-libelle">Dont {formatCents(depotsOmh)} de l&apos;OMH</div>}
            {credits > 0 && <div className="chiffre-libelle">+ {formatCents(credits)} en crédits au locataire</div>}
            {totaux.reste > 0 && <div className="chiffre-libelle">Reste à recevoir : {formatCents(totaux.reste)}</div>}
          </div>
        </div>
        {parImmeuble && (
          <div className="ventilation">
            {totauxImmeubles.map(({ im, depots: dep, du }, i) => (
              <div className="ventilation-ligne" key={im.id}>
                <div className="entete">
                  <strong>{im.nom}</strong>
                  <strong>{formatCents(dep)}</strong>
                </div>
                <div className="repartition-barre">
                  <span style={{ width: `${du ? Math.min(100, (dep / du) * 100) : 0}%`, background: couleur(i) }} />
                </div>
                <div className="chiffre-libelle">Déposé {formatCents(dep)} sur {formatCents(du)} dus</div>
              </div>
            ))}
          </div>
        )}
        <div className="encadre-indice">{parImmeuble ? "Toucher pour revenir au total" : "Toucher pour voir par immeuble"}</div>
      </div>

      {/* Mois */}
      <section className="carte">
        <div className="selecteur-mois">
          <button className="bouton" onClick={() => aller(-1)} aria-label="Mois précédent">‹</button>
          <strong style={{ textTransform: "capitalize" }}>{moisLisible(mois)}</strong>
          <button className="bouton" onClick={() => aller(1)} aria-label="Mois suivant">›</button>
        </div>
        {!estMoisCourant && (
          <button className="lien-filtres" style={{ margin: "8px auto 0" }} onClick={() => router.replace("/loyers")}>Revenir au mois courant</button>
        )}
      </section>

      {/* Retards, tous mois confondus */}
      {retards.length > 0 && (
        <section className="carte">
          <div className="entete" style={{ marginBottom: 4 }}>
            <strong style={{ color: "var(--erreur)" }}>En retard</strong>
            <strong style={{ color: "var(--erreur)" }}>{formatCents(totaux.retard)}</strong>
          </div>
          {/* v0.9.12 : la part de l'OMH en retard a sa propre ligne, sans Appeler ni Texter */}
          {retards.filter((r) => soldeOmh(r) > 0).map((r) => (
            <div className="logement-ligne" key={`omh-${r.echeance_id}`}>
              <span className="logement-numero">{r.logement}</span>
              <button className="infos lien-ligne" onClick={() => ouvrir(r)}>
                <div className="titre"><span className="pastille omh" style={{ marginRight: 6 }}>OMH</span>{r.locataires ?? "Locataire"}</div>
                <div className="sous">Supplément au loyer · {r.immeuble} · <span style={{ textTransform: "capitalize" }}>{moisLisible(r.mois)}</span> · {r.jours_retard} j</div>
              </button>
              <div style={{ textAlign: "right" }}>
                <div className="montant">{formatCents(soldeOmh(r))}</div>
                <div className="sous ligne-omh" style={{ fontSize: 13 }}>Vérifier avec l&apos;OMH</div>
              </div>
            </div>
          ))}
          {retards.filter((r) => soldeLocataire(r) > 0).map((r) => (
            <div className="logement-ligne" key={r.echeance_id}>
              <span className="logement-numero">{r.logement}</span>
              <button className="infos lien-ligne" onClick={() => ouvrir(r)}>
                <div className="titre">{r.locataires ?? "Locataire"}</div>
                <div className="sous">{r.immeuble} · <span style={{ textTransform: "capitalize" }}>{moisLisible(r.mois)}</span> · {r.jours_retard} j</div>
              </button>
              <div style={{ textAlign: "right" }}>
                <div className="montant">{formatCents(soldeLocataire(r))}</div>
                {r.telephone ? (
                  <div className="contact-locataire">
                    <a className="lien-tel" href={`tel:${numero(r.telephone)}`}>Appeler</a>
                    <a className="lien-tel" href={lienTexto(r)}>Texter</a>
                  </div>
                ) : (
                  <Link className="lien-tel" style={{ color: "var(--discret)" }} href={`/baux/${r.bail_id}/modifier`}>Ajouter un numéro</Link>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {chargement && <p className="aide">Chargement…</p>}

      {/* Mois sélectionné, par immeuble */}
      {!chargement && immeubles.map((im) => {
        const lignes = logements.filter((l) => l.immeuble_id === im.id);
        return (
          <section key={im.id}>
            <h2 className="immeuble-titre">{im.nom}</h2>
            <div className="carte" style={{ paddingTop: 4, paddingBottom: 4 }}>
              {lignes.map((l) => {
                const duLogement = soldesMois.filter((x) => x.logement_id === l.id);
                if (duLogement.length === 0) {
                  return (
                    <div className="logement-ligne" key={l.id}>
                      <span className="logement-numero">{l.numero}</span>
                      <div className="infos"><div className="titre" style={{ color: "var(--discret)" }}>Aucun bail ce mois-ci</div></div>
                      <span className="pastille vacant">Vacant</span>
                    </div>
                  );
                }
                // Départ et arrivée dans le même mois : une ligne par bail
                return duLogement.map((s) => {
                const paye = resteARecevoir(s) <= 0;
                const omh = partOmh(s) > 0;
                return (
                  <button className="logement-ligne lien-ligne" key={s.echeance_id} onClick={() => ouvrir(s)}>
                    <span className="logement-numero">{l.numero}</span>
                    <div className="infos">
                      <div className="titre">{s.locataires ?? "Locataire"}</div>
                      <div className="sous">
                        {formatCents(s.montant_du_cents)}
                        {omh && <span className="ligne-omh"> · dont OMH {formatCents(partOmh(s))}</span>}
                        {s.recu_cents > 0 && (!paye || s.recu_cents !== s.montant_du_cents) && ` · reçu ${formatCents(s.recu_cents)}`}
                      </div>
                    </div>
                    {paye
                      ? <span className="pastille ok">{s.solde_cents < 0 ? `Payé (+${formatCents(-s.solde_cents)})` : "Payé"}</span>
                      : omh && soldeLocataire(s) <= 0
                        ? <span className="pastille omh">{s.jours_retard > 0 ? "Retard OMH" : "OMH à recevoir"}</span>
                      : s.jours_retard > 0
                        ? <span className="pastille vacant">Retard</span>
                        : s.recu_cents > 0 ? <span className="pastille">Partiel</span>
                        : <span className="pastille gris">À recevoir</span>}
                  </button>
                );
                });
              })}
            </div>
          </section>
        );
      })}

      {/* Feuille du mois */}
      {choisie && <FeuilleLoyer echeanceId={choisie} onFermer={() => setChoisie(null)} onChange={charger} />}

      <BarreOnglets />
    </main>
  );
}
