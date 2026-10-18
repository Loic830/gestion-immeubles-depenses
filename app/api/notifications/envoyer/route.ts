import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";

// Envoi des notifications poussées (Web Push) — v0.8.9.
//
// GET  : Vercel Cron, chaque matin (vercel.json). Calcule les alertes du jour
//        (generer_notifications) puis pousse aux téléphones de tout le monde.
//        Protégé par CRON_SECRET (Vercel envoie « Authorization: Bearer <CRON_SECRET> »).
// POST : l'app (« Tester les notifications possibles ») avec le jeton de la personne
//        connectée : pousse seulement ses notifications pas encore envoyées.
//
// Variables Vercel (serveur seulement, jamais NEXT_PUBLIC_) : SUPABASE_SERVICE_ROLE_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUJET (mailto:…), CRON_SECRET ; plus NEXT_PUBLIC_VAPID_PUBLIC_KEY.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ligne = { id: string; user_id: string; titre: string; description: string; lue_le: string | null };
type Abonnement = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

function json(statut: number, corps: Record<string, unknown>) {
  return Response.json(corps, { status: statut });
}

function clientAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const cle = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && cle ? createClient(url, cle, { auth: { persistSession: false } }) : null;
}

function pushConfigure(): boolean {
  const publique = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privee = process.env.VAPID_PRIVATE_KEY;
  if (!publique || !privee) return false;
  webpush.setVapidDetails(process.env.VAPID_SUJET || "mailto:admin@example.com", publique, privee);
  return true;
}

/** Pousse les notifications non envoyées (des 3 derniers jours) ; retourne le nombre de messages livrés. */
async function pousser(admin: SupabaseClient, userId: string | null): Promise<number> {
  const depuis = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  let requete = admin.from("notifications").select("id, user_id, titre, description, lue_le")
    .is("poussee_le", null).is("deleted_at", null).gte("created_at", depuis).order("created_at");
  if (userId) requete = requete.eq("user_id", userId);
  const { data: lignes, error } = await requete;
  if (error) throw new Error(error.message);
  if (!lignes?.length) return 0;

  const personnes = [...new Set(lignes.map((l) => l.user_id))];
  const { data: abonnements } = await admin.from("abonnements_push")
    .select("id, user_id, endpoint, p256dh, auth").in("user_id", personnes);

  let livres = 0;
  const expires = new Set<string>();
  for (const n of lignes as Ligne[]) {
    // Déjà lue dans l'app : inutile de la pousser
    if (!n.lue_le) {
      for (const a of ((abonnements ?? []) as Abonnement[]).filter((x) => x.user_id === n.user_id && !expires.has(x.id))) {
        try {
          await webpush.sendNotification(
            { endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
            JSON.stringify({ id: n.id, titre: n.titre, description: n.description }),
            { TTL: 24 * 3600 },
          );
          livres++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) expires.add(a.id); // abonnement retiré du téléphone
        }
      }
    }
    await admin.from("notifications").update({ poussee_le: new Date().toISOString() }).eq("id", n.id);
  }
  if (expires.size) await admin.from("abonnements_push").delete().in("id", [...expires]);
  return livres;
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return json(401, { message: "Non autorisé." });
  const admin = clientAdmin();
  if (!admin) return json(500, { message: "SUPABASE_SERVICE_ROLE_KEY manquante dans Vercel." });

  const { data: creees, error } = await admin.rpc("generer_notifications");
  if (error) return json(500, { message: error.message });
  if (!pushConfigure()) return json(200, { creees, livres: 0, message: "Clés VAPID absentes : notifications créées, rien de poussé." });
  try {
    return json(200, { creees, livres: await pousser(admin, null) });
  } catch (e) {
    return json(500, { message: (e as Error).message });
  }
}

export async function POST(req: Request) {
  const jeton = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const admin = clientAdmin();
  if (!admin) return json(200, { livres: 0, message: "Envoi au téléphone pas encore configuré (clé Supabase serveur manquante dans Vercel)." });
  const { data: u, error } = await admin.auth.getUser(jeton);
  if (error || !u.user) return json(401, { message: "Session expirée." });
  if (!pushConfigure()) return json(200, { livres: 0, message: "Envoi au téléphone pas encore configuré (clés VAPID manquantes dans Vercel)." });
  try {
    return json(200, { livres: await pousser(admin, u.user.id) });
  } catch (e) {
    return json(500, { message: (e as Error).message });
  }
}
