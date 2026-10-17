"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents, versCents, centsVersSaisie } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, moisLisible, triNumero } from "@/lib/dates";
import BarreOnglets from "@/components/BarreOnglets";

type Mode = "interac" | "cheque" | "prelevement" | "comptant" | "credit";
type Solde = {
  echeance_id: string;
  mois: string;
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
};
type Paiement = { id: string; montant_cents: number; mode: Mode; statut: string; date_recue: string | null; reference: string | null; notes: string | null };
type Logement = { id: string; immeuble_id: string; numero: string };
type Immeuble = { id: string; nom: string };

const MODES: { code: Mode; libelle: string }[] = [
  { code: "interac", libelle: "Interac" },
  { code: "cheque", libelle: "Chèque" },
  { code: "prelevement", libelle: "Prélèvement" },
  { code: "comptant", libelle: "Comptant" },
];
const libelleMode = (m: Mode) => (m === "credit" ? "Crédit" : MODES.find((x) => x.code === m)?.libelle ?? m);

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
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  // Feuille de paiement
  const [choisie, setChoisie] = useState<Solde | null>(null);
  const [paiements, setPaiements] = useState<Paiement[]>([]);
  const [montantSaisi, setMontantSaisi] = useState("");
  const [mode, setMode] = useState<Mode>("interac");
  const [dateRecue, setDateRecue] = useState(aujourdhuiIso());
  const [reference, setReference] = useState("");
  const [envoi, setEnvoi] = useState(false);
  // Crédit au locataire (ex. achat remboursé sur le loyer)
  const [creditOuvert, setCreditOuvert] = useState(false);
  const [montantCredit, setMontantCredit] = useState("");
  const [raisonCredit, setRaisonCredit] = useState("");

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
    setSoldesMois((so.data ?? []) as Solde[]);
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

  async function ouvrir(s: Solde) {
    setChoisie(s);
    setMontantSaisi(centsVersSaisie(Math.max(s.solde_cents, 0)));
    setMode(s.mode_paiement);
    setDateRecue(aujourdhuiIso());
    setReference("");
    setCreditOuvert(false);
    setMontantCredit("");
    setRaisonCredit("");
    const { data } = await supabase
      .from("paiements")
      .select("id, montant_cents, mode, statut, date_recue, reference, notes")
      .eq("echeance_id", s.echeance_id)
      .is("deleted_at", null)
      .order("created_at");
    setPaiements((data ?? []) as Paiement[]);
  }

  async function enregistrerPaiement() {
    if (!choisie) return;
    const cents = versCents(montantSaisi);
    if (cents === null || cents <= 0) return setErreur("Entre un montant valide (ex. 950,00).");
    setEnvoi(true);
    const { error } = await supabase.from("paiements").insert({
      echeance_id: choisie.echeance_id,
      montant_cents: cents,
      mode,
      statut: "recu",
      date_recue: dateRecue,
      reference: reference.trim() || null,
    });
    setEnvoi(false);
    if (error) return setErreur(error.message);
    setChoisie(null);
    await charger();
  }

  // Rouvre la feuille avec le solde à jour (après un crédit, on enregistre souvent le reste tout de suite)
  async function rafraichirChoisie(echeanceId: string) {
    const { data } = await supabase.from("v_soldes").select("*").eq("echeance_id", echeanceId).single();
    if (data) await ouvrir(data as Solde);
    else setChoisie(null);
  }

  async function enregistrerCredit() {
    if (!choisie) return;
    const cents = versCents(montantCredit);
    if (cents === null || cents <= 0) return setErreur("Entre le montant du crédit (ex. 150,00).");
    if (!raisonCredit.trim()) return setErreur("Indique la raison du crédit (ex. porte achetée par le locataire).");
    if (cents > choisie.solde_cents && !window.confirm(
      `Le crédit (${formatCents(cents)}) dépasse le solde du mois (${formatCents(choisie.solde_cents)}). Continuer ?`
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
    await charger();
    await rafraichirChoisie(choisie.echeance_id);
  }

  async function annulerPaiement(p: Paiement) {
    if (!window.confirm(`Annuler ce paiement de ${formatCents(p.montant_cents)} ? (erreur de saisie)`)) return;
    const { error } = await supabase.from("paiements").update({ deleted_at: new Date().toISOString() }).eq("id", p.id);
    if (error) return setErreur(error.message);
    if (choisie) await ouvrir(choisie);
    await charger();
  }

  const totaux = useMemo(() => ({
    du: soldesMois.reduce((s, x) => s + x.montant_du_cents, 0),
    recu: soldesMois.reduce((s, x) => s + x.recu_cents, 0),
    retard: retards.reduce((s, x) => s + x.solde_cents, 0),
  }), [soldesMois, retards]);

  if (!pret || !session) return null;

  const estMoisCourant = mois === moisCourant();
  const aller = (n: number) => router.replace(`/loyers?m=${decalerMois(mois, n).slice(0, 7)}`, { scroll: false });
  const pctRecu = totaux.du ? Math.min(100, Math.round((totaux.recu / totaux.du) * 100)) : 0;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Loyers</h1>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

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
        <div className="total-periode" style={{ marginTop: 12 }}>
          Encaissé : <strong>{formatCents(totaux.recu)}</strong> sur {formatCents(totaux.du)}
        </div>
        <div className="repartition-barre" style={{ marginTop: 8 }}><span style={{ width: `${pctRecu}%` }} /></div>
      </section>

      {/* Retards, tous mois confondus */}
      {retards.length > 0 && (
        <section className="carte">
          <div className="entete" style={{ marginBottom: 4 }}>
            <strong style={{ color: "var(--erreur)" }}>En retard</strong>
            <strong style={{ color: "var(--erreur)" }}>{formatCents(totaux.retard)}</strong>
          </div>
          {retards.map((r) => (
            <div className="logement-ligne" key={r.echeance_id}>
              <span className="logement-numero">{r.logement}</span>
              <button className="infos lien-ligne" onClick={() => ouvrir(r)}>
                <div className="titre">{r.locataires ?? "Locataire"}</div>
                <div className="sous">{r.immeuble} · <span style={{ textTransform: "capitalize" }}>{moisLisible(r.mois)}</span> · {r.jours_retard} j</div>
              </button>
              <div style={{ textAlign: "right" }}>
                <div className="montant">{formatCents(r.solde_cents)}</div>
                {r.telephone && <a className="lien-tel" href={`tel:${r.telephone.replace(/[^\d+]/g, "")}`}>Appeler</a>}
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
                const s = soldesMois.find((x) => x.logement_id === l.id);
                if (!s) {
                  return (
                    <div className="logement-ligne" key={l.id}>
                      <span className="logement-numero">{l.numero}</span>
                      <div className="infos"><div className="titre" style={{ color: "var(--discret)" }}>Aucun bail ce mois-ci</div></div>
                      <span className="pastille vacant">Vacant</span>
                    </div>
                  );
                }
                const paye = s.solde_cents <= 0;
                return (
                  <button className="logement-ligne lien-ligne" key={l.id} onClick={() => ouvrir(s)}>
                    <span className="logement-numero">{l.numero}</span>
                    <div className="infos">
                      <div className="titre">{s.locataires ?? "Locataire"}</div>
                      <div className="sous">
                        {formatCents(s.montant_du_cents)}
                        {s.recu_cents > 0 && !paye && ` · reçu ${formatCents(s.recu_cents)}`}
                      </div>
                    </div>
                    {paye
                      ? <span className="pastille ok">Payé</span>
                      : s.jours_retard > 0
                        ? <span className="pastille vacant">Retard</span>
                        : s.recu_cents > 0 ? <span className="pastille">Partiel</span>
                        : <span className="pastille gris">À recevoir</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* Feuille de paiement */}
      {choisie && (
        <div className="voile" onClick={() => setChoisie(null)}>
          <div className="feuille" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Enregistrer un paiement">
            <div className="entete" style={{ marginBottom: 4 }}>
              <strong>{choisie.immeuble} · {choisie.logement}</strong>
              <button className="lien-retirer" style={{ color: "var(--discret)" }} onClick={() => setChoisie(null)}>Fermer</button>
            </div>
            <div className="aide" style={{ marginTop: 0 }}>
              {choisie.locataires} · <span style={{ textTransform: "capitalize" }}>{moisLisible(choisie.mois)}</span> · dû {formatCents(choisie.montant_du_cents)}
            </div>

            {paiements.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {paiements.map((p) => (
                  <div className="paiement-ligne" key={p.id}>
                    <span>
                      {formatCents(p.montant_cents)} · {libelleMode(p.mode)}{p.date_recue ? ` · ${dateLisible(p.date_recue)}` : ""}{p.reference ? ` · ${p.reference}` : ""}
                      {p.mode === "credit" && p.notes ? <span className="aide" style={{ display: "block", margin: 0 }}>{p.notes}</span> : null}
                    </span>
                    <button className="lien-retirer" onClick={() => annulerPaiement(p)}>Annuler</button>
                  </div>
                ))}
              </div>
            )}

            {choisie.solde_cents > 0 ? (
              <>
                <label htmlFor="montant">Montant reçu</label>
                <input id="montant" className="montant-total" inputMode="decimal" value={montantSaisi} onChange={(e) => setMontantSaisi(e.target.value)} />
                <div className="choix-2" style={{ marginTop: 8 }}>
                  {MODES.map((m) => (
                    <button key={m.code} type="button" className={mode === m.code ? "actif" : ""} onClick={() => setMode(m.code)}>{m.libelle}</button>
                  ))}
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input type="date" value={dateRecue} onChange={(e) => setDateRecue(e.target.value)} aria-label="Date reçue" />
                  <input placeholder="No chèque / virement" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
                <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={enregistrerPaiement} disabled={envoi}>
                  {envoi ? "Enregistrement…" : versCents(montantSaisi) === choisie.solde_cents ? "Reçu" : "Enregistrer ce montant"}
                </button>

                {!creditOuvert ? (
                  <button className="lien-filtres" style={{ margin: "10px auto 0" }} onClick={() => setCreditOuvert(true)}>
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
              <p className="aide" style={{ color: "var(--succes)", fontWeight: 600 }}>Ce loyer est payé.</p>
            )}
            <Link href={`/baux/${choisie.bail_id}`} className="lien-filtres" style={{ textAlign: "center" }}>Voir le bail</Link>
          </div>
        </div>
      )}

      <BarreOnglets />
    </main>
  );
}
