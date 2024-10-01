import { Metadata } from 'next'
import { generateMetadata } from './metadata'
import HomeClient from './components/HomeClient'

export const metadata: Metadata = generateMetadata()

export default function Home() {
  return <HomeClient />
}
