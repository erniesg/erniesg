'use client'

import { useState, useEffect } from 'react'
import Mountain from './Mountain'
import AnimatedText from './AnimatedText'
import Navbar from './Navbar'

const HomeClient = () => {
  const [darkMode, setDarkMode] = useState(false)

  useEffect(() => {
    const hour = new Date().getHours()
    setDarkMode(hour < 6 || hour >= 18) // Dark mode between 6 PM and 6 AM
  }, [])

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  return (
    <div className="flex flex-col min-h-screen bg-background-light dark:bg-background-dark text-text-light dark:text-text-dark">
      <Navbar darkMode={darkMode} setDarkMode={setDarkMode} />
      <main className="flex-grow">
        <section className="h-[calc(100vh-4rem)] relative">
          <div className="absolute inset-0">
            <Mountain isDarkMode={darkMode} />
          </div>
          <div className="absolute inset-x-0 bottom-0 p-4 mb-8 z-10">
            <AnimatedText text="Hi, I am Ernie, an 🤖 A.I. Engineer based in 🏝️ Singapore." />
          </div>
        </section>
        {/* Other sections */}
      </main>
    </div>
  )
}

export default HomeClient
