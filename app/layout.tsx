import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Trade Master | Binance Futures Algorithmic Trading Bot',
  description: 'Automated Binance Futures 5m algorithmic trading bot featuring 3-indicator high-probability signal scanning, dynamic TP/SL, profit compounding, and API rate-limit defense.',
  openGraph: {
    title: 'Trade Master | Binance Futures Algorithmic Trading Bot',
    description: 'Automated Binance Futures 5m algorithmic trading bot featuring 3-indicator high-probability signal scanning, dynamic TP/SL, profit compounding, and API rate-limit defense.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trade Master | Binance Futures Algorithmic Trading Bot',
    description: 'Automated Binance Futures 5m algorithmic trading bot featuring 3-indicator high-probability signal scanning, dynamic TP/SL, profit compounding, and API rate-limit defense.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
