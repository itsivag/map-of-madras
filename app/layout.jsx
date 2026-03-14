import Script from 'next/script';
import { Space_Grotesk, Source_Sans_3 } from 'next/font/google';
import 'leaflet/dist/leaflet.css';
import './globals.css';

const displayFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['500', '700']
});

const bodyFont = Source_Sans_3({
  subsets: ['latin'],
  variable: '--font-body',
  weight: ['400', '600', '700']
});

export const metadata = {
  title: 'Map of Madras',
  description: 'Chennai-focused incident map powered by a Next.js frontend and a separate ingestion API.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${displayFont.variable} ${bodyFont.variable}`}>
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
