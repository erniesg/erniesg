import { geoEquirectangular, geoPath } from 'd3-geo'
import * as THREE from 'three'
import type { GeoPermissibleObjects } from 'd3-geo'
import { ATLAS_MARKED } from '../../data/atlas'
import {
  CAMERA_FOV,
  CLOSEST_DISTANCE,
  pickFeature,
  REST_DISTANCE,
  routeFraming,
  type AtlasFeature,
} from './geo'

export type GlobeOptions = {
  canvas: HTMLCanvasElement
  features: AtlasFeature[]
  /** A passive globe only spins: no pointer handling, so a parent link gets the click. */
  passive?: boolean
  onHover?: (feature: AtlasFeature | undefined, x: number, y: number) => void
  onSelect?: (feature: AtlasFeature | undefined) => void
  onAnchors?: (anchors: GlobeAnchors) => void
}

export type GlobeAnchor = { x: number; y: number; visible: boolean }
/** Screen positions of the selected route's two ends, in canvas pixels. */
export type GlobeAnchors = {
  home?: GlobeAnchor
  selected?: GlobeAnchor
  midpoint?: GlobeAnchor
}

export type Globe = {
  select: (name: string | undefined) => void
  dispose: () => void
}

// Light and dark palettes. The legend in atlas.astro uses the same values.
const THEMES = {
  light: {
    ocean: '#eef3f5',
    oceanDeep: '#dbe6ea',
    easy: '#3f8fd0',
    special: '#b9c4cd',
    required: '#7b2d8e',
    border: '#6f808c',
    visited: '#078969',
    wall: '#04523f',
    focus: '#f0962b',
    rim: '#a9cfdf',
    rimStrength: 0.6,
    plane: '#14222a',
  },
  dark: {
    ocean: '#101c23',
    oceanDeep: '#080f13',
    easy: '#3f8fd0',
    special: '#56636e',
    required: '#e6a3ff',
    border: '#7c909e',
    visited: '#1fc79b',
    wall: '#0a5a48',
    focus: '#ffb04a',
    rim: '#4fa8c9',
    rimStrength: 0.62,
    plane: '#ffffff',
  },
}

const VERTEX = /* glsl */ `
  uniform float uLevel;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(position * (1.0 + uLevel), 1.0);
    vView = normalize(-view.xyz);
    gl_Position = projectionMatrix * view;
  }
`

const LIGHT = /* glsl */ `
  float lightOf(vec3 n) {
    vec3 l = normalize(vec3(-0.5, 0.6, 0.75));
    return 0.84 + 0.2 * max(dot(n, l), 0.0);
  }
`

const SURFACE_FRAGMENT = /* glsl */ `
  uniform sampler2D uMask, uClass;
  uniform vec3 uOcean, uOceanDeep, uEasy, uSpecial, uRequired, uBorder;
  uniform float uDot;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  ${LIGHT}
  vec3 category(float code) {
    if (code < 0.5) return uEasy;
    if (code < 0.83) return uSpecial;
    return uRequired;
  }
  void main() {
    vec3 n = normalize(vNormal);
    float facing = max(dot(n, normalize(vView)), 0.0);
    vec3 color = mix(uOceanDeep, uOcean, smoothstep(0.0, 0.85, facing));

    float lat = (vUv.y - 0.5) * 180.0;
    float lon = vUv.x * 360.0 - 180.0;
    float row = floor((lat + 90.0) / uDot);
    float rowLat = (row + 0.5) * uDot - 90.0;
    float count = max(1.0, floor(360.0 * cos(radians(rowLat)) / uDot));
    float width = 360.0 / count;
    float column = floor((lon + 180.0) / width);
    float columnLon = (column + 0.5) * width - 180.0;
    vec2 center = vec2((columnLon + 180.0) / 360.0, (rowLat + 90.0) / 180.0);
    // Each dot takes one country's category. Visited land has none: plates cover it.
    float site = texture2D(uClass, center).r;

    vec2 delta = vec2((lon - columnLon) * cos(radians(lat)), lat - rowLat);
    float aa = max(fwidth(lat), 0.02);
    float dotShape = 1.0 - smoothstep(uDot * 0.36 - aa, uDot * 0.36 + aa, length(delta));
    // Dots shrink below a pixel at the limb; a flat tone avoids moire there.
    vec4 fine = texture2D(uMask, vUv);
    float flat_ = smoothstep(0.3, 0.75, aa / uDot);
    float land = mix(dotShape * step(0.1, site), fine.r * (1.0 - fine.g) * 0.42, flat_);
    vec3 tint = category(mix(site, texture2D(uClass, vUv).r, flat_));
    color = mix(color, tint, land * 0.95);
    color = mix(color, uBorder, fine.b * 0.9);

    // Contact shadow around raised plates.
    float shadow = textureLod(uMask, vUv, 3.5).g;
    color *= 1.0 - 0.34 * smoothstep(0.02, 0.6, shadow);
    gl_FragColor = vec4(color * lightOf(n), 1.0);
    #include <colorspace_fragment>
  }
`

