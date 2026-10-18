"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";

// En-tête fixe sur toutes les pages (sauf la connexion) :
// nom de l'application à gauche, cloche (notifications) puis avatar (Profil) à droite.

function initiales(nom: string | undefined, courriel: string | undefined): string {
  const source = (nom ?? "").trim();
  if (source) {
    const mots = source.split(/\s+/);
    return ((mots[0]?.[0] ?? "") + (mots.length > 1 ? mots[mots.length - 1][0] : "")).toUpperCase();
  }
  return (courriel?.[0] ?? "?").toUpperCase();
}

export default function EnTete() {
  const chemin = usePathname() ?? "/";
  const [lettres, setLettres] = useState("");
  const [tiroirOuvert, setTiroirOuvert] = useState(false);

  useEffect(() => {
    const maj = (u: { email?: string; user_metadata?: { nom?: string } } | null | undefined) =>
      setLettres(u ? initiales(u.user_metadata?.nom, u.email) : "");
    supabase.auth.getSession().then(({ data }) => maj(data.session?.user));
    const { data: abonnement } = supabase.auth.onAuthStateChange((_evt, s) => maj(s?.user));
    return () => abonnement.subscription.unsubscribe();
  }, []);

  // Fermer le tiroir quand on change de page
  useEffect(() => setTiroirOuvert(false), [chemin]);

  if (chemin.startsWith("/login")) return null;

  // Les alertes arrivent avec la version 0.8.9 ; la pastille reste cachée à 0.
  const nonLues = 0;

  return (
    <>
      <header className="entete-app">
        <div className="contenu">
          <span className="nom-app">Immeubles So-Max</span>
          <div className="actions">
            <button type="button" className="bouton-icone" aria-label="Notifications"
                    onClick={() => setTiroirOuvert(true)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              {nonLues > 0 && <span className="pastille-cloche">{nonLues}</span>}
            </button>
            <Link href="/profil" className={`avatar${chemin.startsWith("/profil") ? " actif" : ""}`}
                  aria-label="Profil">
              {lettres || "·"}
            </Link>
          </div>
        </div>
      </header>

      {tiroirOuvert && (
        <div className="tiroir-fond" onClick={() => setTiroirOuvert(false)}>
          <aside className="tiroir" role="dialog" aria-label="Notifications" onClick={(e) => e.stopPropagation()}>
            <div className="entete" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Notifications</h2>
              <button type="button" className="bouton" onClick={() => setTiroirOuvert(false)}>Fermer</button>
            </div>
            <div className="carte">
              <strong>Aucune alerte pour l&apos;instant</strong>
              <p className="aide">
                Les rappels de renouvellement hypothécaire, d&apos;assurances et de taxes apparaîtront ici
                dès que la page Frais fixes sera remplie.
              </p>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
