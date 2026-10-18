"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import {
  CATALOGUE, estExclue, pousserMesNotifications, signalerMaj,
  type Cible, type Exclusion, type TypeNotification,
} from "@/lib/notifications";
import ActivationPush from "@/components/ActivationPush";
import BarreOnglets from "@/components/BarreOnglets";

// Profil > Tester les notifications possibles (v0.8.9).
// Une ligne par notification du catalogue (lib/notifications.ts) : « Envoyer » crée un
// exemple dans le centre (non lu, marqué « test ») et le pousse sur le téléphone si
// c'est activé. Les préférences sont respectées : une notification exclue n'est pas envoyée.

export default function PageTestNotifications() {
  const { session, pret } = useSession();
  const [cibles, setCibles] = useState<Record<string, Cible[]>>({ immeuble: [], vehicule: [] });
  const [message, setMessage] = useState<{ type: "succes" | "erreur" | "alerte"; texte: string } | null>(null);
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      supabase.from("immeubles").select("id, nom").is("deleted_at", null).eq("actif", true).order("nom"),
      supabase.from("vehicules").select("id, nom").is("deleted_at", null).eq("actif", true).order("nom"),
    ]).then(([im, ve]) => setCibles({ immeuble: (im.data ?? []) as Cible[], vehicule: (ve.data ?? []) as Cible[] }));
  }, [session]);

  async function envoyer(types: TypeNotification[]) {
    setOccupe(true);
    setMessage(null);
    const { data: ex, error: errEx } = await supabase.from("notifications_exclusions").select("id, type, cible_id");
    if (errEx) {
      setMessage({ type: "erreur", texte: "Exécuter d'abord supabase/013_notifications.sql." });
      setOccupe(false);
      return;
    }
    const exclusions = (ex ?? []) as Exclusion[];
    const lignes = [];
    const exclues: string[] = [];
    for (const t of types) {
      // L'exemple vise un vrai immeuble / véhicule, pour que les préférences s'appliquent
      const cible = cibles[t.portee]?.[0] ?? null;
      if (estExclue(exclusions, t.code, cible?.id ?? null)) { exclues.push(t.nom); continue; }
      const remplacer = (texte: string) =>
        texte.replace("{immeuble}", cible?.nom ?? "Gauthier").replace("{vehicule}", cible?.nom ?? "Mon véhicule");
      lignes.push({
        type: t.code,
        cible_id: cible?.id ?? null,
        cle: `test:${crypto.randomUUID()}`,
        titre: remplacer(t.exemple.titre),
        description: remplacer(t.exemple.description),
        est_test: true,
      });
    }
    if (lignes.length) {
      const { error } = await supabase.from("notifications").insert(lignes);
      if (error) {
        setMessage({ type: "erreur", texte: error.message });
        setOccupe(false);
        return;
      }
    }
    signalerMaj();
    const push = lignes.length ? await pousserMesNotifications() : { ok: true };
    const textes: string[] = [];
    if (lignes.length) textes.push(`${lignes.length} notification(s) ajoutée(s) sous la cloche.`);
    if (exclues.length) textes.push(`Exclue(s) dans vos préférences, donc pas envoyée(s) : ${exclues.join(", ")}.`);
    if (push.message) textes.push(push.message);
    setMessage({ type: lignes.length ? "succes" : "alerte", texte: textes.join(" ") });
    setOccupe(false);
  }

  async function retirerTests() {
    setOccupe(true);
    const { error } = await supabase.from("notifications").update({ deleted_at: new Date().toISOString() })
      .eq("est_test", true).is("deleted_at", null);
    setMessage(error ? { type: "erreur", texte: error.message } : { type: "succes", texte: "Notifications de test retirées du centre." });
    signalerMaj();
    setOccupe(false);
  }

  if (!pret || !session) return <main className="page avec-onglets"><p className="aide">Chargement…</p></main>;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Tester les notifications</h1>
        <Link href="/profil" className="bouton">‹ Profil</Link>
      </div>

      <ActivationPush />

      {message && <div className={`message ${message.type}`}>{message.texte}</div>}

      <button type="button" className="bouton principal plein" disabled={occupe} onClick={() => envoyer(CATALOGUE)}>
        Envoyer toutes les notifications
      </button>

      <div className="carte" style={{ marginTop: 12 }}>
        {CATALOGUE.map((t) => (
          <div key={t.code} className="ligne-test">
            <div className="infos">
              <div className="titre">{t.nom}</div>
              <div className="sous">{t.quand}</div>
            </div>
            <button type="button" className="bouton" disabled={occupe} onClick={() => envoyer([t])}>Envoyer</button>
          </div>
        ))}
      </div>

      <p className="aide">
        Chaque test arrive non lu sous la cloche (avec la mention « test ») et, si c&apos;est activé, sur le téléphone.
        Les vraies notifications sont calculées chaque matin.
      </p>
      <button type="button" className="bouton plein bouton-discret" style={{ marginTop: 12 }} disabled={occupe} onClick={retirerTests}>
        Retirer les notifications de test du centre
      </button>

      <BarreOnglets />
    </main>
  );
}
