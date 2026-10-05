'use client';

import Image from 'next/image';

/**
 * Slim dark app header with attribution to the upstream project.
 */
export default function Header() {
  return (
    <header className="w-full border-b border-gray-800 bg-gray-900">
      <div className="container mx-auto px-4 py-3 md:px-6">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <span className="flex items-center gap-2">
            <Image
              src="/logo.png"
              alt="Screen Recorder"
              width={28}
              height={28}
              className="h-7 w-auto"
            />
            <span className="text-lg font-bold tracking-tight text-gray-100">
              Screen Recorder
            </span>
          </span>

          <a
            href="https://github.com/heysagnik/screenREC"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
          >
            Based on screenREC by Sagnik Sahoo
          </a>
        </div>
      </div>
    </header>
  );
}
