'use client'

import { useState, useEffect } from 'react'
import { Inter } from 'next/font/google'
import './globals.css'
import Navbar from './components/Navbar'

const inter = Inter({ subsets: ['latin'] })

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [darkMode, setDarkMode] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    setDarkMode(prefersDark)
  }, [])

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  return (
    <html lang="en">
      <body className={`${inter.className} bg-background-light dark:bg-background-dark text-text-light dark:text-text-dark`}>
        {mounted && (
          <>
            <Navbar darkMode={darkMode} setDarkMode={setDarkMode} />
            {children}
          </>
        )}
      </body>
    </html>
  )
}
