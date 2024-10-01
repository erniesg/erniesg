'use client'

import React, { useMemo, useRef, useEffect } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Mesh } from 'three'
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise'

const MountainMesh: React.FC<{ isDarkMode: boolean }> = ({ isDarkMode }) => {
  const mesh = useRef<Mesh>(null!)
  const simplex = useMemo(() => new SimplexNoise(), [])
  const { camera } = useThree()

  useEffect(() => {
    if (camera) {
      camera.position.set(0, 50, 100)
      camera.lookAt(0, 0, 0)
    }
  }, [camera])

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
  }, [])

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
      <meshStandardMaterial color={isDarkMode ? '#FFFFFF' : '#4A5568'} wireframe />
    </mesh>
  )
}

interface MountainProps {
  isDarkMode: boolean;
}

const Mountain: React.FC<MountainProps> = ({ isDarkMode }) => {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas camera={{ position: [0, 50, 100], fov: 75 }}>
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} />
        <MountainMesh isDarkMode={isDarkMode} />
      </Canvas>
    </div>
  )
}

export default Mountain
