import type { Metadata, Viewport } from "next";
import "./globals.css";
import EnTete from "@/components/EnTete";

export const metadata: Metadata = {
  title: "Immeubles So-Max",
  description: "Gestion des immeubles : loyers, baux, frais fixes, dépenses et véhicule",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "So-Max", statusBarStyle: "default" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1b4d34",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr-CA">
      <body>
        <EnTete />
        {children}
      </body>
    </html>
  );
}
