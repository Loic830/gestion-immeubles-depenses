"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { dateLisible, moisLisible, triNumero } from "@/lib/dates";
import {
  age, datePrevue, etatEntretien, etatRemplacement, nomEquipement, prochainEntretien, type Equipement,
} from "@/lib/entretien";
import BarreOnglets from "@/components/BarreOnglets";
import FeuilleEquipement, { type ImmeubleEq, type LogementEq } from "@/components/FeuilleEquipement";

// Entretien (v0.9.16) : équipements par immeuble (parties communes) et par logement,
// date de remplacement prévue et entretien régulier, avec alertes dans la cloche
// (equipement_remplacement, equipement_entretien : supabase/024_entretien.sql).
// Ouvert depuis Profil > Entretien, ou depuis le détail d'un immeuble (?i=<immeuble>).

type Feuille = { equipement?: Equipement; immeubleId?: string } | null;

export default function PageEntretien() {
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
  const filtre = params.get("i");

  const [immeubles, setImmeubles] = useState<ImmeubleEq[]>([]);
  const [logements, setLogements] = useState<LogementEq[]>([]);
  const [equipements, setEquipements] = useState<Equipement[]>([]);
  const [migration024, setMigration024] = useState(true);
  const [charge, setCharge] = useState(false);
  const [feuille, setFeuille] = useState<Feuille>(null);
  const [message, setMessage] = useState<string | null>(null);

  const charger = useCallback(async () => {
    const [im, lg, eq] = await Promise.all([
      supabase.from("immeubles").select("id, nom").is("deleted_at", null).eq("actif", true).order("nom"),
      supabase.from("logements").select("id, numero, immeuble_id").is("deleted_at", null).eq("actif", true),
      supabase.from("equipements").select("*").is("deleted_at", null).order("created_at"),
    ]);
    setImmeubles((im.data ?? []) as ImmeubleEq[]);
    setLogements(((lg.data ?? []) as LogementEq[]).sort((a, b) => triNumero(a.numero, b.numero)));
    setMigration024(!eq.error);
    setEquipements((eq.data ?? []) as Equipement[]);
    setCharge(true);
  }, []);

  useEffect(() => {
    if (session) charger();
  }, [session, charger]);

  const choisir = (id: string | null) => router.replace(id ? `/entretien?i=${id}` : "/entretien", { scroll: false });

  const affiches = immeubles.filter((i) => !filtre || i.id === filtre);
  const enPlace = equipements.filter((e) => !e.date_retrait && affiches.some((i) => i.id === e.immeuble_id));
  const aRemplacer = enPlace.filter((e) => etatRemplacement(e) !== "ok" && etatRemplacement(e) !== "inconnu").length;
  const aEntretenir = enPlace.filter((e) => etatEntretien(e) === "retard" || etatEntretien(e) === "bientot").length;

  /** Équipements d'un immeuble, par endroit : parties communes d'abord, puis logements dans l'ordre. */
  const parEndroit = useMemo(() => (immeubleId: string) => {
    const liste = equipements.filter((e) => e.immeuble_id === immeubleId && !e.date_retrait);
    const groupes: { titre: string; items: Equipement[] }[] = [];
    const communs = liste.filter((e) => !e.logement_id);
    if (communs.length) groupes.push({ titre: "Parties communes", items: communs });
    const numero = (id: string) => logements.find((l) => l.id === id)?.numero ?? "?";
    const ids = [...new Set(liste.filter((e) => e.logement_id).map((e) => e.logement_id!))]
      .sort((a, b) => triNumero(numero(a), numero(b)));
    for (const id of ids) groupes.push({ titre: `Logement ${numero(id)}`, items: liste.filter((e) => e.logement_id === id) });
    return groupes;
  }, [equipements, logements]);

  function apresEnregistrement(texte: string) {
    setFeuille(null);
    setMessage(texte);
    charger();
  }

  if (!pret || !session) return null;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Entretien</h1>
        <Link href="/profil" className="bouton">‹ Profil</Link>
      </div>

      {!migration024 && (
        <div className="message alerte">Exécuter supabase/024_entretien.sql dans Supabase pour activer l&apos;entretien.</div>
      )}
      {message && <div className="message succes">{message}</div>}

      {immeubles.length > 1 && (
        <div className="puces" style={{ marginBottom: 12 }}>
          <span className={`puce${!filtre ? " actif" : ""}`}>
            <button type="button" aria-pressed={!filtre} onClick={() => choisir(null)}>Tous</button>
          </span>
          {immeubles.map((im) => (
            <span key={im.id} className={`puce${filtre === im.id ? " actif" : ""}`}>
              <button type="button" aria-pressed={filtre === im.id} onClick={() => choisir(im.id)}>{im.nom}</button>
            </span>
          ))}
        </div>
      )}

      {charge && migration024 && (
        <div className="carte">
          <div className="total-periode">
            <strong>{enPlace.length}</strong> équipement{enPlace.length > 1 ? "s" : ""} suivi{enPlace.length > 1 ? "s" : ""}
          </div>
          <p className="aide" style={{ marginBottom: 0 }}>
            {aRemplacer === 0 && aEntretenir === 0
              ? "Rien à remplacer dans les 6 prochains mois."
              : [aRemplacer ? `${aRemplacer} à remplacer bientôt` : "", aEntretenir ? `${aEntretenir} entretien${aEntretenir > 1 ? "s" : ""} à faire` : ""]
                  .filter(Boolean).join(" · ")}
          </p>
          <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={() => setFeuille({ immeubleId: filtre ?? undefined })}>
            + Ajouter un équipement
          </button>
        </div>
      )}

      {charge && migration024 && affiches.map((im) => {
        const groupes = parEndroit(im.id);
        const historique = equipements.filter((e) => e.immeuble_id === im.id && e.date_retrait)
          .sort((a, b) => (b.date_retrait ?? "").localeCompare(a.date_retrait ?? ""));
        return (
          <section key={im.id}>
            <h2 className="immeuble-titre">{im.nom}</h2>
            {groupes.length === 0 && (
              <div className="carte">
                <p className="aide" style={{ margin: 0 }}>Aucun équipement. Exemple : le chauffe-eau, avec sa date d&apos;installation.</p>
              </div>
            )}
            {groupes.map((g) => (
              <div key={g.titre} className="carte">
                <h3 className="sous-titre-actifs" style={{ marginTop: 0 }}>{g.titre}</h3>
                {g.items.map((e) => <LigneEquipement key={e.id} e={e} onOuvrir={() => setFeuille({ equipement: e })} />)}
              </div>
            ))}
            {historique.length > 0 && (
              <details className="carte">
                <summary>Remplacés ({historique.length})</summary>
                {historique.map((e) => (
                  <button key={e.id} type="button" className="ligne-actif lien-ligne" onClick={() => setFeuille({ equipement: e })}>
                    <div className="infos">
                      <div className="titre">{nomEquipement(e)}{e.nom && e.type !== "autre" ? ` · ${e.nom}` : ""}</div>
                      <div className="sous">
                        {e.logement_id ? `Logement ${logements.find((l) => l.id === e.logement_id)?.numero ?? "?"} · ` : ""}
                        {e.date_installation ? `${dateLisible(e.date_installation)} au ` : "Jusqu'au "}{dateLisible(e.date_retrait)}
                      </div>
                    </div>
                  </button>
                ))}
              </details>
            )}
          </section>
        );
      })}

      {feuille && (
        <FeuilleEquipement
          immeubles={immeubles}
          logements={logements}
          equipement={feuille.equipement}
          immeubleId={feuille.immeubleId}
          onFermer={() => setFeuille(null)}
          onEnregistre={apresEnregistrement}
        />
      )}

      <BarreOnglets />
    </main>
  );
}

