"use client";

// Période de l'onglet Baux (v0.9.11) : un seul bouton qui ouvre une feuille, au lieu d'une puce par année.
// Choix rapides (cette année, 5 ou 10 dernières années, toutes), une plage « De … à … »,
// ou les années une par une avec « Tout sélectionner ». Rien ne change avant « Appliquer ».

import { useState } from "react";
import { libellePeriode } from "@/lib/baux";

type Props = {
  disponibles: number[];          // de la plus récente à la plus vieille
  choisies: number[];
  onChoisir: (annees: number[]) => void;
};

export default function ChoixAnnees({ disponibles, choisies, onChoisir }: Props) {
  const [ouvert, setOuvert] = useState(false);
  const [selection, setSelection] = useState<number[]>(choisies);
  const courante = disponibles[0];
  const plusVieille = disponibles[disponibles.length - 1];
  const toutes = disponibles.length > 1 && disponibles.every((a) => choisies.includes(a));

  function ouvrir() {
    setSelection(choisies);
    setOuvert(true);
  }
  function appliquer(annees: number[]) {
    if (annees.length === 0) return;
    onChoisir(annees);
    setOuvert(false);
  }
  const dernieres = (n: number) => disponibles.slice(0, n);
  const memes = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
  const basculer = (a: number) => setSelection((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]));
  // Plage « De … à … » : on part de la sélection actuelle
  const de = selection.length ? Math.min(...selection) : courante;
  const a = selection.length ? Math.max(...selection) : courante;
  const plage = (x: number, y: number) => disponibles.filter((n) => n >= Math.min(x, y) && n <= Math.max(x, y));

  const rapides: { libelle: string; annees: number[] }[] = [
    { libelle: "Cette année", annees: [courante] },
    ...(disponibles.length > 1 ? [{ libelle: "L'an dernier", annees: [courante - 1] }] : []),
    ...(disponibles.length > 5 ? [{ libelle: "5 dernières années", annees: dernieres(5) }] : []),
    ...(disponibles.length > 10 ? [{ libelle: "10 dernières années", annees: dernieres(10) }] : []),
    ...(disponibles.length > 1 ? [{ libelle: `Toutes (${plusVieille} à ${courante})`, annees: disponibles }] : []),
  ];

  return (
    <>
      <button type="button" className="bouton choix-periode" onClick={ouvrir} aria-haspopup="dialog">
        <span>{toutes ? `Toutes les années (${libellePeriode(choisies)})` : libellePeriode(choisies)}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {ouvert && (
        <div className="voile" role="dialog" aria-modal="true" aria-labelledby="titre-periode" onClick={() => setOuvert(false)}>
          <div className="feuille" onClick={(e) => e.stopPropagation()}>
            <div className="entete" style={{ marginBottom: 4 }}>
              <strong id="titre-periode" style={{ fontSize: 19 }}>Période des baux</strong>
              <button type="button" className="lien-filtres" onClick={() => setOuvert(false)}>Fermer</button>
            </div>

            <div className="puces">
              {rapides.map((r) => (
                <span key={r.libelle} className={`puce${memes(selection, r.annees) ? " actif" : ""}`}>
                  <button type="button" onClick={() => appliquer(r.annees)}>{r.libelle}</button>
                </span>
              ))}
            </div>

            {disponibles.length > 1 && (
              <>
                <label htmlFor="periode-de" style={{ marginTop: 16 }}>De … à …</label>
                <div className="rangee">
                  <select id="periode-de" aria-label="De l'année" value={de}
                          onChange={(e) => setSelection(plage(Number(e.target.value), a))}>
                    {[...disponibles].reverse().map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <select aria-label="À l'année" value={a}
                          onChange={(e) => setSelection(plage(de, Number(e.target.value)))}>
                    {disponibles.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>

                <div className="entete" style={{ marginTop: 16 }}>
                  <strong>Ou touche les années</strong>
                  {selection.length === disponibles.length
                    ? <button type="button" className="lien-filtres" onClick={() => setSelection([])}>Tout effacer</button>
                    : <button type="button" className="lien-filtres" onClick={() => setSelection(disponibles)}>Tout sélectionner</button>}
                </div>
                <div className="grille-annees">
                  {disponibles.map((n) => (
                    <button key={n} type="button" aria-pressed={selection.includes(n)}
                            className={selection.includes(n) ? "actif" : ""} onClick={() => basculer(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              </>
            )}

            <p className="aide">
              {selection.length === 0
                ? "Choisis au moins une année."
                : `${selection.length} ${selection.length > 1 ? "années" : "année"} : ${libellePeriode(selection)}. Le dossier prêteur suit la même période.`}
            </p>
            <div className="rangee" style={{ marginTop: 8 }}>
              <button type="button" className="bouton" onClick={() => setOuvert(false)}>Annuler</button>
              <button type="button" className="bouton principal" disabled={selection.length === 0}
                      onClick={() => appliquer(selection)}>Appliquer</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