const PLATE_FRAGMENT = /* glsl */ `
  uniform sampler2D uMask, uFocus, uClass;
  uniform vec3 uVisited, uWall, uAccent, uEasy, uSpecial, uRequired;
  uniform float uLevel, uBase, uSelected, uHovered, uTop;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  ${LIGHT}
  void main() {
    vec4 mask = texture2D(uMask, vUv);
    vec4 focus = texture2D(uFocus, vUv);
    float visited = mask.g;
    float height = max(max(visited * uBase, focus.r * uSelected), focus.g * uHovered);
    float edge = height - uLevel;
    float aa = max(fwidth(height), 0.0004);
    float alpha = smoothstep(-aa, aa, edge);
    if (alpha < 0.02) discard;

    vec3 n = normalize(vNormal);
    float isTop = smoothstep(0.0, uTop * 1.4, uTop * 1.4 - edge);
    vec3 baseTint = uVisited;
    if (visited < 0.5) {
      float code = texture2D(uClass, vUv).r;
      baseTint = code < 0.5 ? uEasy : code < 0.83 ? uSpecial : uRequired;
    }
    baseTint *= mix(1.0, 0.62, smoothstep(0.2, 0.75, mask.b));
    vec3 top = mix(baseTint, uAccent, smoothstep(0.4, 0.8, focus.r));
    top = mix(top, top * 1.12 + 0.03, smoothstep(0.4, 0.8, focus.g));
    vec3 wall = uWall * mix(0.7, 1.15, uLevel / max(uSelected, 0.001));
    vec3 color = mix(wall, top, isTop);
    float rim = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 3.0);
    color += top * rim * 0.18;
    gl_FragColor = vec4(color * lightOf(n), alpha);
    #include <colorspace_fragment>
    // The canvas composites premultiplied; straight alpha would glow at edges.
    gl_FragColor.rgb *= alpha;
  }
`

const HALO_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-view.xyz);
    gl_Position = projectionMatrix * view;
  }
`

const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 uRim;
  uniform float uStrength;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    // Back faces: 0 at the halo's outer edge, about 0.38 where it meets the globe.
    float facing = -dot(normalize(vNormal), normalize(vView));
    float halo = pow(clamp(facing / 0.38, 0.0, 1.0), 2.8);
    gl_FragColor = vec4(uRim, halo * uStrength);
    #include <colorspace_fragment>
  }
`

const DEG = Math.PI / 180
const SHELLS = 14
const SHELL_TOP = 0.036
const BASE_HEIGHT = 0.014

function pointOn(lon: number, lat: number, radius = 1) {
  const cosLat = Math.cos(lat * DEG)
  return new THREE.Vector3(
    radius * Math.cos(lon * DEG) * cosLat,
    radius * Math.sin(lat * DEG),
    -radius * Math.sin(lon * DEG) * cosLat,
  )
}

