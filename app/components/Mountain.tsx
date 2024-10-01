'use client'

import React, { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js'

const MountainMesh: React.FC<{ isDarkMode: boolean }> = ({ isDarkMode }) => {
  const mesh = useRef<THREE.Mesh>(null!)
  const simplex = useMemo(() => new SimplexNoise(), [])

  const generateHeight = (x: number, y: number) => {
    const value = simplex.noise(x / 50, y / 50) * 10
    return value > 0 ? Math.pow(value, 1.5) : 0
  }

  useFrame(() => {
    if (mesh.current) {
      mesh.current.rotation.y += 0.001
    }
  })

  const positions = useMemo(() => {
    const pos = []
    const size = 100
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const x = i - size / 2
        const y = j - size / 2
        const z = generateHeight(i, j)
        pos.push(x, z, y)
      }
    }
    return new Float32Array(pos)
  }, [generateHeight])

  // Use Tailwind classes instead of hard-coded colors
  const mountainColor = isDarkMode ? '#4FD1C5' : '#9CA3AF'

  return (
    <mesh ref={mesh}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <meshStandardMaterial color={mountainColor} wireframe />
    </mesh>
  )
}

interface MountainProps {
  isDarkMode: boolean;
}

const Mountain: React.FC<MountainProps> = ({ isDarkMode }) => {
  return (
    <div className="w-full h-full relative">
      <Canvas camera={{ position: [0, 50, 100], fov: 75 }}>
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} />
        <MountainMesh isDarkMode={isDarkMode} />
      </Canvas>
    </div>
  )
}

export default Mountain