function LigneEquipement({ e, onOuvrir }: { e: Equipement; onOuvrir: () => void }) {
  const prevue = datePrevue(e);
  const etat = etatRemplacement(e);
  const prochain = prochainEntretien(e);
  const etatEnt = etatEntretien(e);
  return (
    <button type="button" className="ligne-actif lien-ligne" onClick={onOuvrir}>
      <div className="infos">
        <div className="titre">{nomEquipement(e)}{e.nom && e.type !== "autre" ? ` · ${e.nom}` : ""}</div>
        <div className="sous">
          {e.date_installation ? `Installé le ${dateLisible(e.date_installation)} (${age(e.date_installation)})` : "Date d'installation à compléter"}
        </div>
        <div className="sous">
          {prevue ? `À remplacer vers ${moisLisible(prevue)}` : "Durée de vie à compléter"}
          {prochain ? ` · entretien le ${dateLisible(prochain)}` : ""}
        </div>
      </div>
      <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
        {etat === "retard" && <span className="pastille vacant">À remplacer</span>}
        {etat === "bientot" && <span className="pastille">Bientôt</span>}
        {(etatEnt === "retard" || etatEnt === "bientot") && <span className="pastille">Entretien</span>}
      </div>
      <span aria-hidden="true">›</span>
    </button>
  );
}
