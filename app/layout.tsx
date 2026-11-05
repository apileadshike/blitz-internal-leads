import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { DialogHost } from "@/components/dialog";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = { title: "Blitz Lead Engine" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {children}
        <DialogHost />
      </body>
    </html>
  );
}
