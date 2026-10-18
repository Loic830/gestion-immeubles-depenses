"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { compterNonLues, EVENEMENT_MAJ, genererSiBesoin } from "@/lib/notifications";
import { enregistrerServiceWorker } from "@/lib/push";
import TiroirNotifications from "@/components/TiroirNotifications";

// En-tête fixe sur toutes les pages (sauf la connexion) :
// nom de l'application à gauche, cloche (notifications) puis avatar (Profil) à droite.
// La cloche devient jaune-orangé tant qu'il y a des notifications non lues (v0.8.9).

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
  const [connecte, setConnecte] = useState(false);
  const [nonLues, setNonLues] = useState(0);

  useEffect(() => {
    const maj = (u: { email?: string; user_metadata?: { nom?: string } } | null | undefined) => {
      setLettres(u ? initiales(u.user_metadata?.nom, u.email) : "");
      setConnecte(!!u);
    };
    supabase.auth.getSession().then(({ data }) => maj(data.session?.user));
    const { data: abonnement } = supabase.auth.onAuthStateChange((_evt, s) => maj(s?.user));
    enregistrerServiceWorker();
    return () => abonnement.subscription.unsubscribe();
  }, []);

  // Compte des non lues : à la connexion, au retour dans l'app, après une lecture ou un test,
  // et quand une notification poussée arrive pendant que l'app est ouverte.
  useEffect(() => {
    if (!connecte) { setNonLues(0); return; }
    const recompter = () => compterNonLues().then(setNonLues).catch(() => {});
    genererSiBesoin().catch(() => {}).finally(recompter);
    const auRetour = () => { if (document.visibilityState === "visible") recompter(); };
    document.addEventListener("visibilitychange", auRetour);
    window.addEventListener(EVENEMENT_MAJ, recompter);
    navigator.serviceWorker?.addEventListener("message", recompter);
    return () => {
      document.removeEventListener("visibilitychange", auRetour);
      window.removeEventListener(EVENEMENT_MAJ, recompter);
      navigator.serviceWorker?.removeEventListener("message", recompter);
    };
  }, [connecte]);

  // Fermer le tiroir quand on change de page
  useEffect(() => setTiroirOuvert(false), [chemin]);

  if (chemin.startsWith("/login")) return null;

  return (
    <>
      <header className="entete-app">
        <div className="contenu">
          <span className="nom-app">Immeubles So-Max</span>
          <div className="actions">
            <button type="button" className={`bouton-icone${nonLues > 0 ? " cloche-active" : ""}`}
                    aria-label={nonLues > 0 ? `Notifications : ${nonLues} non lue(s)` : "Notifications"}
                    onClick={() => setTiroirOuvert(true)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill={nonLues > 0 ? "var(--notif)" : "none"} stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </button>
            <Link href="/profil" className={`avatar${chemin.startsWith("/profil") ? " actif" : ""}`}
                  aria-label="Profil">
              {lettres || "·"}
            </Link>
          </div>
        </div>
      </header>

      {tiroirOuvert && <TiroirNotifications onFermer={() => setTiroirOuvert(false)} />}
    </>
  );
}
