"use client";

import { useMemo, useRef, useState } from "react";

// Champ fournisseur avec menu déroulant : cherche dans les fournisseurs déjà utilisés
// pendant la frappe (sans tenir compte des accents ni des majuscules), les plus utilisés
// en premier. Remplace <datalist>, mal affiché sur iPhone.

export type FournisseurOption = { id: string; nom: string; utilisations: number; dernier: string | null };

const MAX_SUGGESTIONS = 8;

export function normaliser(t: string) {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Rang : correspondance exacte, puis début du nom, puis début d'un mot, puis n'importe où.
export function filtrerFournisseurs(options: FournisseurOption[], saisie: string, max = MAX_SUGGESTIONS) {
  const q = normaliser(saisie);
  const parUsage = (a: FournisseurOption, b: FournisseurOption) =>
    b.utilisations - a.utilisations || (b.dernier ?? "").localeCompare(a.dernier ?? "") || a.nom.localeCompare(b.nom, "fr");
  if (!q) return [...options].sort(parUsage).slice(0, max);
  const rangDe = (nom: string) => {
    const n = normaliser(nom);
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[\s\-'’.]+/).some((mot) => mot.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return -1;
  };
  return options
    .map((o) => ({ o, rang: rangDe(o.nom) }))
    .filter((x) => x.rang >= 0)
    .sort((a, b) => a.rang - b.rang || parUsage(a.o, b.o))
    .slice(0, max)
    .map((x) => x.o);
}

export default function ChoixFournisseur({
  options, valeur, onChange,
}: { options: FournisseurOption[]; valeur: string; onChange: (nom: string) => void }) {
  const [ouvert, setOuvert] = useState(false);
  const [actif, setActif] = useState(-1);
  const champ = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => filtrerFournisseurs(options, valeur), [options, valeur]);
  const saisie = valeur.trim();
  const existeDeja = saisie !== "" && options.some((o) => normaliser(o.nom) === normaliser(saisie));
  const proposerNouveau = saisie !== "" && !existeDeja;
  const nbChoix = suggestions.length + (proposerNouveau ? 1 : 0);

  function choisir(nom: string) {
    onChange(nom);
    setOuvert(false);
    setActif(-1);
    champ.current?.blur();
  }

  function clavier(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!ouvert && (e.key === "ArrowDown" || e.key === "ArrowUp")) { setOuvert(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActif((i) => (i + 1) % Math.max(nbChoix, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActif((i) => (i <= 0 ? nbChoix - 1 : i - 1)); }
    else if (e.key === "Enter" && ouvert && actif >= 0) {
      e.preventDefault();
      choisir(actif < suggestions.length ? suggestions[actif].nom : saisie);
    } else if (e.key === "Escape") setOuvert(false);
  }

  return (
    <div className="choix-fournisseur">
      <div className="choix-fournisseur-champ">
        <input
          ref={champ}
          id="fournisseur"
          role="combobox"
          aria-expanded={ouvert}
          aria-controls="menu-fournisseurs"
          aria-autocomplete="list"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          placeholder="Écrire ou choisir dans la liste"
          value={valeur}
          onChange={(e) => { onChange(e.target.value); setOuvert(true); setActif(-1); }}
          onFocus={() => setOuvert(true)}
          // Délai : laisse le temps au toucher sur une suggestion d'être reçu.
          onBlur={() => setTimeout(() => setOuvert(false), 150)}
          onKeyDown={clavier}
        />
        {valeur ? (
          <button type="button" className="choix-fournisseur-bouton" aria-label="Effacer le fournisseur"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onChange(""); setOuvert(true); champ.current?.focus(); }}>×</button>
        ) : (
          <button type="button" className="choix-fournisseur-bouton" aria-label="Afficher les fournisseurs"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setOuvert((o) => !o); champ.current?.focus(); }}>▾</button>
        )}
      </div>

      {ouvert && nbChoix > 0 && (
        <ul id="menu-fournisseurs" role="listbox" className="choix-fournisseur-menu">
          {!saisie && <li className="choix-fournisseur-titre" aria-hidden="true">Les plus utilisés</li>}
          {suggestions.map((o, i) => (
            <li key={o.id} role="option" aria-selected={i === actif}
                className={i === actif ? "actif" : ""}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choisir(o.nom)}>
              <span>{o.nom}</span>
              {o.utilisations > 0 && <span className="choix-fournisseur-compte">{o.utilisations}×</span>}
            </li>
          ))}
          {proposerNouveau && (
            <li role="option" aria-selected={actif === suggestions.length}
                className={"choix-fournisseur-nouveau" + (actif === suggestions.length ? " actif" : "")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choisir(saisie)}>
              + Nouveau fournisseur « {saisie} »
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
