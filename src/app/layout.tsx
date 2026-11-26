import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Ollama Benchmark',
  description: 'Benchmark Ollama models with blind LLM judges',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans text-sm">
        <header className="border-b border-line bg-panel">
          <nav className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="font-semibold tracking-tight">
              Ollama Benchmark
            </Link>
            <Link href="/" className="text-muted hover:text-fg">
              Dashboard
            </Link>
            <Link href="/models" className="text-muted hover:text-fg">
              Models
            </Link>
            <Link href="/run" className="ml-auto rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg hover:opacity-90">
              New run
            </Link>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
