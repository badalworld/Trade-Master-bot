import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
      <div className="neon-card max-w-md w-full text-center">
        <div className="neon-card-inner p-8">
          <h2 className="text-4xl font-extrabold text-cyan-400 font-mono mb-2">404</h2>
          <p className="text-slate-300 text-sm mb-6">Page Not Found</p>
          <Link
            href="/"
            className="inline-flex items-center px-4 py-2 text-xs font-semibold rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-colors shadow-[0_0_12px_rgba(0,240,255,0.4)]"
          >
            Return to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
