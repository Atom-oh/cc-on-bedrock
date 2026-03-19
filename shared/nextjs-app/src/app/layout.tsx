import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Providers from "./providers";
import Sidebar from "@/components/sidebar";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "CC-on-Bedrock Dashboard",
  description:
    "Multi-user Claude Code development environment on AWS Bedrock",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 overflow-y-auto">
              <div className="p-6 lg:p-8">{children}</div>
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
