// app/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "SSR Slack Receipt Bot",
  description: "Slack receipt bot backend",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
