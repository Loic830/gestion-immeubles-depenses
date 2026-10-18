"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { dateReception, signalerMaj, type Notification } from "@/lib/notifications";
import PreferencesNotifications from "@/components/PreferencesNotifications";

// Tiroir de la cloche (v0.8.9) : notifications du plus récent au plus ancien.
// Non lue = contour jaune-orangé (même couleur que la cloche). Toucher une notification
// la marque comme lue ; toucher une notification lue la remet non lue.
// En bas, discret : « Préférences des notifications ».

export default function TiroirNotifications({ onFermer }: { onFermer: () => void }) {
  const [vue, setVue] = useState<"liste" | "preferences">("liste");
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [charge, setCharge] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("notifications")
      .select("id, type, cible_id, titre, description, est_test, lue_le, created_at")
      .is("deleted_at", null).order("created_at", { ascending: false }).limit(100)
      .then(({ data, error }) => {
        if (error) setErreur("Centre de notifications pas encore activé : exécuter supabase/013_notifications.sql.");
        setNotifs((data ?? []) as Notification[]);
        setCharge(true);
      });
  }, []);

  async function basculer(n: Notification) {
    const lue_le = n.lue_le ? null : new Date().toISOString();
    setNotifs((liste) => liste.map((x) => (x.id === n.id ? { ...x, lue_le } : x)));
    const { error } = await supabase.from("notifications").update({ lue_le }).eq("id", n.id);
    if (error) {
      setNotifs((liste) => liste.map((x) => (x.id === n.id ? n : x)));
      setErreur(error.message);
    }
    signalerMaj();
  }

  async function toutLire() {
    const maintenant = new Date().toISOString();
    const ids = notifs.filter((n) => !n.lue_le).map((n) => n.id);
    setNotifs((liste) => liste.map((x) => (x.lue_le ? x : { ...x, lue_le: maintenant })));
    await supabase.from("notifications").update({ lue_le: maintenant }).in("id", ids);
    signalerMaj();
  }

  const nonLues = notifs.filter((n) => !n.lue_le).length;

  return (
    <div className="tiroir-fond" onClick={onFermer}>
      <aside className="tiroir" role="dialog" aria-label="Notifications" onClick={(e) => e.stopPropagation()}>
        {vue === "preferences" ? (
          <PreferencesNotifications onRetour={() => setVue("liste")} />
        ) : (
          <>
            <div className="entete" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Notifications</h2>
              <button type="button" className="bouton" onClick={onFermer}>Fermer</button>
            </div>

            {erreur && <div className="message alerte">{erreur}</div>}

            {notifs.length > 0 && (
              <p className="aide" style={{ margin: "0 0 8px" }}>Touchez une notification pour la marquer lue ou non lue.</p>
            )}
            {nonLues > 0 && (
              <div className="entete" style={{ marginBottom: 8 }}>
                <span className="aide" style={{ margin: 0 }}>{nonLues} non lue{nonLues > 1 ? "s" : ""}</span>
                <button type="button" className="lien-filtres" style={{ margin: 0 }} onClick={toutLire}>
                  Tout marquer comme lu
                </button>
              </div>
            )}

            {charge && !erreur && notifs.length === 0 && (
              <div className="carte">
                <strong>Aucune notification</strong>
                <p className="aide">Les rappels (hypothèque, assurances, taxes, avis de renouvellement, loyers en retard,
                  compteur du véhicule) apparaîtront ici.</p>
              </div>
            )}

            {notifs.map((n) => (
              <button key={n.id} type="button" className={`carte-notif${n.lue_le ? "" : " non-lue"}`}
                      onClick={() => basculer(n)}
                      aria-label={`${n.titre}. ${n.lue_le ? "Lue : toucher pour marquer non lue" : "Non lue : toucher pour marquer lue"}`}>
                <span className="titre">{n.titre}</span>
                <span className="description">{n.description}</span>
                <span className="pied">
                  <span>{n.lue_le ? "Lue" : "Non lue"}{n.est_test && " · test"}</span>
                  <span className="date">{dateReception(n.created_at)}</span>
                </span>
              </button>
            ))}

            <div style={{ marginTop: 24 }}>
              <button type="button" className="bouton plein bouton-discret" onClick={() => setVue("preferences")}>
                Préférences des notifications
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