/** Yaw and pitch that bring a longitude and latitude to face the camera. */
function facing(lon: number, lat: number) {
  return { yaw: -Math.PI / 2 - lon * DEG, pitch: lat * DEG }
}

function shortestAngle(from: number, to: number) {
  const turn = Math.PI * 2
  return from + ((((to - from) % turn) + turn + Math.PI) % turn) - Math.PI
}

/** Red: any land. Green: visited land. Blue: country borders and coastlines. */
function drawMask(features: AtlasFeature[], size: number) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size / 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size / 2)
  const projection = geoEquirectangular()
    .scale(size / (2 * Math.PI))
    .translate([size / 2, size / 4])
  const path = geoPath(projection, ctx)
  for (const f of features) {
    const visited = f.status === 'visited'
    ctx.fillStyle = `rgb(255, ${visited ? 255 : 0}, 0)`
    ctx.beginPath()
    path(f.geometry as GeoPermissibleObjects)
    ctx.fill()
    if (visited && f.radius < 0.03) {
      // Plump up tiny countries so they survive as raised plates.
      ctx.strokeStyle = ctx.fillStyle
      ctx.lineWidth = size / 1400
      ctx.stroke()
    }
  }
  // Added on top so the land and visited channels stay intact underneath.
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = 'rgb(0, 0, 255)'
  ctx.lineWidth = size / 2200
  for (const f of features) {
    if (f.radius < 0.012) continue
    ctx.beginPath()
    path(f.geometry as GeoPermissibleObjects)
    ctx.stroke()
  }
  return canvas
}

const CLASS_CODE = { easy: 85, special: 170, required: 255 } as const

/**
 * The access category per texel, as exact values read without interpolation.
 * Canvas edges are antialiased, so storing categories as colours made a border
 * between 255 and 85 average to 170 and read as a third category that was never
 * there. Separate channels let each edge texel pick its largest real neighbour.
 */
function drawClasses(features: AtlasFeature[], width: number) {
  const height = width / 2
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D canvas')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'lighter'
  const path = geoPath(
    geoEquirectangular()
      .scale(width / (2 * Math.PI))
      .translate([width / 2, height / 2]),
    ctx,
  )
  const fills = { easy: '#f00', special: '#0f0', required: '#00f' } as const
  for (const f of features) {
    if (f.status === 'visited') continue
    ctx.fillStyle = fills[f.status]
    ctx.beginPath()
    path(f.geometry as GeoPermissibleObjects)
    ctx.fill()
  }
  const { data } = ctx.getImageData(0, 0, width, height)
  const classes = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    // Canvas rows run north to south; texture rows run south to north.
    const target = (height - 1 - y) * width
    const source = y * width
    for (let x = 0; x < width; x += 1) {
      const easy = data[(source + x) * 4]
      const special = data[(source + x) * 4 + 1]
      const required = data[(source + x) * 4 + 2]
      const most = Math.max(easy, special, required)
      if (most < 90) continue
      classes[target + x] =
        most === required
          ? CLASS_CODE.required
          : most === special
            ? CLASS_CODE.special
            : CLASS_CODE.easy
    }
  }
  const texture = new THREE.DataTexture(classes, width, height, THREE.RedFormat)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.needsUpdate = true
  return texture
}

/** Top-down airliner silhouette, nose along +Y, lying flat in the XY plane. */
function planeGeometry() {
  const right: [number, number][] = [
    [0, 1],
    [0.09, 0.82],
    [0.1, 0.3],
    [1, -0.16],
    [1, -0.3],
    [0.1, -0.08],
    [0.08, -0.62],
    [0.4, -0.86],
    [0.4, -0.98],
    [0, -0.86],
  ]
  const outline = [
    ...right,
    ...right
      .slice(1, -1)
      .reverse()
      .map(([x, y]): [number, number] => [-x, y]),
  ]
  const shape = new THREE.Shape(
    outline.map(([x, y]) => new THREE.Vector2(x, y)),
  )
  return new THREE.ShapeGeometry(shape)
}

