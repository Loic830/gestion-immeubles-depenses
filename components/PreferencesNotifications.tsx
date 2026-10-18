"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { CATALOGUE, estExclue, type Cible, type Exclusion, type TypeNotification } from "@/lib/notifications";
import ActivationPush from "@/components/ActivationPush";

// Préférences des notifications (v0.8.9), propres à chaque personne.
// Pour chaque type du catalogue : recevoir ou non, puis immeuble par immeuble
// (ou véhicule par véhicule). Une exclusion empêche la création de la notification.

export default function PreferencesNotifications({ onRetour }: { onRetour: () => void }) {
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [cibles, setCibles] = useState<Record<string, Cible[]>>({ immeuble: [], vehicule: [] });
  const [message, setMessage] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  async function charger() {
    const [ex, im, ve] = await Promise.all([
      supabase.from("notifications_exclusions").select("id, type, cible_id"),
      supabase.from("immeubles").select("id, nom").is("deleted_at", null).eq("actif", true).order("nom"),
      supabase.from("vehicules").select("id, nom").is("deleted_at", null).eq("actif", true).order("nom"),
    ]);
    if (ex.error) setMessage("Exécuter supabase/013_notifications.sql pour enregistrer les préférences.");
    setExclusions((ex.data ?? []) as Exclusion[]);
    setCibles({ immeuble: (im.data ?? []) as Cible[], vehicule: (ve.data ?? []) as Cible[] });
  }

  useEffect(() => { charger(); }, []);

  async function executer(action: () => PromiseLike<{ error: { message: string } | null }>) {
    setOccupe(true);
    const { error } = await action();
    if (error) setMessage(error.message);
    await charger();
    setOccupe(false);
  }

  // Type au complet : la ligne sans cible ; on retire alors les exclusions par cible devenues inutiles
  function basculerType(t: TypeNotification) {
    const complete = exclusions.find((x) => x.type === t.code && x.cible_id === null);
    if (complete) return executer(() => supabase.from("notifications_exclusions").delete().eq("id", complete.id));
    return executer(async () => {
      const r = await supabase.from("notifications_exclusions").delete().eq("type", t.code);
      if (r.error) return r;
      return supabase.from("notifications_exclusions").insert({ type: t.code, cible_id: null });
    });
  }

  function basculerCible(t: TypeNotification, c: Cible) {
    const ligne = exclusions.find((x) => x.type === t.code && x.cible_id === c.id);
    if (ligne) return executer(() => supabase.from("notifications_exclusions").delete().eq("id", ligne.id));
    return executer(() => supabase.from("notifications_exclusions").insert({ type: t.code, cible_id: c.id }));
  }

  return (
    <>
      <div className="entete" style={{ marginBottom: 12 }}>
        <button type="button" className="bouton" onClick={onRetour}>‹ Retour</button>
        <h2 style={{ margin: 0, fontSize: 18 }}>Préférences</h2>
      </div>

      <ActivationPush />

      {message && <div className="message alerte">{message}</div>}
      <p className="aide" style={{ marginBottom: 12 }}>
        Choisissez les notifications à recevoir. Ces choix sont les vôtres seulement.
      </p>

      {CATALOGUE.map((t) => {
        const typeExclu = exclusions.some((x) => x.type === t.code && x.cible_id === null);
        const liste = cibles[t.portee] ?? [];
        return (
          <div key={t.code} className="carte">
            <label className="ligne-interrupteur">
              <span>
                <span className="titre">{t.nom}</span>
                <span className="sous">{t.quand}</span>
              </span>
              <input type="checkbox" className="interrupteur" checked={!typeExclu} disabled={occupe}
                     onChange={() => basculerType(t)} />
            </label>
            {!typeExclu && liste.length > 1 && (
              <div className="cibles-notif">
                {liste.map((c) => (
                  <label key={c.id}>
                    <input type="checkbox" checked={!estExclue(exclusions, t.code, c.id)} disabled={occupe}
                           onChange={() => basculerCible(t, c)} />
                    {c.nom}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
