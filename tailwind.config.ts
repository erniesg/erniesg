import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          light: '#3B82F6', // blue-500
          dark: '#60A5FA', // blue-400
        },
        background: {
          light: '#F3F4F6', // gray-100
          dark: '#1F2937', // gray-800
        },
        surface: {
          light: '#FFFFFF', // white
          dark: '#374151', // gray-700
        },
        text: {
          light: '#1F2937', // gray-800
          dark: '#F9FAFB', // gray-50
        },
        mountain: {
          light: '#9CA3AF', // gray-400
          dark: '#6B7280', // gray-500 (lighter than before)
        },
      },
      fontFamily: {
        sans: ['Roboto', 'sans-serif'],
        serif: ['Noto Serif', 'serif'],
      },
      boxShadow: {
        'navbar-dark': '0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.24)',
      },
    },
  },
  plugins: [],
};

export default config;