function arcBetween(from: AtlasFeature, to: AtlasFeature) {
  const a = pointOn(from.centroid[0], from.centroid[1])
  const b = pointOn(to.centroid[0], to.centroid[1])
  const angle = a.angleTo(b)
  const lift = 0.05 + angle * 0.13
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= 64; i += 1) {
    const t = i / 64
    const sinAngle = Math.sin(angle) || 1
    const point = a
      .clone()
      .multiplyScalar(Math.sin((1 - t) * angle) / sinAngle)
      .add(b.clone().multiplyScalar(Math.sin(t * angle) / sinAngle))
      .normalize()
    points.push(point.multiplyScalar(1 + 0.012 + lift * Math.sin(Math.PI * t)))
  }
  const curve = new THREE.CatmullRomCurve3(points)
  return {
    curve,
    geometry: new THREE.TubeGeometry(curve, 96, 0.0024, 6, false),
    angle,
  }
}

export function createGlobe({
  canvas,
  features,
  passive = false,
  onHover,
  onSelect,
  onAnchors,
}: GlobeOptions): Globe {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 20)
  camera.position.z = REST_DISTANCE
  const globe = new THREE.Group()
  scene.add(globe)

  const textureSize = Math.min(renderer.capabilities.maxTextureSize, 4096)
  const mask = new THREE.CanvasTexture(drawMask(features, textureSize))
  mask.generateMipmaps = true
  mask.minFilter = THREE.LinearMipmapLinearFilter
  mask.magFilter = THREE.LinearFilter
  mask.wrapS = THREE.RepeatWrapping
  mask.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)

  const classTexture = drawClasses(features, Math.min(textureSize, 2048))

  const focusCanvas = document.createElement('canvas')
  focusCanvas.width = 2048
  focusCanvas.height = 1024
  const focusContext = focusCanvas.getContext('2d')
  if (!focusContext) throw new Error('No 2D canvas')
  focusContext.globalCompositeOperation = 'lighter'
  const focus = new THREE.CanvasTexture(focusCanvas)
  focus.minFilter = THREE.LinearFilter
  focus.generateMipmaps = false
  focus.wrapS = THREE.RepeatWrapping
  const focusPath = geoPath(
    geoEquirectangular()
      .scale(2048 / (2 * Math.PI))
      .translate([1024, 512]),
    focusContext,
  )

  const shared = {
    uMask: { value: mask },
    uFocus: { value: focus },
    uClass: { value: classTexture },
    uBorder: { value: new THREE.Color() },
    uOcean: { value: new THREE.Color() },
    uOceanDeep: { value: new THREE.Color() },
    uEasy: { value: new THREE.Color() },
    uSpecial: { value: new THREE.Color() },
    uRequired: { value: new THREE.Color() },
    uVisited: { value: new THREE.Color() },
    uWall: { value: new THREE.Color() },
    uAccent: { value: new THREE.Color() },
    uBase: { value: 0 },
    uSelected: { value: 0 },
    uHovered: { value: 0 },
    uTop: { value: SHELL_TOP / SHELLS },
    uDot: { value: 1 },
  }

  const geometry = new THREE.SphereGeometry(1, 160, 110)
  const surface = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: SURFACE_FRAGMENT,
    uniforms: { ...shared, uLevel: { value: 0 } },
  })
  globe.add(new THREE.Mesh(geometry, surface))

  const plates: THREE.ShaderMaterial[] = []
  for (let i = 1; i <= SHELLS; i += 1) {
    const plate = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: PLATE_FRAGMENT,
      uniforms: {
        ...shared,
        uLevel: { value: (i / (SHELLS + 0.5)) * SHELL_TOP },
      },
      alphaToCoverage: true,
      transparent: false,
    })
    plates.push(plate)
    const mesh = new THREE.Mesh(geometry, plate)
    mesh.renderOrder = i
    globe.add(mesh)
  }

  const haloMaterial = new THREE.ShaderMaterial({
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    uniforms: { uRim: { value: new THREE.Color() }, uStrength: { value: 0.5 } },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  })
  const haloGeometry = new THREE.SphereGeometry(1.085, 96, 64)
  scene.add(new THREE.Mesh(haloGeometry, haloMaterial))

  // Beads make the smallest countries findable; a pulsing ring marks home.
  const beadGeometry = new THREE.SphereGeometry(0.0085, 16, 12)
  const beadMaterial = new THREE.MeshBasicMaterial()
  const homeMaterial = new THREE.MeshBasicMaterial()
  const ringGeometry = new THREE.RingGeometry(0.82, 1, 48)
  const ringMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const ring = new THREE.Mesh(ringGeometry, ringMaterial)
  const byName = new Map(features.map((f) => [f.name, f]))
  const home = byName.get('Singapore')
  const beads = new Map<AtlasFeature, THREE.Mesh>()
  for (const name of ATLAS_MARKED) {
    const f = byName.get(name)
    if (!f) continue
    const bead = new THREE.Mesh(
      beadGeometry,
      f === home ? homeMaterial : beadMaterial,
    )
    bead.position.copy(
      pointOn(f.centroid[0], f.centroid[1], 1 + BASE_HEIGHT + 0.012),
    )
    beads.set(f, bead)
    globe.add(bead)
  }
  if (home) {
    const origin = pointOn(
      home.centroid[0],
      home.centroid[1],
      1 + BASE_HEIGHT + 0.004,
    )
    ring.position.copy(origin)
    ring.lookAt(origin.clone().multiplyScalar(2))
    globe.add(ring)
  }

  const arcMaterial = new THREE.MeshBasicMaterial()
  let arc: THREE.Mesh | undefined
  let curve: THREE.CatmullRomCurve3 | undefined
  let flightSeconds = 0
  let routeAngle = 0
  let flightClock = 0

  const planeShape = planeGeometry()
  const planeMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const plane = new THREE.Mesh(planeShape, planeMaterial)
  const planeShadow = new THREE.Mesh(planeShape, shadowMaterial)
  plane.matrixAutoUpdate = false
  planeShadow.matrixAutoUpdate = false
  plane.visible = false
  planeShadow.visible = false
  globe.add(planeShadow, plane)

  function applyTheme() {
    const palette = document.documentElement.classList.contains('dark')
      ? THEMES.dark
      : THEMES.light
    shared.uOcean.value.set(palette.ocean)
    shared.uOceanDeep.value.set(palette.oceanDeep)
    shared.uEasy.value.set(palette.easy)
    shared.uSpecial.value.set(palette.special)
    shared.uRequired.value.set(palette.required)
    shared.uBorder.value.set(palette.border)
    shared.uVisited.value.set(palette.visited)
    shared.uWall.value.set(palette.wall)
    shared.uAccent.value.set(palette.focus)
    haloMaterial.uniforms.uRim.value.set(palette.rim)
    haloMaterial.uniforms.uStrength.value = palette.rimStrength
    beadMaterial.color.set(palette.visited)
    homeMaterial.color.set(palette.focus)
    ringMaterial.color.set(palette.focus)
    arcMaterial.color.set(palette.focus)
    planeMaterial.color.set(palette.plane)
  }
  applyTheme()
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  })

  // Opens on the arc from Europe to East Asia, where most of the plates are.
  const start = facing(62, 24)
  const view = {
    yaw: start.yaw - (reducedMotion ? 0 : 0.9),
    pitch: start.pitch,
    velocity: 0,
    velocityPitch: 0,
    distance: REST_DISTANCE,
    targetDistance: REST_DISTANCE,
    target: reducedMotion
      ? undefined
      : (start as { yaw: number; pitch: number } | undefined),
    spin: !reducedMotion,
    base: reducedMotion ? 1 : 0,
    selected: 0,
    hovered: 0,
    arcProgress: 0,
    pointerAt: 0,
  }

  let selected: AtlasFeature | undefined
  let hovered: AtlasFeature | undefined

  function drawFocus() {
    focusContext!.globalCompositeOperation = 'source-over'
    focusContext!.fillStyle = '#000'
    focusContext!.fillRect(0, 0, 2048, 1024)
    focusContext!.globalCompositeOperation = 'lighter'
    const paint = (f: AtlasFeature | undefined, color: string) => {
      if (!f) return
      focusContext!.fillStyle = color
      focusContext!.strokeStyle = color
      focusContext!.lineWidth = f.radius < 0.03 ? 4 : 0.5
      focusContext!.beginPath()
      focusPath(f.geometry as GeoPermissibleObjects)
      focusContext!.fill()
      focusContext!.stroke()
    }
    paint(selected, '#f00')
    paint(hovered && hovered !== selected ? hovered : undefined, '#0f0')
    focus.needsUpdate = true
  }
  drawFocus()

  function select(name: string | undefined) {
    const next = name ? byName.get(name) : undefined
    selected = next
    for (const [f, bead] of beads) {
      bead.material = f === home || f === next ? homeMaterial : beadMaterial
    }
    view.spin = false
    view.velocity = 0
    view.velocityPitch = 0
    view.selected = 0
    view.arcProgress = reducedMotion ? 1 : 0
    drawFocus()
    if (arc) {
      globe.remove(arc)
      arc.geometry.dispose()
      arc = undefined
      curve = undefined
    }
    plane.visible = false
    planeShadow.visible = false
    if (!next) {
      view.targetDistance = REST_DISTANCE
      view.target = undefined
      if (!reducedMotion) view.spin = true
      return
    }
    const route = home && next !== home ? routeFraming(home, next) : undefined
    const center = route?.center ?? next.centroid
    view.target = facing(center[0], Math.max(-65, Math.min(65, center[1])))
    view.targetDistance = route?.distance ?? CLOSEST_DISTANCE
    if (home && next !== home) {
      const built = arcBetween(home, next)
      arc = new THREE.Mesh(built.geometry, arcMaterial)
      arc.geometry.setDrawRange(0, 0)
      globe.add(arc)
      curve = built.curve
      flightSeconds = 1.8 + built.angle * 1.5
      routeAngle = built.angle
      flightClock = 0
      plane.visible = true
      planeShadow.visible = true
    }
  }

  const raycaster = new THREE.Raycaster()
  const unitSphere = new THREE.Sphere(new THREE.Vector3(), 1)
  const hit = new THREE.Vector3()
  function featureAt(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect()
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1),
      ),
      camera,
    )
    if (!raycaster.ray.intersectSphere(unitSphere, hit)) return undefined
    const local = globe.worldToLocal(hit.clone())
    const lat = Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) / DEG
    const lon = Math.atan2(-local.z, local.x) / DEG
    return pickFeature(features, lon, lat)
  }

  let dragging = false
  let moved = 0
  let lastX = 0
  let lastY = 0
  let pendingHover: { x: number; y: number } | undefined

  function setHover(next: AtlasFeature | undefined, x: number, y: number) {
    if (next !== hovered) {
      hovered = next
      view.hovered = 0
      drawFocus()
      canvas.style.cursor = next ? 'pointer' : 'grab'
    }
    onHover?.(next, x, y)
  }

  function onPointerDown(event: PointerEvent) {
    dragging = true
    moved = 0
    lastX = event.clientX
    lastY = event.clientY
    view.velocity = 0
    view.velocityPitch = 0
    view.target = undefined
    canvas.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging) {
      if (event.pointerType === 'mouse')
        pendingHover = { x: event.clientX, y: event.clientY }
      return
    }
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    moved += Math.abs(dx) + Math.abs(dy)
    if (moved > 5) {
      view.spin = false
      canvas.style.cursor = 'grabbing'
      if (hovered) setHover(undefined, 0, 0)
    }
    const scale =
      (Math.PI / canvas.clientWidth) * (view.distance / REST_DISTANCE) * 1.15
    view.yaw += dx * scale
    // Touch keeps vertical drags for page scrolling via touch-action.
    if (event.pointerType === 'mouse') {
      view.pitch = THREE.MathUtils.clamp(view.pitch + dy * scale, -1.3, 1.3)
    }
    view.velocity = reducedMotion ? 0 : dx * scale
    view.velocityPitch =
      reducedMotion || event.pointerType !== 'mouse' ? 0 : dy * scale
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = hovered ? 'pointer' : 'grab'
    if (moved > 5) return
    const clicked = featureAt(event.clientX, event.clientY)
    if (!clicked && !selected) return
    onSelect?.(clicked)
    select(clicked?.name)
  }

  function onPointerLeave() {
    pendingHover = undefined
    if (!dragging) setHover(undefined, 0, 0)
  }

  function onPointerCancel() {
    dragging = false
  }

  if (!passive) {
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.style.cursor = 'grab'
  }

  const basisRight = new THREE.Vector3()
  const basisForward = new THREE.Vector3()
  const basisUp = new THREE.Vector3()
  const pose = new THREE.Matrix4()
  const planeScale = new THREE.Matrix4()

  /** Lays the silhouette tangent to the sphere, nose along the route. */
  function placePlane(t: number, size: number) {
    if (!curve) return
    const at = curve.getPointAt(t)
    const tangent = curve.getTangentAt(t)
    basisUp.copy(at).normalize()
    basisRight.crossVectors(tangent, basisUp).normalize()
    basisForward.crossVectors(basisUp, basisRight).normalize()
    pose.makeBasis(basisRight, basisForward, basisUp)
    planeScale.makeScale(size, size, size)
    pose.multiply(planeScale)
    pose.setPosition(at.clone().add(basisUp.clone().multiplyScalar(0.004)))
    plane.matrix.copy(pose)
    pose.setPosition(basisUp.clone().multiplyScalar(1.0035))
    planeShadow.matrix.copy(pose)
    plane.matrixWorldNeedsUpdate = true
    planeShadow.matrixWorldNeedsUpdate = true
  }

  const anchorPoint = new THREE.Vector3()
  const anchorNormal = new THREE.Vector3()
  function anchorFor(f: AtlasFeature): GlobeAnchor {
    return anchorAt(pointOn(f.centroid[0], f.centroid[1], 1 + BASE_HEIGHT))
  }
  function anchorAt(local: THREE.Vector3): GlobeAnchor {
    anchorPoint.copy(local)
    globe.localToWorld(anchorPoint)
    anchorNormal.copy(anchorPoint).normalize()
    const toCamera = camera.position.clone().sub(anchorPoint).normalize()
    const visible = anchorNormal.dot(toCamera) > 0.04
    anchorPoint.project(camera)
    return {
      x: ((anchorPoint.x + 1) / 2) * canvas.clientWidth,
      y: ((1 - anchorPoint.y) / 2) * canvas.clientHeight,
      visible,
    }
  }

  function resize() {
    const size = canvas.clientWidth
    if (!size) return
    renderer.setSize(size, canvas.clientHeight, false)
    camera.aspect = size / canvas.clientHeight
    camera.updateProjectionMatrix()
    // Keep stipple spacing visually steady across screen sizes.
    shared.uDot.value = THREE.MathUtils.clamp(
      560 / (size * renderer.getPixelRatio()) + 0.42,
      0.62,
      1.5,
    )
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  resize()

  let visible = true
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
  })
  intersection.observe(canvas)

  let frame = 0
  let last = performance.now()
  let elapsed = 0
  const ease = (rate: number, delta: number) => 1 - Math.exp(-rate * delta)

  function tick(now: number) {
    frame = requestAnimationFrame(tick)
    const delta = Math.min((now - last) / 1000, 0.05)
    last = now
    if (!visible || document.hidden) return
    elapsed += delta

    if (pendingHover) {
      const { x, y } = pendingHover
      pendingHover = undefined
      setHover(featureAt(x, y), x, y)
    }

    if (view.target) {
      const yawGoal = shortestAngle(view.yaw, view.target.yaw)
      const k = reducedMotion ? 1 : ease(3.2, delta)
      view.yaw += (yawGoal - view.yaw) * k
      view.pitch += (view.target.pitch - view.pitch) * k
      if (
        Math.abs(yawGoal - view.yaw) < 0.001 &&
        Math.abs(view.target.pitch - view.pitch) < 0.001
      ) {
        view.target = undefined
      }
    } else if (!dragging) {
      if (view.spin && !hovered) view.yaw += delta * 0.055
      view.yaw += view.velocity
      view.pitch = THREE.MathUtils.clamp(
        view.pitch + view.velocityPitch,
        -1.3,
        1.3,
      )
      view.velocity *= Math.exp(-3.4 * delta)
      view.velocityPitch *= Math.exp(-3.4 * delta)
    }
    view.distance +=
      (view.targetDistance - view.distance) *
      (reducedMotion ? 1 : ease(2.8, delta))
    camera.position.z = view.distance
    globe.rotation.set(view.pitch, view.yaw, 0)

    const riseRate = reducedMotion ? 1 : ease(6, delta)
    view.base += (1 - view.base) * (reducedMotion ? 1 : ease(1.6, delta))
    view.selected += (1 - view.selected) * riseRate
    view.hovered += (1 - view.hovered) * riseRate
    shared.uBase.value = BASE_HEIGHT * view.base
    shared.uSelected.value = SHELL_TOP * view.selected
    shared.uHovered.value = (BASE_HEIGHT + 0.009) * view.hovered

    if (arc) {
      view.arcProgress = Math.min(1, view.arcProgress + delta * 0.9)
      const eased = 1 - (1 - view.arcProgress) ** 3
      const index = arc.geometry.index
      const total = index ? index.count : arc.geometry.attributes.position.count
      arc.geometry.setDrawRange(0, Math.floor(total * eased))
    }

    if (curve) {
      // One flight, a beat on the ground, then round again. Parked mid-route if motion is off.
      // Never longer than a short route, so a hop to Kuala Lumpur still reads as a hop.
      const size = Math.max(
        0.012,
        Math.min(0.04 * (view.distance / REST_DISTANCE), routeAngle * 0.3),
      )
      if (reducedMotion) {
        placePlane(0.5, size)
      } else {
        flightClock = (flightClock + delta) % (flightSeconds + 1.1)
        const raw = Math.min(flightClock / flightSeconds, 1)
        const flown = raw * raw * (3 - 2 * raw)
        const grounded = Math.min(raw / 0.06, (1 - raw) / 0.06, 1)
        placePlane(flown, Math.max(size * grounded, 0.0001))
      }
    }

    const pulse = reducedMotion ? 0.5 : (elapsed * 0.45) % 1
    ring.scale.setScalar(0.012 + pulse * 0.032)
    ringMaterial.opacity = 0.85 * (1 - pulse)

    renderer.render(scene, camera)
    if (onAnchors) {
      globe.updateMatrixWorld()
      onAnchors(
        selected
          ? {
              home: home && selected !== home ? anchorFor(home) : undefined,
              selected: anchorFor(selected),
              midpoint: curve ? anchorAt(curve.getPointAt(0.5)) : undefined,
            }
          : {},
      )
    }
  }
  frame = requestAnimationFrame(tick)

  return {
    select,
    dispose() {
      cancelAnimationFrame(frame)
      themeObserver.disconnect()
      resizeObserver.disconnect()
      intersection.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      arc?.geometry.dispose()
      for (const item of [
        geometry,
        haloGeometry,
        beadGeometry,
        ringGeometry,
        planeShape,
      ])
        item.dispose()
      for (const item of [
        surface,
        haloMaterial,
        beadMaterial,
        homeMaterial,
        ringMaterial,
        arcMaterial,
        planeMaterial,
        shadowMaterial,
        ...plates,
      ]) {
        item.dispose()
      }
      mask.dispose()
      classTexture.dispose()
      focus.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}
