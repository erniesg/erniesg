'use client'

import { useState, useEffect } from 'react'
import Mountain from './Mountain'
import AnimatedText from './AnimatedText'
import Navbar from './Navbar'

const HomeClient = () => {
  const [darkMode, setDarkMode] = useState(false)

  useEffect(() => {
    // Check system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    setDarkMode(prefersDark)

    // Listen for changes in system preference
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => setDarkMode(e.matches)
    mediaQuery.addEventListener('change', handleChange)

    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  return (
    <>
      <Navbar darkMode={darkMode} setDarkMode={setDarkMode} />
      <main className="space-y-8">
        <section className="h-screen flex flex-col relative">
          <div className="absolute inset-0">
            <Mountain isDarkMode={darkMode} />
          </div>
          <div className="absolute inset-x-0 bottom-0 p-4 mb-8 z-10">
            <AnimatedText text="Hi, I am Ernie, an 🤖 A.I. Engineer based in 🏝️ Singapore." />
          </div>
        </section>
        {/* Other sections */}
      </main>
    </>
  )
}

export default HomeClient
