import { supabase } from "./supabase";

// Notifications poussées (Web Push) sur ce téléphone (v0.8.9).
// iPhone : iOS 16.4 ou plus, et l'app doit être ouverte depuis l'écran d'accueil.
// La clé publique VAPID vient de Vercel (NEXT_PUBLIC_VAPID_PUBLIC_KEY, voir README).

const CLE_PUBLIQUE = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export type EtatPush =
  | "non-supporte"   // navigateur sans Web Push
  | "a-installer"    // iPhone dans Safari : ajouter d'abord à l'écran d'accueil
  | "non-configure"  // clés VAPID absentes dans Vercel
  | "refuse"         // l'utilisateur a refusé dans iOS
  | "inactif"
  | "actif";

function estIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function estInstallee(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function versOctets(base64: string): Uint8Array<ArrayBuffer> {
  const rembourre = "=".repeat((4 - (base64.length % 4)) % 4);
  const brut = atob((base64 + rembourre).replace(/-/g, "+").replace(/_/g, "/"));
  const octets = new Uint8Array(new ArrayBuffer(brut.length));
  for (let i = 0; i < brut.length; i++) octets[i] = brut.charCodeAt(i);
  return octets;
}

export async function enregistrerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // sans service worker, le centre de notifications fonctionne quand même
  }
}

export async function etatPush(): Promise<EtatPush> {
  const supporte = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supporte) return estIOS() && !estInstallee() ? "a-installer" : "non-supporte";
  if (!CLE_PUBLIQUE) return "non-configure";
  if (Notification.permission === "denied") return "refuse";
  const reg = await navigator.serviceWorker.getRegistration();
  const abonnement = await reg?.pushManager.getSubscription();
  return abonnement && Notification.permission === "granted" ? "actif" : "inactif";
}

/** À appeler directement dans le toucher d'un bouton (exigence d'iOS). Retourne un message d'erreur ou null. */
export async function activerPush(): Promise<string | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications refusées. Pour changer d'idée : Réglages > Notifications > So-Max.";
  await enregistrerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const abonnement = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: versOctets(CLE_PUBLIQUE) }));
  const json = abonnement.toJSON();
  const { error } = await supabase.from("abonnements_push").upsert({
    endpoint: abonnement.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
    appareil: navigator.userAgent.slice(0, 200),
  }, { onConflict: "endpoint" });
  if (error) return "Abonnement non enregistré : " + error.message;
  return null;
}

export async function desactiverPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const abonnement = await reg?.pushManager.getSubscription();
  if (!abonnement) return;
  await supabase.from("abonnements_push").delete().eq("endpoint", abonnement.endpoint);
  await abonnement.unsubscribe();
}
