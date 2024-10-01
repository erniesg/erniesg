'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { FaSun, FaMoon } from 'react-icons/fa'

interface NavbarProps {
  darkMode: boolean;
  setDarkMode: (darkMode: boolean) => void;
}

const Navbar: React.FC<NavbarProps> = ({ darkMode, setDarkMode }) => {
  const [language, setLanguage] = useState<'EN' | '中'>('EN')

  return (
    <nav className="bg-surface-light dark:bg-surface-dark shadow-md dark:shadow-[0_4px_6px_-1px_rgba(0,0,0,0.3)] z-10 absolute top-0 left-0 right-0">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex">
            <div className="flex-shrink-0 flex items-center">
              <span className="text-2xl font-bold text-primary-light dark:text-primary-dark">Ernie.SG</span>
            </div>
            <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
              {['about', 'code', 'culture', 'community', 'buzzin', 'contact'].map((section) => (
                <Link key={section} href={`#${section}`} className="nav-link border-transparent hover:border-current inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium">
                  {section.charAt(0).toUpperCase() + section.slice(1)}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 rounded-full text-text-light dark:text-text-dark hover:bg-background-light dark:hover:bg-background-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-light dark:focus:ring-primary-dark"
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <FaSun /> : <FaMoon />}
            </button>
            <button
              onClick={() => setLanguage(language === 'EN' ? '中' : 'EN')}
              className="ml-3 p-2 rounded-full text-text-light dark:text-text-dark hover:bg-background-light dark:hover:bg-background-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-light dark:focus:ring-primary-dark"
              title={`Current Language: ${language}. Click to switch.`}
            >
              {language}
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}

export default Navbar
