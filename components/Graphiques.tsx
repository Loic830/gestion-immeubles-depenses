// Petits graphiques en SVG, sans dépendance (v0.9.2) : anneau (pourcentage ou parts) et barres par période.
// Les couleurs viennent des variables --g1 à --g6 de globals.css (mode clair et sombre).

import { formatCents } from "@/lib/argent";

export const COULEURS = ["var(--g1)", "var(--g2)", "var(--g3)", "var(--g4)", "var(--g5)", "var(--g6)"];
export const couleur = (i: number) => COULEURS[i % COULEURS.length];

/** Montant court pour les étiquettes : 1 234 $ ou 12,3 k$ */
export function centsCourt(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 10000) return `${(d / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} k$`;
  return `${Math.round(d).toLocaleString("fr-CA")} $`;
}

type Part = { valeur: number; couleur: string };

/** Anneau : une ou plusieurs parts sur un total ; le centre affiche un texte court */
export function Anneau({ parts, total, centre, sousCentre, taille = 120 }: {
  parts: Part[]; total: number; centre?: string; sousCentre?: string; taille?: number;
}) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  let cumul = 0;
  return (
    <svg viewBox="0 0 100 100" width={taille} height={taille} role="img" aria-label={centre} className="anneau">
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--accent-clair)" strokeWidth="12" />
      {total > 0 && parts.filter((p) => p.valeur > 0).map((p, i) => {
        const long = (Math.min(p.valeur, total - cumul) / total) * circ;
        const el = (
          <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={p.couleur} strokeWidth="12"
                  strokeDasharray={`${long} ${circ - long}`} strokeDashoffset={-((cumul / total) * circ)}
                  transform="rotate(-90 50 50)" />
        );
        cumul += p.valeur;
        return el;
      })}
      {centre && <text x="50" y={sousCentre ? 50 : 55} textAnchor="middle" className="anneau-centre">{centre}</text>}
      {sousCentre && <text x="50" y="64" textAnchor="middle" className="anneau-sous">{sousCentre}</text>}
    </svg>
  );
}

export type Colonne = { etiquette: string; valeurs: number[] };

/** Barres verticales (empilées s'il y a plusieurs séries), montants en cents */
export function Barres({ colonnes, couleurs, actif }: { colonnes: Colonne[]; couleurs?: string[]; actif?: number }) {
  const max = Math.max(0, ...colonnes.map((c) => c.valeurs.reduce((s, v) => s + Math.max(0, v), 0)));
  const H = 110; // hauteur de la zone des barres
  const L = 100 / Math.max(1, colonnes.length);
  return (
    <div className="barres" role="img"
         aria-label={colonnes.map((c) => `${c.etiquette} ${centsCourt(c.valeurs.reduce((s, v) => s + v, 0))}`).join(", ")}>
      <div className="barres-max">{max > 0 ? centsCourt(max) : ""}</div>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" width="100%" height={H}>
        <line x1="0" y1={H - 0.5} x2="100" y2={H - 0.5} stroke="var(--bordure)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {colonnes.map((c, i) => {
          let y = H;
          return c.valeurs.map((v, s) => {
            const h = max > 0 ? (Math.max(0, v) / max) * (H - 4) : 0;
            y -= h;
            return h > 0 ? (
              <rect key={`${i}-${s}`} x={i * L + L * 0.18} y={y} width={L * 0.64} height={h}
                    fill={couleurs?.[s] ?? "var(--accent)"} opacity={actif === undefined || actif === i ? 1 : 0.45} />
            ) : null;
          });
        })}
      </svg>
      <div className="barres-etiquettes" style={{ gridTemplateColumns: `repeat(${colonnes.length}, minmax(0, 1fr))` }}>
        {colonnes.map((c, i) => <span key={i} className={actif === i ? "actif" : ""}>{c.etiquette}</span>)}
      </div>
    </div>
  );
}

/** Légende : pastille de couleur, nom, montant */
export function Legende({ lignes }: { lignes: { nom: string; cents: number; couleur: string; detail?: string }[] }) {
  return (
    <div className="legende">
      {lignes.map((l) => (
        <div className="legende-ligne" key={l.nom}>
          <span className="legende-point" style={{ background: l.couleur }} />
          <span className="legende-nom">{l.nom}{l.detail && <small> · {l.detail}</small>}</span>
          <strong>{formatCents(l.cents)}</strong>
        </div>
      ))}
    </div>
  );
}

export const MOIS_COURTS = ["jan", "fév", "mar", "avr", "mai", "jun", "jul", "aoû", "sep", "oct", "nov", "déc"];
