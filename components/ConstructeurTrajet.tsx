"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cleDistance, paireLieux, segmentsTrajet, formatKm } from "@/lib/vehicule";

// Composer un trajet en touchant les lieux dans l'ordre :
//   Maison → Gauthier → Rona → Gauthier → Maison
// La distance entre deux lieux s'inscrit une seule fois ; ensuite le total se calcule seul.

type Lieu = { id: string; nom: string; immeuble_id: string | null; ordre: number };
export type TrajetCompose = { nom: string; km: number; immeubleId: string; etapes: string[] };

function lireKm(t: string): number | null {
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

export default function ConstructeurTrajet({
  onUtiliser, onFavoriCree, onFermer,
}: {
  onUtiliser: (t: TrajetCompose) => void;
  onFavoriCree: () => void;
  onFermer: () => void;
}) {
  const [lieux, setLieux] = useState<Lieu[]>([]);
  const [distances, setDistances] = useState<Map<string, number>>(new Map());
  const [etapes, setEtapes] = useState<string[]>([]);
  const [saisies, setSaisies] = useState<Record<string, string>>({}); // km tapés par segment
  const [nouveauLieu, setNouveauLieu] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    const [li, di] = await Promise.all([
      supabase.from("lieux").select("id, nom, immeuble_id, ordre").is("deleted_at", null).order("ordre").order("nom"),
      supabase.from("distances_lieux").select("lieu_a, lieu_b, km"),
    ]);
    if (li.error) return setErreur(li.error.message);
    setLieux((li.data ?? []) as Lieu[]);
    const m = new Map<string, number>();
    for (const d of (di.data ?? []) as { lieu_a: string; lieu_b: string; km: number }[]) m.set(cleDistance(d.lieu_a, d.lieu_b), Number(d.km));
    setDistances(m);
  }, []);
  useEffect(() => { charger(); }, [charger]);

  // Distances connues + celles tapées dans ce trajet
  const distancesEffectives = useMemo(() => {
    const m = new Map(distances);
    for (const [cle, texte] of Object.entries(saisies)) {
      const km = lireKm(texte);
      if (km !== null) m.set(cle, km);
      else m.delete(cle);
    }
    return m;
  }, [distances, saisies]);
  const { segments, total } = segmentsTrajet(etapes, distancesEffectives);

  const nomDe = (id: string) => lieux.find((l) => l.id === id)?.nom ?? "?";
  const nomTrajet = etapes.map(nomDe).join(" → ");
  const immeublesVisites = Array.from(new Set(etapes.map((id) => lieux.find((l) => l.id === id)?.immeuble_id).filter((x): x is string => Boolean(x))));
  const immeubleId = immeublesVisites.length === 1 ? immeublesVisites[0] : ""; // 0 ou plusieurs → « Plusieurs »

  function ajouterEtape(id: string) {
    if (etapes[etapes.length - 1] === id) return;
    setEtapes([...etapes, id]);
  }

  async function ajouterLieu() {
    const nom = nouveauLieu.trim();
    if (!nom) return;
    setErreur(null);
    const { data, error } = await supabase.from("lieux").insert({ nom }).select("id, nom, immeuble_id, ordre").single();
    if (error) return setErreur(error.message.includes("lieux_nom_unique") ? `« ${nom} » existe déjà.` : error.message);
    setLieux((l) => [...l, data as Lieu]);
    setNouveauLieu("");
    ajouterEtape((data as Lieu).id);
  }

  // Enregistre les distances tapées (ou corrigées) pour les prochains trajets
  async function sauverDistances() {
    const lignes = segments
      .filter((s) => s.de !== s.vers && s.km !== null)
      .filter((s) => distances.get(cleDistance(s.de, s.vers)) !== s.km)
      .map((s) => { const [a, b] = paireLieux(s.de, s.vers); return { lieu_a: a, lieu_b: b, km: s.km, updated_at: new Date().toISOString() }; });
    const uniques = Array.from(new Map(lignes.map((l) => [`${l.lieu_a}|${l.lieu_b}`, l])).values());
    if (uniques.length === 0) return;
    const { error } = await supabase.from("distances_lieux").upsert(uniques);
    if (error) throw new Error(error.message);
  }

  async function terminer(action: "utiliser" | "favori") {
    if (etapes.length < 2) return setErreur("Touche au moins deux lieux (ex. Maison puis Gauthier).");
    if (total === null || total <= 0) return setErreur("Il manque des km sur un segment.");
    setErreur(null);
    setEnvoi(true);
    try {
      await sauverDistances();
      if (action === "favori") {
        const { error } = await supabase.from("trajets_favoris").insert({
          nom: nomTrajet, km: total, immeuble_id: immeubleId || null, etapes,
        });
        if (error) throw new Error(error.message);
        onFavoriCree();
      } else {
        onUtiliser({ nom: nomTrajet, km: total, immeubleId, etapes });
      }
      setEtapes([]);
      setSaisies({});
      await charger();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="bloc-locataire" style={{ marginTop: 0, borderTop: "none", paddingTop: 0 }}>
      <div className="entete" style={{ marginBottom: 4 }}>
        <strong>Composer un trajet</strong>
        <button className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
      </div>
      <p className="aide" style={{ marginTop: 0 }}>Touche les lieux dans l&apos;ordre, retour compris.</p>
      {erreur && <div className="message erreur">{erreur}</div>}

      <div className="puces">
        {lieux.map((l) => (
          <span key={l.id} className="puce"><button type="button" onClick={() => ajouterEtape(l.id)}>{l.nom}</button></span>
        ))}
      </div>
      <div className="rangee" style={{ marginTop: 8 }}>
        <input placeholder="Nouveau lieu (ex. Rona, BMR)" value={nouveauLieu} onChange={(e) => setNouveauLieu(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") ajouterLieu(); }} />
        <button type="button" className="bouton" style={{ flex: "0 0 auto" }} onClick={ajouterLieu}>+ Lieu</button>
      </div>

      {etapes.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600 }}>{nomTrajet}</div>
          {segments.map((s, i) => {
            const cle = cleDistance(s.de, s.vers);
            const connu = distances.get(cle);
            const valeur = saisies[cle] ?? (connu !== undefined ? String(connu).replace(".", ",") : "");
            return (
              <div className="paiement-ligne" key={i}>
                <span>{nomDe(s.de)} → {nomDe(s.vers)}</span>
                <input inputMode="decimal" aria-label={`Km ${nomDe(s.de)} → ${nomDe(s.vers)}`} placeholder="km ?"
                       style={{ width: 90, textAlign: "right", borderColor: s.km === null ? "var(--alerte)" : undefined }}
                       value={valeur} onChange={(e) => setSaisies({ ...saisies, [cle]: e.target.value })} />
              </div>
            );
          })}
          <div className="entete" style={{ marginTop: 8, marginBottom: 0 }}>
            <button className="lien-retirer" onClick={() => setEtapes(etapes.slice(0, -1))}>Retirer le dernier lieu</button>
            <strong>{total === null ? "—" : formatKm(total)}</strong>
          </div>
          {segments.some((s) => s.km === null) && (
            <p className="aide">Entre les km d&apos;un segment une seule fois (ex. avec Google Maps) : l&apos;app s&apos;en souviendra, dans les deux sens.</p>
          )}
          <div className="rangee" style={{ marginTop: 12 }}>
            <button className="bouton" onClick={() => terminer("favori")} disabled={envoi}>Garder comme fréquent</button>
            <button className="bouton principal" onClick={() => terminer("utiliser")} disabled={envoi}>Utiliser maintenant</button>
          </div>
        </div>
      )}
    </div>
  );
}
